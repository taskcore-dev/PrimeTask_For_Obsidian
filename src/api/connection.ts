import { LockedError, PrimeTaskClient, type PingResponse } from './client';

export type ConnectionStatus =
  | 'disabled'       // user turned sync off
  | 'needs-auth'     // reachable but no token yet
  | 'disconnected'   // unreachable or error
  | 'connecting'
  | 'connected'
  | 'paused'         // token valid but plugin disabled from PrimeTask side
  | 'locked'         // PrimeTask is on its lock/PIN screen — port reachable, data refused
  | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  lastPingAt: number | null;
  lastError: string | null;
  serverVersion: string | null;
  serverPhase: string | null;
  port: number;
  authorized: boolean;
}

type Listener = (state: ConnectionState) => void;

export class ConnectionManager {
  private state: ConnectionState;
  private client: PrimeTaskClient;
  private listeners = new Set<Listener>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;

  /**
   * Optional hook fired when the server rejects our bearer token (401).
   * Plugin wires this up to clear the persisted token from settings so
   * the revocation survives a reload. Internal token clearing + state
   * update happen regardless — this is only for persistence cleanup.
   */
  private onUnauthorizedListener: (() => void) | null = null;

  constructor(port: number = 41573, token: string | null = null, pollIntervalMs = 10_000) {
    this.state = {
      status: 'disconnected',
      lastPingAt: null,
      lastError: null,
      serverVersion: null,
      serverPhase: null,
      port,
      authorized: !!token,
    };
    this.client = new PrimeTaskClient(port, token);
    // Wire 401 detection from any call through to our state handler.
    // Without this the sidebar would keep showing "Connected" after a
    // server-side revoke until the user reloaded the plugin.
    this.client.setOnUnauthorized(() => this.handleTokenInvalidated());
    // 403 plugin_disabled — token still valid, user paused this plugin
    // specifically. Flip to 'paused' until the next authenticated probe
    // succeeds (see pingOnce).
    this.client.setOnForbidden(() => this.handlePluginPaused());
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Call when the plugin wants to be notified that the server revoked
   * our token. Used for persistent cleanup (clear settings.bearerToken).
   */
  setOnUnauthorized(cb: () => void): void {
    this.onUnauthorizedListener = cb;
  }

  private handleTokenInvalidated(): void {
    // Already cleared? Avoid re-firing the listener.
    if (!this.state.authorized) return;
    this.client.setToken(null);
    this.update({
      status: 'needs-auth',
      authorized: false,
      lastError: 'PrimeTask revoked this plugin',
    });
    try { this.onUnauthorizedListener?.(); } catch { /* best effort */ }
  }

  private handlePluginPaused(): void {
    // Already paused? Don't re-fire to avoid duplicate logs.
    if (this.state.status === 'paused') return;
    this.update({
      status: 'paused',
      lastError: 'Paused from PrimeTask — re-enable in Settings → External Integrations → Connected Plugins.',
    });
  }

  getState(): ConnectionState {
    return { ...this.state };
  }

  getClient(): PrimeTaskClient {
    return this.client;
  }

  setToken(token: string | null): void {
    this.client.setToken(token);
    this.update({ authorized: !!token });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.pingOnce();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.pingOnce().catch(() => {});
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async disable(): Promise<void> {
    await this.stop();
    this.update({
      status: 'disabled',
      lastError: null,
      serverVersion: null,
      serverPhase: null,
    });
  }

  async pingOnce(): Promise<PingResponse | null> {
    // Only emit the transient 'connecting' status from 'disconnected' or
    // 'error' — otherwise every poll would flip a steady-state
    // 'connected' → 'connecting' → 'connected' and thrash any UI that
    // redraws on state change (settings panel, status bar). 'paused' and
    // 'locked' are also preserved through ping so the UI doesn't flicker
    // to connected between probes.
    if (
      this.state.status !== 'connected' &&
      this.state.status !== 'needs-auth' &&
      this.state.status !== 'paused' &&
      this.state.status !== 'locked'
    ) {
      this.update({ status: 'connecting' });
    }
    try {
      const res = await this.client.ping();
      // Ping is intentionally unauthenticated: any transient 401 from
      // a token check here would produce false-positive revocations on
      // server restart or brief races. Real revocations are caught by
      // the authenticated sidebar polls (listTasks / listProjects)
      // which trip onUnauthorized within one cycle.
      //
      // /ping always responds even when the desktop app is locked. Detect
      // that here and surface a clear "PrimeTask is locked" status —
      // distinct from "offline" so users know to unlock the app rather
      // than restart it.
      if (res.locked || res.status === 'locked') {
        this.update({
          status: 'locked',
          lastPingAt: Date.now(),
          lastError: 'PrimeTask is locked. Unlock the app to resume sync.',
          serverVersion: res.version,
          serverPhase: res.phase,
        });
        return res;
      }
      //
      // When 'paused', probe /me (authenticated) to detect re-enable
      // from PrimeTask's Connected Plugins toggle. /me → 200 means the
      // pause has been lifted; → 403 leaves us paused; onForbidden
      // fires from inside request() either way.
      if (this.state.status === 'paused' && this.state.authorized) {
        try {
          await this.client.me();
          // Success: pause is lifted.
          this.update({
            status: 'connected',
            lastPingAt: Date.now(),
            lastError: null,
            serverVersion: res.version,
            serverPhase: res.phase,
          });
          return res;
        } catch {
          // Still paused (403) or other error. Stay paused but refresh
          // the lastPingAt so the UI knows we're alive.
          this.update({ lastPingAt: Date.now(), serverVersion: res.version, serverPhase: res.phase });
          return res;
        }
      }
      this.update({
        status: this.state.authorized ? 'connected' : 'needs-auth',
        lastPingAt: Date.now(),
        lastError: null,
        serverVersion: res.version,
        serverPhase: res.phase,
      });
      return res;
    } catch (err) {
      // 423 from any subsequent request also means locked. Treat the same
      // as a `locked: true` ping so the UI converges quickly even if a
      // data poll races ahead of the next /ping cycle.
      if (err instanceof LockedError) {
        this.update({
          status: 'locked',
          lastPingAt: Date.now(),
          lastError: err.message,
        });
        return null;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.update({
        status: 'disconnected',
        lastError: message,
      });
      return null;
    }
  }

  private update(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.getState());
  }
}
