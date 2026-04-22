import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { PrimeTaskSettings, DEFAULT_SETTINGS, PrimeTaskSettingTab } from './settings';
import { ConnectionManager, type ConnectionState } from './api/connection';
import type { PrimeTaskProject, PrimeTaskSpace, PrimeTaskTask } from './api/client';
import { AuthorizeModal } from './ui/AuthorizeModal';
import { TasksView, PRIMETASK_VIEW_TYPE } from './ui/TasksView';
import { MirrorManager } from './mirror/mirror';
import { hidePtMarkersExtension } from './mirror/hideMarkers';

export default class PrimeTaskPlugin extends Plugin {
  settings: PrimeTaskSettings = DEFAULT_SETTINGS;
  connection!: ConnectionManager;
  mirror!: MirrorManager;
  spaces: PrimeTaskSpace[] = [];
  private statusBarEl: HTMLElement | null = null;
  /**
   * Plugin-level poll that drives the markdown mirror independently of
   * whether the sidebar is open. Previously the mirror piggy-backed on
   * TasksView's 5s refresh, which meant closing the sidebar silently
   * froze all task-note frontmatter updates. Users reported "I edited
   * in PrimeTask but Obsidian didn't update" and the cause was a
   * hidden dependency on the sidebar being visible.
   */
  private mirrorPollTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly MIRROR_POLL_INTERVAL_MS = 5_000;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.connection = new ConnectionManager(this.resolvePort(), this.settings.bearerToken);
    // Persistent-cleanup hook: if the desktop app revokes our token, clear
    // the persisted bearerToken from settings so the revocation survives a
    // plugin reload (otherwise we'd keep presenting a stale token on every
    // start until the user re-authorised manually).
    this.connection.setOnUnauthorized(() => {
      this.settings.bearerToken = null;
      this.spaces = [];
      this.saveSettings().catch(() => {});
      new Notice('PrimeTask revoked this plugin. Re-authorize from settings to reconnect.');
    });
    this.mirror = new MirrorManager(this);
    this.statusBarEl = this.addStatusBarItem();
    this.renderStatus(this.connection.getState());
    this.applyStatusBarVisibility();

    this.register(
      this.connection.subscribe((state) => {
        this.renderStatus(state);
        // Auto-fetch spaces the first time we flip to connected.
        if (state.status === 'connected' && this.spaces.length === 0) {
          this.refreshSpaces().catch(() => {});
        }
      }),
    );

    this.addSettingTab(new PrimeTaskSettingTab(this.app, this));

    // Register typed widgets for our frontmatter fields in Obsidian's
    // Properties panel and Bases. This turns `due` into a date picker,
    // `progress` into a numeric input, `tags` into a tag chip editor, and
    // the timestamps into datetime fields — instead of everything being a
    // generic text input. Uses an undocumented API; wrapped in try/catch
    // so future Obsidian versions that rename it don't break the plugin.
    this.registerPropertyTypes();

    // Hide %%pt:id%% markers in Live Preview (Reading mode already hides them).
    this.registerEditorExtension(hidePtMarkersExtension);

    // Register the right-sidebar view.
    this.registerView(PRIMETASK_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TasksView(leaf, this));

    // Ribbon icon opens the sidebar panel.
    this.addRibbonIcon('list-checks', 'Open PrimeTask', () => {
      this.activateView().catch(() => {});
    });

    this.addCommand({
      id: 'primetask-open-panel',
      name: 'Open PrimeTask panel',
      callback: () => { this.activateView().catch(() => {}); },
    });

    this.addCommand({
      id: 'primetask-authorize',
      name: 'Authorize PrimeTask connection',
      callback: () => this.openAuthorizeModal(),
    });

    this.addCommand({
      id: 'primetask-ping',
      name: 'Check PrimeTask connection',
      callback: async () => {
        const res = await this.connection.pingOnce();
        if (res) {
          new Notice(`Connected · v${res.version}`);
        } else {
          new Notice('PrimeTask is not running or unreachable.');
        }
      },
    });

    this.addCommand({
      id: 'primetask-sync-now',
      name: 'Sync now',
      callback: async () => {
        if (!this.settings.syncEnabled) { new Notice('Sync is paused. Enable sync in settings first.'); return; }
        if (!this.settings.mirrorEnabled) { new Notice('Markdown mirror is off. Enable it in settings first.'); return; }
        if (!this.settings.defaultSpaceId) { new Notice('Lock a space in settings first.'); return; }
        try {
          await this.syncMirrorFromLatest();
          new Notice('PrimeTask: sync complete.');
        } catch (err) {
          new Notice(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    // Send current checkbox line to PrimeTask. Works anywhere in the vault,
    // not just mirrored files. If cursor is in a project file, the created
    // task inherits that project.
    this.addCommand({
      id: 'primetask-send-line',
      name: 'Send current line as task to PrimeTask',
      editorCallback: (editor, view) => {
        const file = view.file;
        if (!file) { new Notice('No active file'); return; }
        const cursor = editor.getCursor();
        const lineText = editor.getLine(cursor.line);
        this.mirror.sendLineToPrimeTask(file, cursor.line, lineText).catch(() => {});
      },
    });

    // Right-click context menu — works in any markdown file anywhere.
    //
    //   Selection present →
    //     "Send selection to PrimeTask and link here"
    //         creates a task + local `.md` file, replaces the selection with
    //         a `[[wikilink]]` to that file. Primary flow for graph-native
    //         capture.
    //     "Send selection to PrimeTask"
    //         creates a task only. No file, the source note is untouched.
    //
    //   No selection, cursor on an un-synced checkbox →
    //     "Send to PrimeTask"
    //         converts the checkbox line into a synced task (stamps %%pt:id%%).
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        const file = view.file;
        if (!file) return;

        const selection = editor.getSelection();
        const trimmedSelection = selection.trim();

        if (trimmedSelection.length > 0) {
          menu.addItem((item) => {
            item
              .setTitle('Send selection to PrimeTask and link here')
              .setIcon('list-checks')
              .onClick(async () => {
                const result = await this.mirror.promoteSelectionToTaskNote(trimmedSelection, file);
                if (!result) return;
                // Replace the selection with a wikilink to the new task file.
                // Mark the source file as an own-write so the watcher doesn't
                // treat this as a user edit worth reconciling.
                this.mirror.markOwnWrite(file.path);
                editor.replaceSelection(`[[${result.filenameStem}]]`);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle('Send selection to PrimeTask')
              .setIcon('send')
              .onClick(async () => {
                await this.mirror.sendSelectionToInbox(trimmedSelection);
              });
          });
          return;
        }

        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const isCheckbox = /^\s*- \[[ xX]\]/.test(line);
        const alreadySynced = /(<!--\s*pt:[a-zA-Z0-9_-]+\s*-->|%%\s*pt:[a-zA-Z0-9_-]+\s*%%)/.test(line);
        if (isCheckbox && !alreadySynced) {
          menu.addItem((item) => {
            item
              .setTitle('Send to PrimeTask')
              .setIcon('list-checks')
              .onClick(async () => {
                await this.mirror.sendLineToPrimeTask(file, cursor.line, line);
              });
          });
          return;
        }

        // No selection, not on an un-synced checkbox → offer whole-note
        // conversion. Only for files that aren't already PrimeTask
        // entities (the mirror manager guards this too, but hiding the
        // menu item up-front avoids the user clicking a no-op).
        const isAlreadyEntity = /^---[\s\S]*?primetask-id:\s*\S/m.test(editor.getValue());
        if (isAlreadyEntity) return;
        menu.addItem((item) => {
          item
            .setTitle('Convert note to PrimeTask project')
            .setIcon('folder-plus')
            .onClick(async () => {
              await this.mirror.convertNoteToProject(file);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle('Convert note to PrimeTask task')
            .setIcon('file-plus')
            .onClick(async () => {
              await this.mirror.convertNoteToTask(file);
            });
        });
      }),
    );

    this.addCommand({
      id: 'primetask-promote-selection',
      name: 'Send selection to PrimeTask and link here',
      editorCallback: async (editor, view) => {
        const file = view.file;
        if (!file) { new Notice('No active file'); return; }
        const selection = editor.getSelection().trim();
        if (!selection) { new Notice('Nothing selected'); return; }
        const result = await this.mirror.promoteSelectionToTaskNote(selection, file);
        if (!result) return;
        this.mirror.markOwnWrite(file.path);
        editor.replaceSelection(`[[${result.filenameStem}]]`);
      },
    });

    this.addCommand({
      id: 'primetask-send-selection',
      name: 'Send selection to PrimeTask',
      editorCallback: (editor) => {
        const selection = editor.getSelection().trim();
        if (!selection) { new Notice('Nothing selected'); return; }
        this.mirror.sendSelectionToInbox(selection).catch(() => {});
      },
    });

    this.addCommand({
      id: 'primetask-convert-note-to-project',
      name: 'Convert note to PrimeTask project',
      editorCallback: async (_editor, view) => {
        const file = view.file;
        if (!file) { new Notice('No active file'); return; }
        await this.mirror.convertNoteToProject(file);
      },
    });

    this.addCommand({
      id: 'primetask-convert-note-to-task',
      name: 'Convert note to PrimeTask task',
      editorCallback: async (_editor, view) => {
        const file = view.file;
        if (!file) { new Notice('No active file'); return; }
        await this.mirror.convertNoteToTask(file);
      },
    });

    // Honor the master sync toggle on load.
    if (this.settings.syncEnabled) {
      this.connection.start().catch((err) => {
        console.warn('[PrimeTask] Connection start failed', err);
      });
    } else {
      this.connection.disable().catch(() => {});
    }

    // Kick off the markdown mirror if the user has it enabled.
    if (this.settings.mirrorEnabled) {
      this.mirror.start().catch((err) => console.warn('[PrimeTask] Mirror start failed', err));
      // Start a plugin-level poll that keeps task-note frontmatter
      // updated regardless of whether the sidebar is open. Sidebar's
      // 5s TasksView poll ALSO calls syncOnce — the mirror's internal
      // `busy` flag + `MIN_SYNC_INTERVAL_MS` throttle coalesce the
      // two callers so the server isn't hit twice per cycle.
      this.startMirrorPoll();
    }
  }

  onunload(): void {
    this.connection?.stop();
    this.stopMirrorPoll();
  }

  /**
   * Start a plugin-level mirror poll. Runs independently of the sidebar
   * so task-note frontmatter stays in sync even when the PrimeTask panel
   * is closed. Idempotent — safe to call multiple times; always cleans
   * up any existing timer first.
   */
  startMirrorPoll(): void {
    this.stopMirrorPoll();
    // Kick off an immediate sync so users don't wait up to a full
    // interval for the first update after enabling the mirror.
    this.syncMirrorFromLatest().catch(() => {});
    this.mirrorPollTimer = setInterval(() => {
      this.syncMirrorFromLatest().catch(() => {});
    }, PrimeTaskPlugin.MIRROR_POLL_INTERVAL_MS);
  }

  stopMirrorPoll(): void {
    if (this.mirrorPollTimer) {
      clearInterval(this.mirrorPollTimer);
      this.mirrorPollTimer = null;
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  resolvePort(): number {
    const p = this.settings.port;
    if (typeof p === 'number' && p > 0) return p;
    return 41573;
  }

  applyStatusBarVisibility(): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.toggleClass('primetask-status-hidden', !this.settings.showStatusBar);
  }

  /**
   * Tell Obsidian's Properties panel + Bases what widget to render for each
   * of our frontmatter fields. Types we set here propagate vault-wide (not
   * scoped to PrimeTask's folder), so we only register fields that are
   * unambiguously ours and don't conflict with common user conventions.
   * Uses `metadataTypeManager.setType` (undocumented but stable since 1.4).
   */
  private registerPropertyTypes(): void {
    try {
      const mtm = (this.app as any).metadataTypeManager;
      if (!mtm?.setType) return;
      // Native typed widgets for the structured fields we write.
      // `due` is datetime (not date) because PrimeTask supports
      // specific times of day ("due by 3pm"), not just calendar days.
      // Using `date` here would silently drop the time portion on edit.
      mtm.setType('due', 'datetime');
      mtm.setType('progress', 'number');
      mtm.setType('tags', 'tags');
      mtm.setType('created_at', 'datetime');
      mtm.setType('updated_at', 'datetime');
      mtm.setType('mirrored_at', 'datetime');
      mtm.setType('is_shared', 'checkbox');
      // One-tick completion shortcut. Cheapest possible "mark done" UX —
      // users click the checkbox and the reconcile path maps it to the
      // space's default complete status via the semantic 'done' token.
      mtm.setType('done', 'checkbox');
      // Project hub fields — typed so Bases / Dataview can filter + sort
      // numerically and render date widgets rather than raw strings.
      mtm.setType('task_count', 'number');
      mtm.setType('completed_count', 'number');
      mtm.setType('overdue_count', 'number');
      mtm.setType('is_archived', 'checkbox');
      mtm.setType('start_date', 'date');
      mtm.setType('deadline', 'date');
      // Leave status, priority, description, project, space, origin as
      // text so Obsidian's autocomplete kicks in from existing values.
      // A future enhancement can swap status / priority for proper enum
      // widgets via Meta-Bind integration or a custom renderer.
    } catch (err) {
      console.warn('[PrimeTask] Failed to register property types', err);
    }
  }

  // ------------------------------------------------------------------
  // Markdown mirror lifecycle
  // ------------------------------------------------------------------

  async applyMirrorState(): Promise<void> {
    if (this.settings.mirrorEnabled) {
      if (!this.mirror.isRunning()) {
        await this.mirror.start();
      }
      // Run one pass immediately AND start the recurring plugin-level
      // poll so the mirror stays fresh even when the sidebar is closed.
      // The poll itself triggers the first fetch, so no need to call
      // syncMirrorFromLatest directly here.
      this.startMirrorPoll();
    } else {
      this.stopMirrorPoll();
      await this.mirror.stop();
    }
  }

  async regenerateMirror(): Promise<void> {
    const data = await this.fetchLatestForMirror();
    if (!data) throw new Error('PrimeTask is not reachable');
    await this.mirror.regenerate(data);
  }

  async syncMirrorFromLatest(): Promise<void> {
    if (!this.mirror.isRunning()) return;
    const data = await this.fetchLatestForMirror();
    if (!data) return;
    await this.mirror.syncOnce(data);
  }

  /**
   * Fetch tasks + projects from PrimeTask, scoped to the LOCKED space the
   * user picked in Obsidian settings. Returns null if not connected, not
   * authorised, or no locked space configured.
   *
   * The plugin deliberately ignores whichever space is currently *active* in
   * the desktop app — switching space in PrimeTask must NOT change what
   * Obsidian is mirroring, otherwise the watcher diffs the new space's tasks
   * against state from the old space and emits cascade-deletes. The lock is
   * the only safe contract.
   */
  private async fetchLatestForMirror(): Promise<{ tasks: PrimeTaskTask[]; projects: PrimeTaskProject[]; spaceName: string | null; lockedSpace: PrimeTaskSpace | null } | null> {
    const state = this.connection.getState();
    if (state.status !== 'connected') return null;
    const lockedSpaceId = this.settings.defaultSpaceId;
    if (!lockedSpaceId) return null;
    try {
      const client = this.connection.getClient();
      // Refresh the spaces list first so we can resolve the locked id → name
      // for the Space hub file. If listSpaces fails we fall back to the
      // cached list rather than aborting the sync entirely.
      const spaces = await client.listSpaces().catch(() => this.spaces);
      this.spaces = spaces;
      const lockedSpace = spaces.find((s) => s.id === lockedSpaceId);
      if (!lockedSpace) {
        // Locked space no longer exists (deleted / id stale). Refuse to sync —
        // we don't know which space's data to mirror.
        console.warn('[PrimeTask] Locked space not found in spaces list — aborting mirror');
        return null;
      }
      const [tasks, projects] = await Promise.all([
        client.listTasks({ spaceId: lockedSpaceId }),
        client.listProjects({ spaceId: lockedSpaceId }),
      ]);
      return { tasks, projects, spaceName: lockedSpace.name, lockedSpace };
    } catch (err) {
      console.warn('[PrimeTask] Mirror fetch failed', err);
      return null;
    }
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(PRIMETASK_VIEW_TYPE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: PRIMETASK_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  // ------------------------------------------------------------------
  // Auth flow
  // ------------------------------------------------------------------

  openAuthorizeModal(): void {
    const state = this.connection.getState();
    if (state.status === 'disconnected' || state.status === 'error') {
      new Notice('PrimeTask is not reachable. Start the desktop app first.');
      return;
    }
    if (!this.settings.syncEnabled) {
      new Notice('Enable sync first.');
      return;
    }
    new AuthorizeModal(this.app, this).open();
  }

  async finishAuthorization(token: string): Promise<void> {
    this.settings.bearerToken = token;
    await this.saveSettings();
    this.connection.setToken(token);
    // Immediately ping to flip status to `connected`, and fetch spaces.
    await this.connection.pingOnce().catch(() => {});
    await this.refreshSpaces().catch(() => {});
    // Fire the refresh event so TasksView re-fetches tasks/projects/etc
    // right now — otherwise the sidebar waits up to 5s for the next poll
    // cycle and users think nothing happened until they click Test.
    this.app.workspace.trigger('primetask:refresh');
  }

  async revokeAuthorization(): Promise<void> {
    this.settings.bearerToken = null;
    await this.saveSettings();
    this.connection.setToken(null);
    this.spaces = [];
    await this.connection.pingOnce().catch(() => {});
    new Notice('PrimeTask authorization revoked on this device.');
  }

  async refreshSpaces(): Promise<PrimeTaskSpace[]> {
    const state = this.connection.getState();
    if (state.status !== 'connected') return this.spaces;
    try {
      const spaces = await this.connection.getClient().listSpaces();
      this.spaces = spaces;
      return spaces;
    } catch (err) {
      console.warn('[PrimeTask] Failed to refresh spaces', err);
      return this.spaces;
    }
  }

  // ------------------------------------------------------------------
  // Status bar
  // ------------------------------------------------------------------

  private renderStatus(state: ConnectionState): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    this.statusBarEl.addClass('primetask-status');

    const dot = this.statusBarEl.createSpan({ cls: 'primetask-status-dot' });
    dot.addClass(`primetask-status-${state.status}`);

    const label =
      state.status === 'disabled' ? 'PrimeTask · paused'
      : state.status === 'needs-auth' ? 'PrimeTask · authorize'
      : state.status === 'connected' ? 'PrimeTask'
      : 'PrimeTask offline';
    this.statusBarEl.createSpan({ cls: 'primetask-status-label', text: label });

    this.statusBarEl.setAttr('title', this.describeState());
  }

  private describeState(): string {
    const s = this.connection.getState();
    if (s.status === 'disabled') {
      return 'PrimeTask sync is paused. Re-enable it from Settings → PrimeTask.';
    }
    if (s.status === 'needs-auth') {
      return 'PrimeTask is running but not authorized yet. Run the "Authorize PrimeTask connection" command.';
    }
    if (s.status === 'connected') {
      return `Connected · v${s.serverVersion ?? ''} (phase ${s.serverPhase ?? '?'}). Port ${s.port}.`;
    }
    if (s.status === 'connecting') {
      return `Connecting to PrimeTask on port ${s.port}...`;
    }
    return s.lastError
      ? `PrimeTask offline: ${s.lastError}`
      : `PrimeTask not detected on port ${s.port}. Launch the desktop app and the plugin will auto-connect.`;
  }
}
