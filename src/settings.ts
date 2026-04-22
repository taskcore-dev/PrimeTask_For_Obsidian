import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type PrimeTaskPlugin from './main';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export type ContactFileStrategy = 'aggregate' | 'per-file' | 'smart';
export type CompanyFileStrategy = 'per-file' | 'aggregate';

export interface PrimeTaskSettings {
  syncEnabled: boolean;
  showStatusBar: boolean;
  port: 'auto' | number;
  bearerToken: string | null;
  defaultSpaceId: string | null;
  defaultProjectId: string | null;
  syncTasks: boolean;
  syncProjects: boolean;
  syncCRM: boolean;
  enableFileFallback: boolean;
  fallbackVaultFolder: string;
  // Markdown mirror
  mirrorEnabled: boolean;
  mirrorFolder: string;
  mirrorProjects: boolean;
  mirrorMilestones: boolean;
  mirrorGoals: boolean;
  mirrorContacts: boolean;
  mirrorCompanies: boolean;
  mirrorActivities: boolean;
  mirrorContactStrategy: ContactFileStrategy;
  mirrorCompanyStrategy: CompanyFileStrategy;
  mirrorRenameFiles: boolean;
  logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: PrimeTaskSettings = {
  syncEnabled: true,
  showStatusBar: true,
  port: 'auto',
  bearerToken: null,
  defaultSpaceId: null,
  defaultProjectId: null,
  syncTasks: true,
  syncProjects: true,
  syncCRM: false,
  enableFileFallback: true,
  fallbackVaultFolder: 'PrimeTask',
  // Markdown mirror — off by default. User explicitly opts in.
  mirrorEnabled: false,
  mirrorFolder: 'PrimeTask',
  mirrorProjects: true,
  mirrorMilestones: true,
  mirrorGoals: true,
  mirrorContacts: false,
  mirrorCompanies: false,
  mirrorActivities: false,
  mirrorContactStrategy: 'smart',
  mirrorCompanyStrategy: 'per-file',
  mirrorRenameFiles: false,
  logLevel: 'warn',
};

export class PrimeTaskSettingTab extends PluginSettingTab {
  plugin: PrimeTaskPlugin;
  /** Live-state listeners cleaned up on hide(). Settings page re-renders
   *  in response to connection-state flips (authorize, revoke, disable
   *  etc) so it never shows stale status. */
  private disposers: Array<() => void> = [];

  constructor(app: App, plugin: PrimeTaskPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('primetask-settings');

    this.renderHeader();
    this.renderConnectionSection();
    this.renderSyncSection();
    this.renderFallbackSection();
    this.renderMirrorSection();
    this.renderAdvancedSection();
    this.renderFooter();

    // Auto-redraw when connection state changes (authorize / revoke /
    // disable / reconnect) so the page never shows stale status. Previous
    // behaviour required the user to click Test Connection after
    // authorising, which felt broken even though it wasn't.
    this.attachLiveListeners();
  }

  hide(): void {
    for (const dispose of this.disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
    this.disposers = [];
  }

  private attachLiveListeners(): void {
    // Clear any leftover listeners from a previous display() call before
    // subscribing fresh, in case Obsidian re-renders the tab without an
    // intervening hide().
    for (const dispose of this.disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
    this.disposers = [];

    // Fingerprint of the state fields the UI actually reads. The
    // connection manager fires subscribe on EVERY ping (every 10s) with
    // lastPingAt updated, but redrawing for that causes constant flicker.
    // Only redraw when something visible changes.
    const makeFingerprint = () => {
      const s = this.plugin.connection.getState();
      return `${s.status}|${s.serverVersion ?? ''}|${s.serverPhase ?? ''}|${s.lastError ?? ''}|${s.authorized}|${s.port}|${this.plugin.settings.syncEnabled}|${!!this.plugin.settings.bearerToken}`;
    };
    let lastFingerprint = makeFingerprint();

    let redrawTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRedraw = () => {
      const fp = makeFingerprint();
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      if (redrawTimer) clearTimeout(redrawTimer);
      redrawTimer = setTimeout(() => {
        redrawTimer = null;
        this.display();
      }, 80);
    };

    const unsubConn = this.plugin.connection.subscribe(() => scheduleRedraw());
    this.disposers.push(unsubConn);

    this.disposers.push(() => {
      if (redrawTimer) clearTimeout(redrawTimer);
    });
  }

  // ------------------------------------------------------------------
  // Header — logo, tagline, status chip, external links
  // ------------------------------------------------------------------
  private renderHeader(): void {
    const { containerEl } = this;
    const header = containerEl.createDiv({ cls: 'primetask-settings-header' });

    const logoPath = `${this.plugin.manifest.dir ?? ''}/public/Logo/Primetask_logo.png`;
    try {
      const src = this.plugin.app.vault.adapter.getResourcePath(logoPath);
      header.createEl('img', {
        cls: 'primetask-settings-logo',
        attr: { src, alt: 'PrimeTask', draggable: 'false' },
      });
    } catch {
      // If the logo can't be loaded (e.g. non-desktop adapter), fall back to a wordmark.
      header.createEl('h1', { cls: 'primetask-settings-wordmark', text: 'PrimeTask' });
    }

    header.createEl('p', {
      cls: 'primetask-settings-tagline',
      text: 'Your tasks, projects, and planning. One connected workspace. Runs locally, yours forever.',
    });

    // Status chip (live)
    const state = this.plugin.connection.getState();
    const chip = header.createDiv({ cls: 'primetask-settings-statuschip' });
    const dot = chip.createSpan({ cls: 'primetask-status-dot' });
    dot.addClass(`primetask-status-${state.status}`);
    const chipLabel =
      state.status === 'disabled'
        ? 'Sync off'
        : state.status === 'paused'
        ? 'Paused in PrimeTask'
        : state.status === 'connected'
        ? `Connected · v${state.serverVersion ?? ''}`
        : state.status === 'connecting'
        ? 'Connecting…'
        : 'Offline';
    chip.createSpan({ cls: 'primetask-settings-statuschip-label', text: chipLabel });

    // Meta row
    const meta = header.createDiv({ cls: 'primetask-settings-meta' });
    meta.createSpan({ text: `v${this.plugin.manifest.version}` });
    meta.createSpan({ cls: 'primetask-settings-meta-dot', text: '·' });
    const website = meta.createEl('a', {
      text: 'primetask.app',
      attr: { href: 'https://primetask.app', target: '_blank', rel: 'noopener' },
    });
    website.addClass('primetask-settings-meta-link');
    meta.createSpan({ cls: 'primetask-settings-meta-dot', text: '·' });
    const docs = meta.createEl('a', {
      text: 'Documentation',
      attr: { href: 'https://primetask.app/docs', target: '_blank', rel: 'noopener' },
    });
    docs.addClass('primetask-settings-meta-link');
    meta.createSpan({ cls: 'primetask-settings-meta-dot', text: '·' });
    const issues = meta.createEl('a', {
      text: 'Support',
      attr: {
        href: 'https://github.com/PrimeTask/obsidian-primetask/issues',
        target: '_blank',
        rel: 'noopener',
      },
    });
    issues.addClass('primetask-settings-meta-link');
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------
  private renderConnectionSection(): void {
    const { containerEl } = this;
    this.sectionHeader('Connection', 'Local link between this vault and the PrimeTask desktop app. All traffic stays on this device.');

    // Master enable toggle.
    new Setting(containerEl)
      .setName('Enable sync')
      .setDesc('Master switch. When off, the plugin pauses all syncing and network activity.')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.syncEnabled).onChange(async (value) => {
          this.plugin.settings.syncEnabled = value;
          await this.plugin.saveSettings();
          if (value) {
            await this.plugin.connection.start().catch(() => {});
            new Notice('PrimeTask sync enabled');
          } else {
            await this.plugin.connection.disable();
            new Notice('PrimeTask sync paused');
          }
          this.display();
        });
      });

    // Status bar visibility toggle.
    new Setting(containerEl)
      .setName('Show status indicator')
      .setDesc('Show the PrimeTask connection dot in the status bar (bottom-right). Hide if you prefer a minimal status bar.')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
          this.plugin.settings.showStatusBar = value;
          await this.plugin.saveSettings();
          this.plugin.applyStatusBarVisibility();
        });
      });

    const state = this.plugin.connection.getState();
    const syncOn = this.plugin.settings.syncEnabled;
    const authorized = !!this.plugin.settings.bearerToken;
    const statusLabel = !syncOn
      ? 'Sync off'
      : state.status === 'paused'
      ? 'Paused in PrimeTask · re-enable in External Integrations → Connected Plugins'
      : state.status === 'connected'
      ? `Connected · v${state.serverVersion ?? ''}`
      : state.status === 'needs-auth'
      ? 'Reachable · awaiting authorization'
      : state.status === 'connecting'
      ? 'Connecting…'
      : state.lastError
      ? `Offline · ${state.lastError}`
      : 'Offline';

    new Setting(containerEl)
      .setName('Status')
      .setDesc(`Port ${state.port}. The desktop app must be running on this machine.`)
      .addText((text) => {
        text.setValue(statusLabel).setDisabled(true);
      })
      .addButton((btn) => {
        btn
          .setButtonText('Test connection')
          .setDisabled(!syncOn)
          .onClick(async () => {
            // Don't call this.display() here. The connection subscriber
            // already triggers a fingerprint-aware redraw when (and only
            // when) the state actually changes. Calling display()
            // unconditionally caused rapid repeat clicks to re-mount the
            // whole settings tree on every click → visible flicker.
            const res = await this.plugin.connection.pingOnce();
            if (res) new Notice(`Reachable · v${res.version}`);
            else new Notice('Offline. PrimeTask is not running or unreachable.');
          });
      });

    // Authorization row — primary action changes based on state.
    new Setting(containerEl)
      .setName('Authorization')
      .setDesc(
        authorized
          ? 'This vault is authorized to talk to PrimeTask. You can revoke it any time (or revoke from PrimeTask settings).'
          : 'Grant PrimeTask permission to sync this vault. You will approve the connection inside the PrimeTask desktop app.',
      )
      .addButton((btn) => {
        if (authorized) {
          btn
            .setButtonText('Revoke on this device')
            .setWarning()
            .setDisabled(!syncOn)
            .onClick(async () => {
              await this.plugin.revokeAuthorization();
              this.display();
            });
        } else {
          btn
            .setButtonText('Authorize…')
            .setDisabled(!syncOn || state.status === 'disconnected' || state.status === 'error')
            .onClick(() => {
              this.plugin.openAuthorizeModal();
            });
        }
      });
  }

  // ------------------------------------------------------------------
  // Sync preferences
  // ------------------------------------------------------------------
  private renderSyncSection(): void {
    const { containerEl } = this;
    this.sectionHeader('Sync preferences', 'Pick what syncs between Obsidian and PrimeTask and where new items land.');

    const authorized = !!this.plugin.settings.bearerToken;
    const connected = this.plugin.connection.getState().status === 'connected';
    const spaces = this.plugin.spaces;

    new Setting(containerEl)
      .setName('Locked space')
      .setDesc(
        connected
          ? 'Obsidian only ever reads and writes to this space, regardless of which space is currently active in the PrimeTask app. Switch space freely in PrimeTask — Obsidian stays put. Required for the markdown mirror to run.'
          : authorized
          ? 'Spaces will load once PrimeTask is reachable.'
          : 'Authorize the plugin first to load your spaces.',
      )
      .addDropdown((dd) => {
        if (spaces.length === 0) {
          dd.addOption('', 'No space selected');
        } else {
          dd.addOption('', 'No space selected');
          for (const s of spaces) {
            dd.addOption(s.id, s.name);
          }
        }
        dd.setValue(this.plugin.settings.defaultSpaceId ?? '');
        dd.setDisabled(!connected || spaces.length === 0);
        dd.onChange(async (value) => {
          this.plugin.settings.defaultSpaceId = value || null;
          await this.plugin.saveSettings();
          // Locking a different space should rebuild the mirror so the new
          // space's data shows up immediately and stale files from the old
          // lock get refreshed.
          if (this.plugin.settings.mirrorEnabled && value) {
            await this.plugin.applyMirrorState();
          }
          this.display();
        });
      })
      .addButton((btn) => {
        btn
          .setButtonText('Refresh')
          .setDisabled(!connected)
          .onClick(async () => {
            const count = (await this.plugin.refreshSpaces()).length;
            new Notice(`Loaded ${count} space${count === 1 ? '' : 's'}`);
            this.display();
          });
      });

    if (this.plugin.settings.mirrorEnabled && !this.plugin.settings.defaultSpaceId) {
      const warn = containerEl.createDiv({ cls: 'primetask-settings-warn' });
      warn.setText(
        'Markdown mirror is enabled but no locked space is selected. The mirror will not sync until you pick a space above.',
      );
    }

    new Setting(containerEl)
      .setName('Sync tasks')
      .setDesc('Keep tasks in sync bidirectionally.')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.syncTasks).onChange(async (value) => {
          this.plugin.settings.syncTasks = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Sync projects')
      .setDesc('Keep project status and metadata in sync.')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.syncProjects).onChange(async (value) => {
          this.plugin.settings.syncProjects = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Sync CRM')
      .setDesc('Coming soon. Contacts, companies, and activities will sync once CRM mirroring ships. Requires PrimeTask Pro when enabled.')
      .addToggle((t) => {
        t.setValue(false)
          .setDisabled(true)
          .onChange(async () => {
            // Locked off until the CRM surface is wired end-to-end.
          });
      });
  }

  // ------------------------------------------------------------------
  // File-based fallback
  // ------------------------------------------------------------------
  private renderFallbackSection(): void {
    const { containerEl } = this;
    this.sectionHeader(
      'File-based fallback',
      'When PrimeTask is closed or on another device, the plugin reads and writes markdown files in your vault. They reconcile with PrimeTask automatically when it next opens.',
    );

    new Setting(containerEl)
      .setName('Enable fallback')
      .setDesc('Recommended. Keeps the plugin useful offline and across devices via your Obsidian sync.')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.enableFileFallback).onChange(async (value) => {
          this.plugin.settings.enableFileFallback = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Fallback folder')
      .setDesc('Folder inside this vault where PrimeTask markdown mirrors live.')
      .addText((text) => {
        text
          .setPlaceholder('PrimeTask')
          .setValue(this.plugin.settings.fallbackVaultFolder)
          .onChange(async (value) => {
            this.plugin.settings.fallbackVaultFolder = value.trim() || 'PrimeTask';
            await this.plugin.saveSettings();
          });
      });
  }

  // ------------------------------------------------------------------
  // Markdown mirror — full entity graph
  // ------------------------------------------------------------------
  private renderMirrorSection(): void {
    const { containerEl } = this;
    this.sectionHeader(
      'Markdown mirror (beta)',
      'Mirror your PrimeTask tasks, projects, milestones, goals and CRM into markdown files inside this vault. Uses frontmatter + wikilinks so Obsidian graph view, Bases and Dataview can query them natively. Edits in Obsidian sync back to PrimeTask. Off by default — opt-in.',
    );

    new Setting(containerEl)
      .setName('Enable markdown mirror')
      .setDesc('Turns on two-way file sync. Creates a folder in your vault and keeps it up to date.')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.mirrorEnabled).onChange(async (value) => {
          this.plugin.settings.mirrorEnabled = value;
          await this.plugin.saveSettings();
          await this.plugin.applyMirrorState();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('Mirror folder')
      .setDesc('Folder inside this vault where PrimeTask files live. Created automatically on first sync.')
      .addText((text) => {
        text
          .setPlaceholder('PrimeTask')
          .setValue(this.plugin.settings.mirrorFolder)
          .onChange(async (value) => {
            this.plugin.settings.mirrorFolder = value.trim() || 'PrimeTask';
            await this.plugin.saveSettings();
          });
      });

    if (!this.plugin.settings.mirrorEnabled) return;

    // Per-entity toggles
    this.sectionHeader('What to mirror', 'Pick which entities get their own markdown files.');

    new Setting(containerEl)
      .setName('Projects (with tasks)')
      .setDesc('One file per project, tasks as checkboxes inside. Orphan tasks land in Inbox.md.')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.mirrorProjects).onChange(async (v) => {
          this.plugin.settings.mirrorProjects = v;
          await this.plugin.saveSettings();
          await this.plugin.applyMirrorState();
        });
      });

    // Milestones + goals mirroring is in the v0.2 release lane. Toggles
     // locked off until shipping so users see the roadmap without
     // getting a no-op toggle.
    new Setting(containerEl)
      .setName('Milestones')
      .setDesc('Coming soon. Milestone mirroring is being built and will ship in the next release.')
      .addToggle((t) => {
        t.setValue(false).setDisabled(true).onChange(async () => {});
      });

    new Setting(containerEl)
      .setName('Goals')
      .setDesc('Coming soon. Goal mirroring is being built and will ship in the next release.')
      .addToggle((t) => {
        t.setValue(false).setDisabled(true).onChange(async () => {});
      });

    // ---- CRM mirroring (coming soon) --------------------------------
    // Contacts / companies / activities toggles are rendered disabled
    // until the CRM generator path ships. We keep them visible + locked
    // rather than hiding so users see what's on the roadmap. File-
    // strategy dropdowns are hidden entirely (nothing to configure while
    // the toggles are off).
    new Setting(containerEl)
      .setName('Contacts (Pro)')
      .setDesc('Coming soon. CRM contact mirroring is being built and will ship in a future release. Requires PrimeTask Pro when enabled.')
      .addToggle((t) => {
        t.setValue(false).setDisabled(true).onChange(async () => {});
      });

    new Setting(containerEl)
      .setName('Companies (Pro)')
      .setDesc('Coming soon. CRM company mirroring is being built and will ship in a future release. Requires PrimeTask Pro when enabled.')
      .addToggle((t) => {
        t.setValue(false).setDisabled(true).onChange(async () => {});
      });

    new Setting(containerEl)
      .setName('Activities (Pro)')
      .setDesc('Coming soon. CRM activities (calls, emails, notes, meetings) will surface inside contact and company notes when CRM mirroring ships.')
      .addToggle((t) => {
        t.setValue(false).setDisabled(true).onChange(async () => {});
      });

    new Setting(containerEl)
      .setName('Rename files when entities rename')
      .setDesc('When a project / milestone / goal is renamed in PrimeTask, also rename the matching file in your vault. Off by default to avoid surprise file moves.')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.mirrorRenameFiles).onChange(async (v) => {
          this.plugin.settings.mirrorRenameFiles = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Regenerate all files')
      .setDesc('Rebuilds every mirror file from PrimeTask state. Any unsynced offline edits in progress will be lost.')
      .addButton((btn) => {
        btn.setButtonText('Regenerate').setWarning().onClick(async () => {
          try {
            await this.plugin.regenerateMirror();
            new Notice('Markdown mirror regenerated');
          } catch (err) {
            new Notice(`Regenerate failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      });
  }

  // ------------------------------------------------------------------
  // Advanced
  // ------------------------------------------------------------------
  private renderAdvancedSection(): void {
    const { containerEl } = this;
    this.sectionHeader('Advanced', 'Diagnostics and reset.');

    new Setting(containerEl)
      .setName('Log level')
      .setDesc('How verbose the plugin is in the developer console.')
      .addDropdown((dd) => {
        dd.addOption('error', 'Error');
        dd.addOption('warn', 'Warn');
        dd.addOption('info', 'Info');
        dd.addOption('debug', 'Debug');
        dd.setValue(this.plugin.settings.logLevel);
        dd.onChange(async (value) => {
          this.plugin.settings.logLevel = value as LogLevel;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Reset plugin data')
      .setDesc('Clears the auth token and cached preferences. Notes in your vault are not touched.')
      .addButton((btn) => {
        btn
          .setButtonText('Reset')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings = { ...DEFAULT_SETTINGS };
            await this.plugin.saveSettings();
            this.display();
          });
      });
  }

  // ------------------------------------------------------------------
  // Footer
  // ------------------------------------------------------------------
  private renderFooter(): void {
    const footer = this.containerEl.createDiv({ cls: 'primetask-settings-footer' });
    footer.createSpan({
      text: 'Built to last. Designed to stay with you.',
    });
  }

  private sectionHeader(title: string, description?: string): void {
    // Use Obsidian's native Setting.setHeading() so themes render our section
    // headers with the same card / divider styling as the rest of the settings.
    const heading = new Setting(this.containerEl).setName(title).setHeading();
    if (description) heading.setDesc(description);
    heading.settingEl.addClass('primetask-settings-section');
  }
}
