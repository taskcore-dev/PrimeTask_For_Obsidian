import { App, Modal, Notice, Setting } from 'obsidian';
import type PrimeTaskPlugin from '../main';
import { signAuthRequest } from '../api/signing';

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Shows the user a nonce to verify in PrimeTask, then polls the Plugin API
 * until the user approves or denies the request (or it expires).
 */
export class AuthorizeModal extends Modal {
  private plugin: PrimeTaskPlugin;
  private nonce: string;
  private requestId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollStartedAt = 0;
  private statusEl: HTMLElement | null = null;

  constructor(app: App, plugin: PrimeTaskPlugin) {
    super(app);
    this.plugin = plugin;
    this.nonce = this.generateNonce();
  }

  private generateNonce(): string {
    // Short human-readable nonce (6 chars) for visual verification.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('primetask-authorize-modal');

    contentEl.createEl('h2', { text: 'Connect to PrimeTask' });

    const intro = contentEl.createEl('p');
    intro.setText(
      'A one-time authorization pairs this vault with the PrimeTask desktop app. Nothing leaves your machine.',
    );

    // Nonce display — user compares this against the PrimeTask modal.
    const nonceWrap = contentEl.createDiv({ cls: 'primetask-authorize-nonce' });
    nonceWrap.createEl('div', { text: 'Verify this code in PrimeTask', cls: 'primetask-authorize-nonce-label' });
    nonceWrap.createEl('div', { text: this.nonce, cls: 'primetask-authorize-nonce-code' });

    const steps = contentEl.createEl('ol', { cls: 'primetask-authorize-steps' });
    steps.createEl('li', { text: 'PrimeTask will show an authorization dialog.' });
    steps.createEl('li', { text: 'Check that the code above matches what PrimeTask is showing.' });
    steps.createEl('li', { text: 'Click Allow in PrimeTask.' });

    this.statusEl = contentEl.createDiv({ cls: 'primetask-authorize-status' });
    this.updateStatus('Sending authorization request…');

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => {
          this.close();
        }),
      );

    this.startAuthFlow().catch((err) => {
      this.updateStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    });
  }

  onClose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.contentEl.empty();
  }

  private async startAuthFlow(): Promise<void> {
    const client = this.plugin.connection.getClient();
    const pluginId = this.plugin.manifest.id;
    const signedAt = new Date().toISOString();
    // Sign the auth request with the plugin's bundled ED25519 private key
    // (if this build has one). PrimeTask's desktop app verifies with the
    // matching public key to show the "Trusted integration" badge in the
    // consent modal. Unsigned builds (forks) land in "Unknown source".
    const signature = signAuthRequest(pluginId, this.nonce, signedAt);
    const response = await client.requestAuth({
      pluginId,
      // Explicit "for Obsidian" so in PrimeTask's Connected Plugins list the user
      // can distinguish this from the product itself (same `PrimeTask` name).
      pluginName: 'PrimeTask for Obsidian',
      nonce: this.nonce,
      signature: signature ?? undefined,
      signedAt: signature ? signedAt : undefined,
    });
    this.requestId = response.requestId;
    this.pollStartedAt = Date.now();
    this.updateStatus('Waiting for approval in PrimeTask…');
    this.pollTimer = setInterval(() => this.pollOnce().catch(() => {}), POLL_INTERVAL_MS);
  }

  private async pollOnce(): Promise<void> {
    if (!this.requestId) return;
    if (Date.now() - this.pollStartedAt > POLL_TIMEOUT_MS) {
      this.updateStatus('Request expired. Close this dialog and try again.', 'error');
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      return;
    }

    const client = this.plugin.connection.getClient();
    const res = await client.pollAuth(this.requestId);

    if (res.status === 'approved' && res.token) {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      await this.plugin.finishAuthorization(res.token);
      this.updateStatus('Connected! You can close this dialog.', 'success');
      new Notice('PrimeTask plugin authorized');
      setTimeout(() => this.close(), 500);
      return;
    }

    if (res.status === 'denied') {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      this.updateStatus('Request denied in PrimeTask.', 'error');
      return;
    }

    if (res.status === 'expired') {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      this.updateStatus('Request expired. Close this dialog and try again.', 'error');
      return;
    }
  }

  private updateStatus(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    if (!this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.removeClass(
      'primetask-authorize-status-info',
      'primetask-authorize-status-success',
      'primetask-authorize-status-error',
    );
    this.statusEl.addClass(`primetask-authorize-status-${kind}`);
    this.statusEl.setText(message);
  }
}
