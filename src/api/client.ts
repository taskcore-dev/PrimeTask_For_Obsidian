/**
 * HTTP client for the PrimeTask Plugin API.
 *
 * Covers the unauthenticated ping + auth-request / poll flow, then
 * authenticated endpoints for spaces, tasks, projects, statuses, and
 * priorities. All traffic goes to `127.0.0.1` on the port reported by
 * the local `/ping` discovery response.
 */

export interface PingResponse {
  status: 'ok';
  product: 'primetask';
  version: string;
  apiVersion: 'v1';
  phase: string;
}

export interface AuthRequestResponse {
  requestId: string;
  expiresIn: number;
}

export type AuthPollStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface AuthPollResponse {
  status: AuthPollStatus;
  token?: string;
}

export interface PrimeTaskSpace {
  id: string;
  name: string;
  color: string | null;
  isShared: boolean;
  isActive?: boolean;
}

export interface PrimeTaskTag {
  id: string;
  name: string;
  color: string | null;
}

export interface PrimeTaskTask {
  id: string;
  name: string;
  status: string;
  priority: string;
  dueDate: string | null;
  completionPercentage: number;
  projectId: string | null;
  parentId: string | null;
  subtaskCount: number;
  subtasks: PrimeTaskTask[];
  tags: PrimeTaskTag[];
  /**
   * PrimeTask stores description as Tiptap HTML. The plugin strips tags
   * before displaying and sends plain-text edits back. Empty string when
   * the task has no description set.
   */
  description?: string;
}

export interface PrimeTaskProject {
  id: string;
  name: string;
  color: string | null;
  status: string;
  description: string | null;
  taskCount: number;
  completedCount: number;
  overdueCount: number;
  /** Simple `completed_count / task_count` ratio. Task-only; doesn't
   *  factor in milestones or goals. Diverges from the app's project
   *  dashboard when either exists. Use `overallProgress` for the
   *  authoritative value. */
  progress: number;
  /** Authoritative project progress — matches what the PrimeTask app's
   *  project dashboard shows. Combines task completion + milestone
   *  progress + goal progress via the shared health engine. */
  overallProgress: number;
  /** `'on_track' | 'at_risk' | 'behind' | 'critical' | 'completed'` — null if the calculator failed. */
  health: string | null;
  deadline: string | null;
  startDate: string | null;
  isArchived: boolean;
}

export interface PrimeTaskStatus {
  id: string;
  name: string;
  color: string | null;
  category: string;
  order: number;
  is_default?: boolean;
  is_complete?: boolean;
}

export interface PrimeTaskPriority {
  id: string;
  name: string;
  color: string | null;
  level?: number;
  order: number;
  is_default?: boolean;
}

export interface ProjectCreateInput {
  name: string;
  description?: string;
  status?: string;
  deadline?: string;
  startDate?: string;
  spaceId?: string;
}

export interface TaskCreateInput {
  name: string;
  projectId?: string | null;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  description?: string;
  parentId?: string;
  /**
   * Locked space id. When set, the desktop app verifies this matches its
   * currently active space; otherwise it returns 409 `space_mismatch` so the
   * plugin can refuse the write rather than silently writing into the wrong
   * space.
   */
  spaceId?: string;
}

export interface TaskUpdateInput {
  name?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  projectId?: string | null;
  description?: string;
  completionPercentage?: number;
  spaceId?: string;
}

/**
 * Thrown when the desktop app rejects a read/write because it would have
 * crossed into a non-active space. The plugin treats this as "skip this op,
 * surface a friendly notice" rather than a generic failure.
 */
export class SpaceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceMismatchError';
  }
}

export interface MeResponse {
  pluginId: string;
  pluginName: string;
  issuedAt: string | null;
}

export class PrimeTaskClient {
  private baseUrl: string;
  private token: string | null = null;
  private onUnauthorized?: () => void;
  private onForbidden?: () => void;

  constructor(port: number = 41573, token: string | null = null) {
    this.baseUrl = `http://127.0.0.1:${port}/api/v1`;
    this.token = token;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  /**
   * Callback fired when ANY request gets 401 Unauthorized — the bearer
   * token is no longer valid, typically because the user revoked the
   * plugin from PrimeTask's Connected Plugins settings. The connection
   * manager wires this up to clear local token state so the sidebar
   * immediately reflects the revocation instead of waiting for the next
   * ping cycle (or continuing to show "Connected" forever).
   */
  setOnUnauthorized(cb: () => void): void {
    this.onUnauthorized = cb;
  }

  /**
   * Callback fired when ANY request gets 403 Forbidden with the
   * `plugin_disabled` error — the token is still valid but the user has
   * paused this plugin specifically via the Connected Plugins toggle.
   * Handled distinctly from 401: the token is NOT cleared, so re-enabling
   * from PrimeTask resumes the session without the user re-authorizing.
   */
  setOnForbidden(cb: () => void): void {
    this.onForbidden = cb;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 2500,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (init.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }

      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 409 + `space_mismatch` is a structured signal that the locked space
        // doesn't match the desktop app's active space. Bubble it up as a
        // typed error so callers can show a friendly notice instead of crash.
        if (res.status === 409) {
          try {
            const parsed = JSON.parse(text);
            if (parsed?.error === 'space_mismatch') {
              throw new SpaceMismatchError(parsed.message || 'Space mismatch');
            }
          } catch (e) {
            if (e instanceof SpaceMismatchError) throw e;
          }
        }
        // 401 = bearer token invalidated server-side. Notify the connection
        // manager synchronously so the UI flips to needs-auth before the
        // caller even sees the exception.
        if (res.status === 401) {
          try { this.onUnauthorized?.(); } catch { /* best effort */ }
        }
        // 403 with `plugin_disabled` = user paused this plugin from
        // Connected Plugins. Token stays valid; just flip the UI to a
        // paused state so the sidebar stops hammering the server.
        if (res.status === 403) {
          try {
            const parsed = JSON.parse(text);
            if (parsed?.error === 'plugin_disabled') {
              try { this.onForbidden?.(); } catch { /* best effort */ }
            }
          } catch { /* non-JSON body, leave as generic 403 */ }
        }
        throw new Error(`Plugin API ${path} ${res.status}: ${text || res.statusText}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Public endpoints ---

  async ping(): Promise<PingResponse> {
    return this.request<PingResponse>('/ping');
  }

  async requestAuth(params: {
    pluginId: string;
    pluginName: string;
    nonce: string;
    /**
     * ED25519 signature of `${pluginId}|${nonce}|${signedAt}` produced
     * by the plugin's bundled private key. The desktop app verifies it
     * with the matching public key to show the "Trusted integration"
     * badge. Omitted entirely when the build has no signing key (fork
     * builds), in which case the app treats the plugin as third-party.
     */
    signature?: string;
    /** ISO 8601 timestamp covered by the signature. Server rejects anything older than 5 minutes. */
    signedAt?: string;
  }): Promise<AuthRequestResponse> {
    return this.request<AuthRequestResponse>('/auth/request', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async pollAuth(requestId: string): Promise<AuthPollResponse> {
    return this.request<AuthPollResponse>(
      `/auth/poll?requestId=${encodeURIComponent(requestId)}`,
    );
  }

  // --- Authenticated endpoints ---

  async me(): Promise<MeResponse> {
    return this.request<MeResponse>('/me');
  }

  async listSpaces(): Promise<PrimeTaskSpace[]> {
    const res = await this.request<{ spaces: PrimeTaskSpace[] }>('/spaces');
    return res.spaces;
  }

  async listTasks(params: { projectId?: string; status?: string; spaceId?: string } = {}): Promise<PrimeTaskTask[]> {
    const qs = new URLSearchParams();
    if (params.projectId) qs.set('projectId', params.projectId);
    if (params.status) qs.set('status', params.status);
    if (params.spaceId) qs.set('spaceId', params.spaceId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await this.request<{ tasks: PrimeTaskTask[] }>(`/tasks${suffix}`);
    return res.tasks;
  }

  async listProjects(params: { spaceId?: string } = {}): Promise<PrimeTaskProject[]> {
    const qs = new URLSearchParams();
    if (params.spaceId) qs.set('spaceId', params.spaceId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await this.request<{ projects: PrimeTaskProject[] }>(`/projects${suffix}`);
    return res.projects;
  }

  async listStatuses(params: { spaceId?: string } = {}): Promise<PrimeTaskStatus[]> {
    const qs = new URLSearchParams();
    if (params.spaceId) qs.set('spaceId', params.spaceId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await this.request<{ statuses: PrimeTaskStatus[] }>(`/statuses${suffix}`);
    return res.statuses;
  }

  async listPriorities(params: { spaceId?: string } = {}): Promise<PrimeTaskPriority[]> {
    const qs = new URLSearchParams();
    if (params.spaceId) qs.set('spaceId', params.spaceId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await this.request<{ priorities: PrimeTaskPriority[] }>(`/priorities${suffix}`);
    return res.priorities;
  }

  async createTask(input: TaskCreateInput): Promise<unknown> {
    const res = await this.request<{ task: unknown }>('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return res.task;
  }

  async createProject(input: ProjectCreateInput): Promise<{ id: string; name: string }> {
    const res = await this.request<{ project: { id: string; name: string } }>('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return res.project;
  }

  async updateTask(taskId: string, input: TaskUpdateInput): Promise<unknown> {
    const res = await this.request<{ task: unknown }>(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    return res.task;
  }

  async deleteTask(taskId: string, opts: { spaceId?: string } = {}): Promise<void> {
    const qs = new URLSearchParams();
    if (opts.spaceId) qs.set('spaceId', opts.spaceId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    await this.request(`/tasks/${encodeURIComponent(taskId)}${suffix}`, { method: 'DELETE' });
  }
}
