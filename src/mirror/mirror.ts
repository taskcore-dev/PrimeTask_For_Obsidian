/**
 * Markdown mirror orchestrator.
 *
 * Responsibilities:
 *   - Persist MirrorState alongside plugin data
 *   - Run a full generation pass from PrimeTask REST data (C)
 *   - Subscribe to vault events and push edits back to PrimeTask via REST (D)
 *   - Own-write echo prevention so our own writes don't trigger false deltas
 *   - Cross-file task moves: task line dragged from Inbox.md → Project.md
 *     triggers a projectId update in PrimeTask
 */

import { EventRef, Notice, TAbstractFile, TFile, normalizePath } from 'obsidian';
import type PrimeTaskPlugin from '../main';
import { SpaceMismatchError, type PrimeTaskPriority, type PrimeTaskProject, type PrimeTaskSpace, type PrimeTaskStatus, type PrimeTaskTask } from '../api/client';
import { generateMirror } from './generator';
import { parseMirrorFile, extractProjectId } from './parser';
import { renderTaskFile, dedupeFilename, extractTaskSnapshot, replaceFrontmatter, stripDescriptionHtml, datetimesEqual, toIsoUtc } from './taskFile';
import { safeFilename } from './markdown';
import { DEFAULT_MIRROR_STATE, type MirrorFileState, type MirrorState } from './types';

const MIRROR_STATE_KEY = 'mirrorState';
const OWN_WRITE_WINDOW_MS = 2500;
// Wait this long after the user's last keystroke before syncing. Prevents
// creating half-typed tasks and batches rapid edits into one REST call.
const RECONCILE_DEBOUNCE_MS = 1500;
// Minimum characters in a task title before we even consider creating it.
// Stops "- [ ] a" from becoming a real task while the user is mid-word.
const MIN_TASK_NAME_LENGTH = 2;

export class MirrorManager {
  private plugin: PrimeTaskPlugin;
  private state: MirrorState = { ...DEFAULT_MIRROR_STATE };
  private running = false;
  private busy = false;
  private vaultEventRefs: EventRef[] = [];
  /** path → timestamp of our last own-write (used to skip the echo event) */
  private ownWrites = new Map<string, number>();
  /** Debounced reconcile timers per file — coalesces rapid keystrokes. */
  private debouncedReconcile = new Map<string, ReturnType<typeof setTimeout>>();
  /** Timestamp of the last completed syncOnce — used to throttle redundant passes. */
  private lastSyncAt = 0;
  private static readonly MIN_SYNC_INTERVAL_MS = 1000;

  constructor(plugin: PrimeTaskPlugin) {
    this.plugin = plugin;
  }

  async start(): Promise<void> {
    if (!this.plugin.settings.mirrorEnabled) return;
    await this.loadState();
    this.running = true;
    this.subscribeToVault();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unsubscribeFromVault();
    for (const timer of this.debouncedReconcile.values()) clearTimeout(timer);
    this.debouncedReconcile.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  getState(): MirrorState {
    return this.state;
  }

  /**
   * Run a full mirror generation pass. Safe to call any time — idempotent.
   */
  async syncOnce(params: {
    tasks: PrimeTaskTask[];
    projects: PrimeTaskProject[];
    spaceName: string | null;
    lockedSpace?: PrimeTaskSpace | null;
  }): Promise<void> {
    if (!this.running) return;
    if (!this.plugin.settings.mirrorEnabled) return;
    if (this.busy) return;
    // Coalesce rapid calls (polling + refresh event fire back-to-back).
    if (Date.now() - this.lastSyncAt < MirrorManager.MIN_SYNC_INTERVAL_MS) return;

    this.busy = true;
    try {
      const before = new Set(Object.keys(this.state.files));
      const result = await generateMirror({
        vault: this.plugin.app.vault,
        settings: this.plugin.settings,
        projects: params.projects,
        tasks: params.tasks,
        state: this.state,
        spaceName: params.spaceName,
        lockedSpace: params.lockedSpace ?? null,
        // Mark own-writes SYNCHRONOUSLY before each vault.modify so the
        // watcher's echo check fires against a populated map. Marking
        // in a post-generation loop races the modify events that fire
        // inside vault.modify, causing phantom reconciles and PATCH
        // loops that can freeze the desktop app.
        markOwnWrite: (path) => this.ownWrites.set(path, Date.now()),
      });
      // Belt-and-braces: re-mark the set of touched paths so they're still
      // guarded for the full echo window even if individual calls raced.
      for (const path of result.createdOrUpdated) {
        this.ownWrites.set(path, Date.now());
      }
      // Clean up state entries for files we no longer generate (e.g. project deleted).
      for (const path of before) {
        if (!result.createdOrUpdated.includes(path)) {
          // Don't delete state for files the user might still have — just leave it.
        }
      }
      await this.saveState();
      if (result.errors.length > 0) {
        console.warn('[PrimeTask] Mirror generation had errors:', result.errors);
      }

      // PrimeTask → Obsidian side of bidirectional sync: whenever the poll
      // brings back updated server state, rewrite any diverged task-file
      // frontmatter in place. Runs AFTER hub regeneration so state is current.
      const lockedSpaceId = this.plugin.settings.defaultSpaceId;
      if (lockedSpaceId) {
        try {
          await this.updateTaskFilesFromServer(params.tasks, lockedSpaceId);
        } catch (err) {
          console.warn('[PrimeTask] Task frontmatter pull failed', err);
        }
        try {
          await this.updateProjectFilesFromServer(params.projects, params.tasks, lockedSpaceId);
        } catch (err) {
          console.warn('[PrimeTask] Project frontmatter pull failed', err);
        }
      }

      this.lastSyncAt = Date.now();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Force a full regeneration. Clears state first so files are rebuilt
   * from scratch rather than skipped as unchanged.
   */
  async regenerate(params: {
    tasks: PrimeTaskTask[];
    projects: PrimeTaskProject[];
    spaceName: string | null;
    lockedSpace?: PrimeTaskSpace | null;
  }): Promise<void> {
    this.state.files = {};
    await this.syncOnce(params);
    new Notice('Mirror regenerated');
  }

  // ------------------------------------------------------------------
  // Vault event subscriptions
  // ------------------------------------------------------------------

  private subscribeToVault(): void {
    this.unsubscribeFromVault();
    const { vault } = this.plugin.app;
    const onModify = vault.on('modify', (file) => this.handleVaultChange(file).catch((err) => console.warn('[PrimeTask] handleVaultChange failed', err)));
    const onCreate = vault.on('create', (file) => this.handleVaultChange(file).catch(() => {}));
    const onRename = vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath).catch(() => {}));
    const onDelete = vault.on('delete', (file) => this.handleDelete(file).catch(() => {}));
    this.vaultEventRefs = [onModify, onCreate, onRename, onDelete];
  }

  private unsubscribeFromVault(): void {
    for (const ref of this.vaultEventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.vaultEventRefs = [];
  }

  /**
   * Returns true if the vault event at `path` matches a recent own-write
   * (within OWN_WRITE_WINDOW_MS). Also cleans up stale entries.
   */
  private isOwnWriteEcho(path: string): boolean {
    this.sweepOwnWrites();
    const ts = this.ownWrites.get(path);
    if (ts && Date.now() - ts <= OWN_WRITE_WINDOW_MS) {
      // Echo — consume the mark so subsequent REAL edits aren't suppressed.
      this.ownWrites.delete(path);
      return true;
    }
    return false;
  }

  private sweepOwnWrites(): void {
    const cutoff = Date.now() - OWN_WRITE_WINDOW_MS * 2;
    for (const [p, ts] of this.ownWrites.entries()) {
      if (ts < cutoff) this.ownWrites.delete(p);
    }
  }

  private isInMirrorFolder(path: string): boolean {
    const root = (this.plugin.settings.mirrorFolder || 'PrimeTask').replace(/\/+$/, '');
    return path === root || path.startsWith(`${root}/`);
  }

  private async handleVaultChange(file: TAbstractFile): Promise<void> {
    if (!this.running) return;
    if (!(file instanceof TFile)) return;
    if (!this.isInMirrorFolder(file.path)) return;
    if (!file.path.endsWith('.md')) return;
    if (this.isOwnWriteEcho(file.path)) return;

    // Debounce: wait for the user to stop typing before reconciling.
    const existing = this.debouncedReconcile.get(file.path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debouncedReconcile.delete(file.path);
      this.reconcileFile(file).catch((err) => console.warn('[PrimeTask] reconcileFile failed', err));
    }, RECONCILE_DEBOUNCE_MS);
    this.debouncedReconcile.set(file.path, timer);
  }

  /**
   * Read a file and, if the plugin owns it as a syncable entity, push
   * the user's edits back to PrimeTask.
   *
   * Ownership contract:
   *   - The plugin only reconciles files it created and tracks in
   *     `state.files`. Any other file in the vault — including user-
   *     authored notes that happen to carry PrimeTask-looking frontmatter
   *     or checkbox lines — is completely inert.
   *   - Within owned files, the entity type determines whether edits
   *     are pushed back (bidirectional) or silently ignored (read-only
   *     hub files that regenerate on every sync).
   *
   * The `switch` below is exhaustive against `EntityType`. When a new
   * entity type is added to the union, TypeScript forces a decision
   * here: either add a reconciler branch (bidirectional) or add the
   * type to the read-only group.
   */
  private async reconcileFile(file: TFile): Promise<void> {
    const previous = this.state.files[file.path];
    if (!previous) return; // not owned — leave user files alone

    switch (previous.type) {
      case 'task':
      case 'subtask': {
        const content = await this.plugin.app.vault.read(file);
        const parsed = parseMirrorFile(content);
        await this.reconcileTaskFile(file, parsed.frontmatter, previous);
        return;
      }
      // Read-only hub + aggregator types. The plugin regenerates these
      // from server state every sync, so any user edits are overwritten
      // rather than synced back. Intentional.
      case 'app':
      case 'space':
      case 'project':
      case 'inbox':
      case 'milestone':
      case 'goal':
      case 'contact':
      case 'company':
      case 'contacts-index':
      case 'companies-index':
        return;
    }
  }

  /**
   * Task-file frontmatter reconcile. Runs on every user-edit of a
   * `type: task` file. Diffs the CURRENT frontmatter against the
   * last-known snapshot and PATCHes only the fields that actually changed.
   *
   * Field mapping:
   *   status   → PrimeTask resolves the name string (the server maps
   *              "In Progress" / "Done" / arbitrary custom status names
   *              to the right UUID).
   *   priority → same name-based resolution on the server.
   *   due      → ISO date string or null (explicit null clears the date).
   *   progress → 0..100 number, goes to completionPercentage.
   *   project  → wikilink unwrapped to a stem; resolved to a project id by
   *              matching a tracked project file's primetask-id (state.files).
   *              Unresolvable wikilinks are left untouched for safety.
   */
  private async reconcileTaskFile(_file: TFile, frontmatter: Record<string, unknown>, state: MirrorFileState): Promise<void> {
    const taskId = state.primetaskId;
    if (!taskId) return;

    const current = extractTaskSnapshot(frontmatter);
    const before = state.frontmatterSnapshot ?? {};

    const patch: { status?: string; priority?: string; dueDate?: string | null; completionPercentage?: number; projectId?: string | null; description?: string; spaceId?: string } = {};
    let changed = false;

    const statusChanged = current.status !== before.status && current.status !== undefined;
    const doneChanged = current.done !== undefined && current.done !== before.done;

    if (statusChanged) {
      // Explicit status edit wins — user picked a specific status name.
      patch.status = current.status;
      changed = true;
    } else if (doneChanged) {
      // Done checkbox flipped without a status name change — send the
      // semantic token so the server resolves to the space's configured
      // default complete / open status id (which may be "Shipped", etc.
      // in custom-status spaces, not literally "done").
      patch.status = current.done ? 'done' : 'todo';
      changed = true;
    }
    if (current.priority !== before.priority && current.priority !== undefined) {
      patch.priority = current.priority;
      changed = true;
    }
    if (!datetimesEqual(current.due ?? null, before.due ?? null)) {
      // Normalise to canonical ISO UTC for the wire, regardless of
      // whether the user's edit landed as local-naive datetime
      // (`2026-04-22T09:00`) or full ISO. Server always gets UTC.
      patch.dueDate = current.due === undefined ? null : toIsoUtc(current.due);
      changed = true;
    }
    if (current.progress !== before.progress && current.progress !== undefined) {
      patch.completionPercentage = current.progress;
      changed = true;
    }
    if ((current.description ?? '') !== (before.description ?? '')) {
      patch.description = current.description ?? '';
      changed = true;
    }
    // Project reassignment from Obsidian is not supported. It would
    // require wikilink → project-id resolution via state.files, plus
    // careful handling of ambiguous target names. Users reassign a
    // task's project via the PrimeTask app or sidebar instead.

    if (!changed) return;

    const lockedSpaceId = this.plugin.settings.defaultSpaceId ?? undefined;
    if (lockedSpaceId) patch.spaceId = lockedSpaceId;

    try {
      const client = this.plugin.connection.getClient();
      await client.updateTask(taskId, patch);
      // Commit the new snapshot so we don't re-send the same diff on the
      // next poll-triggered modify event.
      state.frontmatterSnapshot = current;
      await this.saveState();
      this.plugin.app.workspace.trigger('primetask:refresh');
    } catch (err) {
      if (err instanceof SpaceMismatchError) {
        new Notice(`PrimeTask: Switch to your locked space in PrimeTask first.`);
        return;
      }
      console.warn('[PrimeTask] Task frontmatter sync failed', err);
    }
  }

  /**
   * Poll-side update. For every task in the locked space that has a
   * promoted note, check whether server-side fields (status, priority, due,
   * progress, project) diverge from the snapshot we last wrote. If yes,
   * rewrite the file's frontmatter block IN PLACE — body is preserved
   * verbatim so user edits below the header survive.
   *
   * Fetches the space's status + priority + project palettes once per
   * invocation so name-resolution is cheap regardless of how many task
   * files we're updating.
   */
  private async updateTaskFilesFromServer(tasks: PrimeTaskTask[], lockedSpaceId: string): Promise<void> {
    // Nothing to do if no task files are tracked.
    const taskFilePaths = Object.entries(this.state.files)
      .filter(([, s]) => s.type === 'task')
      .map(([p]) => p);
    if (taskFilePaths.length === 0) return;

    const client = this.plugin.connection.getClient();
    const [statuses, priorities, projects] = await Promise.all([
      client.listStatuses({ spaceId: lockedSpaceId }).catch((): PrimeTaskStatus[] => []),
      client.listPriorities({ spaceId: lockedSpaceId }).catch((): PrimeTaskPriority[] => []),
      client.listProjects({ spaceId: lockedSpaceId }).catch((): PrimeTaskProject[] => []),
    ]);
    const lockedSpace = this.plugin.spaces.find((s) => s.id === lockedSpaceId);

    // Flatten the tree once so subtasks (which live nested under their
    // parents) are reachable by the promoted-file lookup below. Without
    // this, the poll would never update subtask notes because the outer
    // loop only walks top-level tasks.
    const flatTasks: PrimeTaskTask[] = [];
    const flatten = (list: PrimeTaskTask[]) => {
      for (const t of list) {
        flatTasks.push(t);
        if (t.subtasks && t.subtasks.length) flatten(t.subtasks);
      }
    };
    flatten(tasks);

    for (const task of flatTasks) {
      // Find the tracked file for this task id. Only ONE file per task by
      // design — promote flows dedupe before creation. Accept both `task`
      // and `subtask` types; both carry task id semantics.
      const filePath = Object.entries(this.state.files).find(
        ([, s]) => (s.type === 'task' || s.type === 'subtask') && s.primetaskId === task.id,
      )?.[0];
      if (!filePath) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;
      const state = this.state.files[filePath];

      const statusEntry = statuses.find((s) => s.id === task.status);
      const priorityEntry = priorities.find((p) => p.id === task.priority);
      const projectEntry = task.projectId ? projects.find((p) => p.id === task.projectId) ?? null : null;

      // Parent resolution: re-evaluate every poll so a parent that gets
      // promoted to a note AFTER the subtask upgrades the `parent:` field
      // from plain string to `[[wikilink]]` automatically.
      const parentTask = task.parentId
        ? flatTasks.find((t) => t.id === task.parentId) ?? null
        : null;
      const parentPromotedFile = parentTask ? this.findFileByPrimetaskId(parentTask.id) : null;
      const parentSnapshotValue = parentPromotedFile?.basename ?? parentTask?.name ?? undefined;

      // Strip HTML once here so the diff compares plain text to plain text.
      // Server stores Tiptap HTML; we surface plain text in frontmatter.
      const serverDescription = stripDescriptionHtml(task.description);

      const serverIsComplete = statusEntry?.is_complete ?? false;
      const serverTagNames = Array.isArray(task.tags)
        ? task.tags.map((t) => t?.name).filter((n): n is string => typeof n === 'string' && n.length > 0)
        : [];
      const serverSnapshot = {
        status: statusEntry?.name ?? task.status,
        priority: priorityEntry?.name ?? task.priority,
        due: task.dueDate ?? undefined,
        progress: task.completionPercentage,
        project: projectEntry ? safeFilename(projectEntry.name) : undefined,
        description: serverDescription,
        done: serverIsComplete,
        tags: serverTagNames,
        parent: parentSnapshotValue,
        parentId: task.parentId ?? undefined,
      };
      const previous = state.frontmatterSnapshot ?? {};
      // Normalise null/undefined to a single value so the diff doesn't
      // spuriously flag `null !== undefined` as a change. Both mean "no
      // value" for our purposes; treating them as identical stops the
      // poll from rewriting the file (and bumping updated_at) every
      // cycle when the task hasn't actually changed.
      const norm = (v: unknown): unknown => (v === null ? undefined : v);
      // Tags compared by sorted name list — order doesn't matter for
      // semantic equality, and sorting on both sides prevents a PrimeTask-
      // side reorder from falsely triggering a rewrite every cycle.
      const tagsKey = (arr: string[] | undefined): string =>
        (arr ?? []).slice().sort().join('|');

      // Parent-state transition also counts as a diff (e.g. parent just got
      // promoted — we need to rewrite this subtask's frontmatter so `parent:`
      // becomes a live wikilink). Covers: parent null→present, parent
      // plain-string→wikilink, and parent re-parented server-side.
      const parentChanged =
        norm(previous.parent) !== norm(serverSnapshot.parent) ||
        norm(previous.parentId) !== norm(serverSnapshot.parentId) ||
        // Stored entity type flipping between task ↔ subtask also demands
        // a rewrite (primetask-type field goes stale otherwise).
        (state.type === 'subtask') !== !!task.parentId;

      const differs =
        norm(previous.status) !== norm(serverSnapshot.status) ||
        norm(previous.priority) !== norm(serverSnapshot.priority) ||
        // Due is compared by timestamp, not string — previous may hold
        // a local-naive string from the last file-read while the server
        // returns ISO UTC. Same instant, different format: treat as equal.
        !datetimesEqual(previous.due ?? null, serverSnapshot.due ?? null) ||
        norm(previous.progress) !== norm(serverSnapshot.progress) ||
        norm(previous.project) !== norm(serverSnapshot.project) ||
        (previous.description ?? '') !== (serverSnapshot.description ?? '') ||
        (previous.done ?? false) !== (serverSnapshot.done ?? false) ||
        tagsKey(previous.tags) !== tagsKey(serverSnapshot.tags) ||
        parentChanged;
      if (!differs) continue;

      try {
        // Read current file + parse existing frontmatter so we preserve
        // created_at (which MUST be immutable after the initial promote)
        // and can detect whether the resulting YAML actually differs.
        const currentContent = await this.plugin.app.vault.read(file);
        const { parseFrontmatter } = await import('./frontmatter');
        const currentFm = parseFrontmatter(currentContent).data;
        const preservedCreatedAt =
          typeof currentFm['created_at'] === 'string'
            ? (currentFm['created_at'] as string)
            : null;

        const rendered = renderTaskFile({
          task,
          project: projectEntry,
          spaceName: lockedSpace?.name ?? null,
          spaceId: lockedSpaceId,
          statusName: statusEntry?.name ?? null,
          priorityName: priorityEntry?.name ?? null,
          isComplete: serverIsComplete,
          // Preserve the original created_at stamped at promote time. If
          // the existing file somehow has no created_at (migrated from
          // an older schema), let the renderer default to now() — better
          // to have SOMETHING than nothing.
          createdAt: preservedCreatedAt,
          // updated_at bumps to now because we're actually writing new
          // data to the file (at least one field just changed per the
          // diff above). This is the legitimate reason to update it.
          parentId: task.parentId ?? null,
          parentName: parentTask?.name ?? null,
          parentFileStem: parentPromotedFile?.basename ?? null,
        });
        const fmData = parseFrontmatter(rendered.content).data;
        const nextContent = replaceFrontmatter(currentContent, fmData);
        if (nextContent === currentContent) continue;
        this.ownWrites.set(filePath, Date.now());
        await this.plugin.app.vault.modify(file, nextContent);
        state.frontmatterSnapshot = serverSnapshot;
        // Keep the persisted type in sync with whether a parent now exists.
        // Handles the edge case of a task gaining / losing a parent server-
        // side (rare but possible via PrimeTask UI).
        state.type = task.parentId ? 'subtask' : 'task';
      } catch (err) {
        console.warn('[PrimeTask] Failed to pull frontmatter update for task', task.id, err);
      }
    }
    await this.saveState();
  }

  /**
   * Poll-side refresh for user-promoted PROJECT notes. Server data for a
   * project (progress, health, counts, deadline, archive state) drifts over
   * time as tasks get completed, milestones move, etc. This method diffs
   * the last-known snapshot against current server state and rewrites the
   * project note's frontmatter block in place — body preserved verbatim
   * so any long-form notes the user added below the heading survive.
   *
   * Only runs on files the plugin owns as `type: 'project'`. Un-promoted
   * projects don't have a file to update. Arbitrary user notes are
   * ignored (state ownership gate).
   */
  private async updateProjectFilesFromServer(
    projects: PrimeTaskProject[],
    allTasks: PrimeTaskTask[],
    lockedSpaceId: string,
  ): Promise<void> {
    const projectFilePaths = Object.entries(this.state.files)
      .filter(([, s]) => s.type === 'project')
      .map(([p]) => p);
    if (projectFilePaths.length === 0) return;

    const lockedSpace = this.plugin.spaces.find((s) => s.id === lockedSpaceId);
    const { renderProjectFile, renderPromotedTasksBlock, PROMOTED_TASKS_MARKER_START, PROMOTED_TASKS_MARKER_END } = await import('./projectFile');
    const { parseFrontmatter } = await import('./frontmatter');
    const { replaceFrontmatter, replaceBodyBlock } = await import('./taskFile');

    // Flatten the task tree once so the project → promoted-tasks lookup
    // can check project membership in O(n) per project.
    const flatTasks: PrimeTaskTask[] = [];
    const flatten = (list: PrimeTaskTask[]) => {
      for (const t of list) {
        flatTasks.push(t);
        if (t.subtasks && t.subtasks.length) flatten(t.subtasks);
      }
    };
    flatten(allTasks);

    // Map of task id → promoted note basename. Only tasks that have been
    // promoted get picked up by project `promoted_tasks` lists.
    const promotedTaskIdToStem = new Map<string, string>();
    for (const [path, s] of Object.entries(this.state.files)) {
      if (s.type !== 'task' && s.type !== 'subtask') continue;
      const f = this.plugin.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) promotedTaskIdToStem.set(s.primetaskId, f.basename);
    }

    for (const project of projects) {
      const filePath = Object.entries(this.state.files).find(
        ([, s]) => s.type === 'project' && s.primetaskId === project.id,
      )?.[0];
      if (!filePath) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;
      const state = this.state.files[filePath];

      // Every task in this project that is itself a promoted note.
      const promotedTaskStems: string[] = [];
      for (const t of flatTasks) {
        if (t.projectId !== project.id) continue;
        const stem = promotedTaskIdToStem.get(t.id);
        if (stem) promotedTaskStems.push(stem);
      }
      promotedTaskStems.sort();

      const serverSnapshot = {
        status: project.status,
        health: project.health ?? null,
        progress: typeof project.overallProgress === 'number'
          ? project.overallProgress
          : (typeof project.progress === 'number' ? project.progress : 0),
        taskCount: project.taskCount,
        completedCount: project.completedCount,
        overdueCount: project.overdueCount,
        deadline: project.deadline ?? null,
        startDate: project.startDate ?? null,
        isArchived: !!project.isArchived,
        promotedTasks: promotedTaskStems,
      };

      const previous = state.projectSnapshot ?? {};
      const norm = (v: unknown): unknown => (v === null ? undefined : v);
      const stemsKey = (arr: string[] | undefined): string =>
        (arr ?? []).slice().sort().join('|');

      const differs =
        norm(previous.status) !== norm(serverSnapshot.status) ||
        norm(previous.health) !== norm(serverSnapshot.health) ||
        norm(previous.progress) !== norm(serverSnapshot.progress) ||
        norm(previous.taskCount) !== norm(serverSnapshot.taskCount) ||
        norm(previous.completedCount) !== norm(serverSnapshot.completedCount) ||
        norm(previous.overdueCount) !== norm(serverSnapshot.overdueCount) ||
        !datetimesEqual(previous.deadline ?? null, serverSnapshot.deadline ?? null) ||
        !datetimesEqual(previous.startDate ?? null, serverSnapshot.startDate ?? null) ||
        (previous.isArchived ?? false) !== (serverSnapshot.isArchived ?? false) ||
        stemsKey(previous.promotedTasks) !== stemsKey(serverSnapshot.promotedTasks);
      if (!differs) continue;

      try {
        const currentContent = await this.plugin.app.vault.read(file);
        const currentFm = parseFrontmatter(currentContent).data;
        const preservedCreatedAt =
          typeof currentFm['created_at'] === 'string'
            ? (currentFm['created_at'] as string)
            : null;

        const rendered = renderProjectFile({
          project,
          spaceName: lockedSpace?.name ?? null,
          spaceId: lockedSpaceId,
          createdAt: preservedCreatedAt,
          promotedTaskStems,
        });
        const fmData = parseFrontmatter(rendered.content).data;
        // Frontmatter regen (always). Body: only the marker-bounded
        // "Promoted tasks" block is owned by the plugin; everything
        // else the user wrote stays verbatim.
        let nextContent = replaceFrontmatter(currentContent, fmData);
        nextContent = replaceBodyBlock(
          nextContent,
          PROMOTED_TASKS_MARKER_START,
          PROMOTED_TASKS_MARKER_END,
          renderPromotedTasksBlock(promotedTaskStems),
        );
        if (nextContent === currentContent) {
          state.projectSnapshot = serverSnapshot;
          continue;
        }
        this.ownWrites.set(filePath, Date.now());
        await this.plugin.app.vault.modify(file, nextContent);
        state.projectSnapshot = serverSnapshot;
      } catch (err) {
        console.warn('[PrimeTask] Failed to pull frontmatter update for project', project.id, err);
      }
    }
    await this.saveState();
  }

  private resolveDoneStatusId(): string | null {
    // Send the semantic "done" token; the server resolves it to the
    // space's configured default complete status id. This lets the
    // plugin work with custom-status spaces where "Done" might literally
    // be called "Shipped" / "Closed" / etc.
    return 'done';
  }

  private resolveTodoStatusId(): string | null {
    return 'todo';
  }

  /**
   * Write the plugin-assigned id onto a freshly-created line. Optionally strips
   * the trailing #primetask trigger tag if the user used that flow.
   */
  private async finalizeCreatedLine(
    file: TFile,
    lineNumber: number,
    taskId: string,
    stripHashtag: boolean,
  ): Promise<void> {
    try {
      const content = await this.plugin.app.vault.read(file);
      const lines = content.split(/\r?\n/);
      if (lineNumber < 0 || lineNumber >= lines.length) return;
      let line = lines[lineNumber];
      if (/%%\s*pt:[a-zA-Z0-9_-]+\s*%%/.test(line)) return; // already has one
      if (stripHashtag) line = line.replace(/\s*#primetask\s*$/i, '');
      lines[lineNumber] = `${line.replace(/\s+$/, '')} %%pt:${taskId}%%`;
      this.ownWrites.set(file.path, Date.now());
      await this.plugin.app.vault.modify(file, lines.join('\n'));
    } catch (err) {
      console.warn('[PrimeTask] failed to finalize created line', err);
    }
  }

  /**
   * Promote selected text into a dedicated PrimeTask task note.
   *
   * Flow:
   *   1. Create the task in PrimeTask (space-scoped, project inherited if
   *      the source file is a project hub with primetask-id frontmatter).
   *   2. Render the task file at `<mirror>/Tasks/<safe-name>.md` with rich
   *      frontmatter + deep link body.
   *   3. Return the chosen filename stem so the caller can replace the
   *      editor selection with `[[<stem>]]`.
   *
   * The caller (`main.ts` editor-menu handler) owns the editor replacement
   * because it has the `Editor` reference and cursor range; the mirror only
   * touches the filesystem. Own-write marks are set for both files so the
   * vault watcher doesn't reconcile either write as a user edit.
   *
   * Returns null on failure (a Notice has already been shown to the user).
   */
  async promoteSelectionToTaskNote(selection: string, sourceFile: TFile): Promise<{
    filenameStem: string;
    relativePath: string;
    taskId: string;
  } | null> {
    const name = selection.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (name.length < MIN_TASK_NAME_LENGTH) {
      new Notice('Selection is too short to be a task');
      return null;
    }
    if (!this.plugin.settings.mirrorEnabled) {
      new Notice('Enable markdown mirror first to create task notes');
      return null;
    }
    const lockedSpaceId = this.plugin.settings.defaultSpaceId;
    if (!lockedSpaceId) {
      new Notice('Select a Locked Space in settings first');
      return null;
    }

    // Inherit project context when the user is promoting from inside a
    // project hub file (its frontmatter identifies its primetask-id).
    let projectId: string | null = null;
    try {
      const srcContent = await this.plugin.app.vault.read(sourceFile);
      const parsed = parseMirrorFile(srcContent);
      projectId = extractProjectId(parsed.frontmatter);
    } catch {
      // Non-mirror file (e.g. daily note) — no project inherited, task is
      // created as an Inbox task. User can set project via frontmatter later.
    }

    try {
      const client = this.plugin.connection.getClient();

      // Fetch the space's status + priority palettes up front so we can:
      //   1. Send concrete default-status / default-priority IDs when
      //      creating (more predictable than sending the semantic 'todo'
      //      literal and letting the server map it).
      //   2. Populate the frontmatter with human-friendly names, not UUIDs,
      //      so Obsidian's Properties panel + Bases show readable values.
      // Failures here are non-fatal — we fall back to the semantic literal.
      const [statuses, priorities] = await Promise.all([
        client.listStatuses({ spaceId: lockedSpaceId }).catch((): PrimeTaskStatus[] => []),
        client.listPriorities({ spaceId: lockedSpaceId }).catch((): PrimeTaskPriority[] => []),
      ]);
      const defaultTodoStatus = statuses.find((s) => s.is_default && !s.is_complete)
        ?? statuses.find((s) => !s.is_complete)
        ?? null;
      const defaultPriority = priorities.find((p) => p.is_default) ?? priorities[0] ?? null;

      const initialStatusId = defaultTodoStatus?.id ?? this.resolveTodoStatusId() ?? 'todo';
      const initialPriorityId = defaultPriority?.id;

      const created = await client.createTask({
        name,
        projectId: projectId ?? undefined,
        status: initialStatusId,
        priority: initialPriorityId,
        spaceId: lockedSpaceId,
      }) as { id?: string; name?: string };
      if (!created?.id) {
        new Notice('PrimeTask did not return a task id — create failed');
        return null;
      }

      // Resolve locked space name + project name for the wikilinks in the
      // task file. listProjects is cheap; we do one call per promote rather
      // than keep stale state around.
      const lockedSpace = this.plugin.spaces.find((s) => s.id === lockedSpaceId);
      let project: PrimeTaskProject | null = null;
      if (projectId) {
        try {
          const projects = await client.listProjects({ spaceId: lockedSpaceId });
          project = projects.find((p) => p.id === projectId) ?? null;
        } catch {
          // Non-fatal — file will have the projectId only, no wikilink name.
        }
      }

      // Build a local task stub for the renderer. We don't roundtrip through
      // list_tasks because we already know what we just created.
      const taskStub: PrimeTaskTask = {
        id: created.id,
        name,
        status: initialStatusId,
        priority: initialPriorityId ?? '',
        dueDate: null,
        completionPercentage: 0,
        projectId: projectId,
        parentId: null,
        subtaskCount: 0,
        subtasks: [],
        tags: [],
      };

      const rendered = renderTaskFile({
        task: taskStub,
        project,
        spaceName: lockedSpace?.name ?? null,
        spaceId: lockedSpaceId,
        statusName: defaultTodoStatus?.name ?? null,
        priorityName: defaultPriority?.name ?? null,
        // A just-created task from selection always starts incomplete.
        isComplete: false,
        // Basename of the note the user promoted FROM. Becomes an
        // `origin: [[...]]` frontmatter backlink + a "Captured from [[...]]"
        // body line. Obsidian's graph + backlinks pane take it from there.
        originBasename: sourceFile.basename,
      });

      const mirrorRoot = (this.plugin.settings.mirrorFolder || 'PrimeTask').replace(/\/+$/, '');
      await this.ensureFolder(mirrorRoot);
      await this.ensureFolder(`${mirrorRoot}/Tasks`);

      // Collision resolution: if a file with the same stem already exists,
      // suffix `(2)`, `(3)`, ... The primetask-id in frontmatter is the real
      // identity, so filename collisions don't break anything — they're just
      // aesthetically bad.
      const taken = new Set<string>();
      const tasksFolder = this.plugin.app.vault.getAbstractFileByPath(normalizePath(`${mirrorRoot}/Tasks`));
      if (tasksFolder && 'children' in tasksFolder) {
        for (const child of (tasksFolder as any).children ?? []) {
          if (child instanceof TFile && child.extension === 'md') {
            taken.add(child.basename);
          }
        }
      }
      const finalStem = dedupeFilename(rendered.filenameStem, taken);
      const finalPath = normalizePath(`${mirrorRoot}/Tasks/${finalStem}.md`);

      // Mark as own-write BEFORE creating so the vault watcher doesn't fire
      // a reconcile on the create event.
      this.ownWrites.set(finalPath, Date.now());
      await this.plugin.app.vault.create(finalPath, rendered.content);

      // Track in state so future frontmatter edits diff correctly.
      // Seed the snapshot with the values we JUST wrote — future Obsidian
      // edits diff against this to know what to PATCH back to PrimeTask.
      this.state.files[finalPath] = {
        path: finalPath,
        primetaskId: created.id,
        type: 'task',
        mtime: Date.now(),
        checkboxes: {},
        frontmatterSnapshot: {
          status: defaultTodoStatus?.name ?? undefined,
          priority: defaultPriority?.name ?? undefined,
          due: undefined,
          progress: 0,
          project: project ? safeFilename(project.name) : undefined,
          description: '',
          done: false,
          tags: [],
        },
      };
      await this.saveState();

      new Notice(`Promoted to task note: ${finalStem}`);
      this.plugin.app.workspace.trigger('primetask:refresh');

      return {
        filenameStem: finalStem,
        relativePath: finalPath,
        taskId: created.id,
      };
    } catch (err) {
      if (err instanceof SpaceMismatchError) {
        new Notice(`PrimeTask: Switch to your locked space in PrimeTask first. (${err.message})`);
        return null;
      }
      new Notice(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Mark a path as a recent own-write so the vault watcher skips reconciling
   * the resulting `modify` event. Exposed for callers that mutate the source
   * editor (inserting the wikilink after a promote).
   */
  markOwnWrite(path: string): void {
    this.ownWrites.set(path, Date.now());
  }

  /**
   * Promote an EXISTING PrimeTask task (from the sidebar) to its own `.md`
   * file. Unlike `promoteSelectionToTaskNote`, this does NOT create anything
   * in PrimeTask — the task already exists. It just materialises the file
   * with the current server-side state (status, priority, project, etc.).
   *
   * Intended use: user right-clicks a task in the sidebar and chooses
   * "Promote to task note" because they want that task to be a graph node
   * and have a long-form surface to think about it in. Returns the written
   * file on success so the caller can open it.
   */
  async promoteExistingTaskToNote(task: PrimeTaskTask): Promise<TFile | null> {
    if (!this.plugin.settings.mirrorEnabled) {
      new Notice('Enable markdown mirror first to create task notes');
      return null;
    }
    const lockedSpaceId = this.plugin.settings.defaultSpaceId;
    if (!lockedSpaceId) {
      new Notice('Select a Locked Space in settings first');
      return null;
    }

    try {
      const client = this.plugin.connection.getClient();
      // Resolve status + priority names against the locked space's config so
      // frontmatter reads as "In Progress" / "High", not opaque UUIDs.
      const [statuses, priorities] = await Promise.all([
        client.listStatuses({ spaceId: lockedSpaceId }).catch((): PrimeTaskStatus[] => []),
        client.listPriorities({ spaceId: lockedSpaceId }).catch((): PrimeTaskPriority[] => []),
      ]);
      const statusEntry = statuses.find((s) => s.id === task.status) ?? null;
      const priorityEntry = priorities.find((p) => p.id === task.priority) ?? null;

      // Resolve project wikilink target name if the task belongs to one.
      const lockedSpace = this.plugin.spaces.find((s) => s.id === lockedSpaceId);
      let project: PrimeTaskProject | null = null;
      if (task.projectId) {
        try {
          const projects = await client.listProjects({ spaceId: lockedSpaceId });
          project = projects.find((p) => p.id === task.projectId) ?? null;
        } catch {
          // Non-fatal.
        }
      }

      // Subtask: resolve parent so we can wire parent + origin to point at
      // the PARENT task rather than the space hub. The parent may or may
      // not itself be promoted to a note — we handle both cases by passing
      // `parentName` always and `parentFileStem` only when a note exists.
      let parentTask: PrimeTaskTask | null = null;
      if (task.parentId) {
        try {
          const tree = await client.listTasks({ spaceId: lockedSpaceId });
          parentTask = findTaskInTree(tree, task.parentId);
        } catch {
          // Non-fatal — frontmatter will render without a wikilink.
        }
      }
      const parentPromotedFile = parentTask ? this.findFileByPrimetaskId(parentTask.id) : null;

      const promoteDate = new Date().toISOString().slice(0, 10);
      const rendered = renderTaskFile({
        task,
        project,
        spaceName: lockedSpace?.name ?? null,
        spaceId: lockedSpaceId,
        statusName: statusEntry?.name ?? null,
        priorityName: priorityEntry?.name ?? null,
        // Derive completion state from the space's status config — "done"
        // in one space might be literally named "Shipped" in another, so
        // we can't hardcode. isComplete is the authoritative flag.
        isComplete: statusEntry?.is_complete ?? false,
        // Sidebar promotion: origin is the space hub itself. We use the
        // prefixed filename stem (`PrimeTask - <SpaceName>`) so it resolves
        // to the real hub file, not a potentially-colliding user note.
        // For subtasks, renderTaskFile overrides origin to the parent task.
        originBasename: lockedSpace?.name
          ? `PrimeTask - ${safeFilename(lockedSpace.name)}`
          : null,
        captureDate: promoteDate,
        parentId: task.parentId ?? null,
        parentName: parentTask?.name ?? null,
        parentFileStem: parentPromotedFile?.basename ?? null,
      });

      const mirrorRoot = (this.plugin.settings.mirrorFolder || 'PrimeTask').replace(/\/+$/, '');
      await this.ensureFolder(mirrorRoot);
      await this.ensureFolder(`${mirrorRoot}/Tasks`);

      // Check if a file for this task already exists (same primetask-id in
      // frontmatter). If so, just open it instead of creating a duplicate.
      const existing = this.findFileByPrimetaskId(task.id);
      if (existing) {
        new Notice(`Task note already exists — opening ${existing.basename}`);
        return existing;
      }

      // Collision resolution on filename only (primetask-id is the real identity).
      const taken = new Set<string>();
      const tasksFolder = this.plugin.app.vault.getAbstractFileByPath(normalizePath(`${mirrorRoot}/Tasks`));
      if (tasksFolder && 'children' in tasksFolder) {
        for (const child of (tasksFolder as any).children ?? []) {
          if (child instanceof TFile && child.extension === 'md') {
            taken.add(child.basename);
          }
        }
      }
      const finalStem = dedupeFilename(rendered.filenameStem, taken);
      const finalPath = normalizePath(`${mirrorRoot}/Tasks/${finalStem}.md`);

      this.ownWrites.set(finalPath, Date.now());
      const created = await this.plugin.app.vault.create(finalPath, rendered.content);

      this.state.files[finalPath] = {
        path: finalPath,
        primetaskId: task.id,
        type: task.parentId ? 'subtask' : 'task',
        mtime: Date.now(),
        checkboxes: {},
        frontmatterSnapshot: {
          status: statusEntry?.name ?? task.status,
          priority: priorityEntry?.name ?? task.priority,
          due: task.dueDate ?? undefined,
          progress: task.completionPercentage,
          project: project ? safeFilename(project.name) : undefined,
          // Description we just wrote into the file — plain-text form so
          // the snapshot compares like-for-like with future edits.
          description: stripDescriptionHtml(task.description),
          done: statusEntry?.is_complete ?? false,
          tags: Array.isArray(task.tags)
            ? task.tags.map((t) => t?.name).filter((n): n is string => typeof n === 'string' && n.length > 0)
            : [],
          parent: parentPromotedFile?.basename ?? parentTask?.name ?? undefined,
          parentId: task.parentId ?? undefined,
        },
      };
      await this.saveState();

      new Notice(`Promoted to task note: ${finalStem}`);
      // Kick a sidebar refresh so the new note badge + filter recompute,
      // and the space hub's promoted_tasks list picks up the new entry on
      // the next sync cycle.
      this.plugin.app.workspace.trigger('primetask:refresh');
      return created;
    } catch (err) {
      if (err instanceof SpaceMismatchError) {
        new Notice(`PrimeTask: Switch to your locked space in PrimeTask first. (${err.message})`);
        return null;
      }
      new Notice(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Promote an existing PrimeTask PROJECT (from the sidebar) to its own
   * `.md` file at `<mirror>/Projects/<name>.md`. The project itself is
   * not mutated; the plugin just materialises the file with current
   * server-side state (status, progress, health, counts, deadline, etc).
   *
   * Optional `includeTasks: true` cascades a promote over every task +
   * subtask in the project, creating a full graph of notes in one click.
   * Used for big projects where the user wants the whole working set as
   * linked notes without clicking each task individually.
   *
   * Returns the created file on success so the caller can open it.
   * Returns null on any non-fatal failure (user is notified via Notice).
   */
  async promoteExistingProjectToNote(
    project: PrimeTaskProject,
    opts: { includeTasks?: boolean } = {},
  ): Promise<TFile | null> {
    if (!this.plugin.settings.mirrorEnabled) {
      new Notice('Enable markdown mirror first to create project notes');
      return null;
    }
    const lockedSpaceId = this.plugin.settings.defaultSpaceId;
    if (!lockedSpaceId) {
      new Notice('Select a Locked Space in settings first');
      return null;
    }

    try {
      const lockedSpace = this.plugin.spaces.find((s) => s.id === lockedSpaceId);

      // Dedupe: if a project note already exists for this id, open it
      // rather than creating a second one.
      const existing = this.findFileByPrimetaskId(project.id);
      if (existing) {
        new Notice(`Project note already exists — opening ${existing.basename}`);
        if (opts.includeTasks) {
          await this.cascadePromoteProjectTasks(project.id, lockedSpaceId);
        }
        return existing;
      }

      const { renderProjectFile } = await import('./projectFile');
      const rendered = renderProjectFile({
        project,
        spaceName: lockedSpace?.name ?? null,
        spaceId: lockedSpaceId,
        // No promoted tasks yet at creation — the space hub + future
        // poll-update populate this list as tasks get promoted.
        promotedTaskStems: [],
      });

      const mirrorRoot = (this.plugin.settings.mirrorFolder || 'PrimeTask').replace(/\/+$/, '');
      await this.ensureFolder(mirrorRoot);
      await this.ensureFolder(`${mirrorRoot}/Projects`);

      // Collision resolution on filename only — primetask-id is the real
      // identity so collisions are cosmetic, but we still suffix `(2)`
      // rather than overwrite a same-named user file.
      const taken = new Set<string>();
      const projectsFolder = this.plugin.app.vault.getAbstractFileByPath(normalizePath(`${mirrorRoot}/Projects`));
      if (projectsFolder && 'children' in projectsFolder) {
        for (const child of (projectsFolder as any).children ?? []) {
          if (child instanceof TFile && child.extension === 'md') {
            taken.add(child.basename);
          }
        }
      }
      const finalStem = dedupeFilename(rendered.filenameStem, taken);
      const finalPath = normalizePath(`${mirrorRoot}/Projects/${finalStem}.md`);

      this.ownWrites.set(finalPath, Date.now());
      const created = await this.plugin.app.vault.create(finalPath, rendered.content);

      // Seed state with a snapshot of the values we just wrote so the
      // poll-side update can diff and skip redundant rewrites.
      this.state.files[finalPath] = {
        path: finalPath,
        primetaskId: project.id,
        type: 'project',
        mtime: Date.now(),
        checkboxes: {},
        projectSnapshot: {
          status: project.status,
          health: project.health ?? null,
          progress: typeof project.overallProgress === 'number'
            ? project.overallProgress
            : (typeof project.progress === 'number' ? project.progress : 0),
          taskCount: project.taskCount,
          completedCount: project.completedCount,
          overdueCount: project.overdueCount,
          deadline: project.deadline ?? null,
          startDate: project.startDate ?? null,
          isArchived: !!project.isArchived,
          promotedTasks: [],
        },
      };
      await this.saveState();

      new Notice(`Promoted project to note: ${finalStem}`);

      if (opts.includeTasks) {
        await this.cascadePromoteProjectTasks(project.id, lockedSpaceId);
      }

      this.plugin.app.workspace.trigger('primetask:refresh');
      return created;
    } catch (err) {
      if (err instanceof SpaceMismatchError) {
        new Notice(`PrimeTask: Switch to your locked space in PrimeTask first. (${err.message})`);
        return null;
      }
      new Notice(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Fetch every task under a given project and promote each one (and its
   * subtasks recursively) to a task note. Skips anything already promoted.
   * Used by `promoteExistingProjectToNote({ includeTasks: true })`.
   */
  private async cascadePromoteProjectTasks(projectId: string, lockedSpaceId: string): Promise<void> {
    try {
      const client = this.plugin.connection.getClient();
      const tree = await client.listTasks({ spaceId: lockedSpaceId });
      const projectTasks = tree.filter((t) => t.projectId === projectId);
      const flat: PrimeTaskTask[] = [];
      const flatten = (list: PrimeTaskTask[]) => {
        for (const t of list) {
          flat.push(t);
          if (t.subtasks && t.subtasks.length) flatten(t.subtasks);
        }
      };
      flatten(projectTasks);
      let promoted = 0;
      for (const task of flat) {
        if (this.findFileByPrimetaskId(task.id)) continue; // already promoted
        const created = await this.promoteExistingTaskToNote(task);
        if (created) promoted += 1;
      }
      if (promoted > 0) {
        new Notice(`Promoted ${promoted} task${promoted === 1 ? '' : 's'} under project`);
      }
    } catch (err) {
      console.warn('[PrimeTask] Cascade promote failed', err);
    }
  }

  /**
   * Look up an existing mirror file by its PrimeTask entity id. Reads from
   * the in-memory state; returns null if no file is tracked for this id.
   * Used by the sidebar to mark promoted tasks with a badge, and to avoid
   * creating duplicate task notes when the user clicks Promote twice.
   *
   * Public so UI surfaces (TasksView) can render "has note" indicators
   * without reaching into state directly.
   */
  findFileByPrimetaskId(primetaskId: string): TFile | null {
    for (const [path, state] of Object.entries(this.state.files)) {
      if (state.primetaskId !== primetaskId) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return file;
    }
    return null;
  }

  /**
   * Build a Set of PrimeTask task ids that currently have a mirrored note
   * file. Cheap enough to recompute per render — state.files typically has
   * dozens of entries, not thousands, because files are user-curated.
   * Includes both `task` and `subtask` types; both carry the same id
   * semantics and should be treated as "promoted" for badge / filter use.
   */
  getPromotedTaskIds(): Set<string> {
    const out = new Set<string>();
    for (const state of Object.values(this.state.files)) {
      if (state.type === 'task' || state.type === 'subtask') out.add(state.primetaskId);
    }
    return out;
  }

  /**
   * Same as `getPromotedTaskIds` but for projects. Lets UI surfaces render
   * a "has note" badge on project rows and gate the has-note filter on
   * the Projects tab.
   */
  getPromotedProjectIds(): Set<string> {
    const out = new Set<string>();
    for (const state of Object.values(this.state.files)) {
      if (state.type === 'project') out.add(state.primetaskId);
    }
    return out;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (this.plugin.app.vault.getAbstractFileByPath(normalized)) return;
    try {
      await this.plugin.app.vault.createFolder(normalized);
    } catch {
      // Race — ignore if it exists now.
      if (!this.plugin.app.vault.getAbstractFileByPath(normalized)) throw new Error(`Could not create folder ${normalized}`);
    }
  }

  /**
   * Convert an existing note into a PrimeTask TASK in place. The note's
   * H1 heading (or filename) becomes the task name; body content becomes
   * the task description (plain text stripped to one paragraph). Plugin
   * frontmatter (primetask-id, status, etc) is injected above the user's
   * existing frontmatter — non-PrimeTask properties the user had set
   * (aliases, cssclasses, custom keys) are preserved.
   *
   * Guards:
   *   - File must NOT already carry a `primetask-id` (would be a double-
   *     promotion).
   *   - File must NOT be a plugin-generated hub (app / space / inbox /
   *     guide). Converting one of those would corrupt the plugin state.
   *
   * Returns the same file on success so the caller can reveal / open it.
   */
  async convertNoteToTask(file: TFile): Promise<TFile | null> {
    return this.convertNoteToEntity(file, 'task');
  }

  /**
   * Convert an existing note into a PrimeTask PROJECT in place. Same
   * semantics as `convertNoteToTask` but the entity is a project. Useful
   * for long-form planning docs that should become a project container
   * for future tasks, milestones, and goals.
   */
  async convertNoteToProject(file: TFile): Promise<TFile | null> {
    return this.convertNoteToEntity(file, 'project');
  }

  private async convertNoteToEntity(file: TFile, kind: 'task' | 'project'): Promise<TFile | null> {
    if (!this.plugin.settings.mirrorEnabled) {
      new Notice('Enable markdown mirror first to convert notes');
      return null;
    }
    const lockedSpaceId = this.plugin.settings.defaultSpaceId;
    if (!lockedSpaceId) {
      new Notice('Select a Locked Space in settings first');
      return null;
    }

    const { parseFrontmatter } = await import('./frontmatter');
    const { replaceFrontmatter, replaceBodyBlock, injectLineAfterH1 } = await import('./taskFile');
    const {
      renderPromotedTasksBlock,
      PROMOTED_TASKS_MARKER_START,
      PROMOTED_TASKS_MARKER_END,
    } = await import('./projectFile');

    const currentContent = await this.plugin.app.vault.read(file);
    const parsed = parseFrontmatter(currentContent);

    if (typeof parsed.data['primetask-id'] === 'string' && parsed.data['primetask-id'].length > 0) {
      new Notice('This note is already a PrimeTask entity.');
      return null;
    }
    const existingState = this.state.files[file.path];
    if (existingState && existingState.type !== 'task' && existingState.type !== 'subtask' && existingState.type !== 'project') {
      new Notice('This file is a plugin-generated hub and can\'t be converted.');
      return null;
    }

    // Extract name from H1 in body, else filename. Falls back to a safe
    // default if both are empty.
    const body = currentContent.slice(parsed.bodyStart);
    const h1Match = body.match(/^[ \t]*#\s+(.+)$/m);
    const name = (h1Match?.[1]?.trim() || file.basename || 'Untitled').slice(0, 500);

    // Description: everything after the H1 (or whole body if no H1),
    // stripped to plain text. Bounded to keep the first write small;
    // server accepts larger edits later via normal sync.
    const descriptionRaw = h1Match
      ? body.slice((h1Match.index ?? 0) + h1Match[0].length)
      : body;
    const description = descriptionRaw
      .replace(/\r\n/g, '\n')
      .replace(/```[\s\S]*?```/g, '')   // strip code fences
      .replace(/`[^`]+`/g, '')           // strip inline code
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // strip image refs
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // unwrap links
      .replace(/[*_~>#-]+/g, ' ')        // strip markdown sigils
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);

    try {
      const client = this.plugin.connection.getClient();
      const lockedSpace = this.plugin.spaces.find((s) => s.id === lockedSpaceId);
      let nextContent: string;
      let snapshotType: 'task' | 'project';

      if (kind === 'task') {
        const [statuses, priorities] = await Promise.all([
          client.listStatuses({ spaceId: lockedSpaceId }).catch((): PrimeTaskStatus[] => []),
          client.listPriorities({ spaceId: lockedSpaceId }).catch((): PrimeTaskPriority[] => []),
        ]);
        const defaultTodoStatus = statuses.find((s) => s.is_default && !s.is_complete)
          ?? statuses.find((s) => !s.is_complete)
          ?? null;
        const defaultPriority = priorities.find((p) => p.is_default) ?? priorities[0] ?? null;
        const initialStatusId = defaultTodoStatus?.id ?? this.resolveTodoStatusId() ?? 'todo';
        const initialPriorityId = defaultPriority?.id;

        const created = await client.createTask({
          name,
          description,
          status: initialStatusId,
          priority: initialPriorityId,
          spaceId: lockedSpaceId,
        }) as { id?: string };
        if (!created?.id) {
          new Notice('PrimeTask did not return a task id — create failed');
          return null;
        }

        const taskStub: PrimeTaskTask = {
          id: created.id,
          name,
          status: initialStatusId,
          priority: initialPriorityId ?? '',
          dueDate: null,
          completionPercentage: 0,
          projectId: null,
          parentId: null,
          subtaskCount: 0,
          subtasks: [],
          tags: [],
          description,
        };
        const rendered = renderTaskFile({
          task: taskStub,
          project: null,
          spaceName: lockedSpace?.name ?? null,
          spaceId: lockedSpaceId,
          statusName: defaultTodoStatus?.name ?? null,
          priorityName: defaultPriority?.name ?? null,
          isComplete: false,
          originBasename: null,
        });
        const fmData = parseFrontmatter(rendered.content).data;
        // Merge: preserve user's non-PrimeTask frontmatter keys; our keys
        // win on overlap (they're the ones we sync).
        const merged = this.mergeFrontmatter(parsed.data, fmData);
        nextContent = replaceFrontmatter(currentContent, merged);
        // Inject the "[Open in PrimeTask]" deep link into the body right
        // after the H1 so the converted note carries the same affordance
        // as a freshly promoted task note.
        const deepLink = typeof fmData['primetask-url'] === 'string' ? fmData['primetask-url'] : null;
        if (deepLink) {
          nextContent = injectLineAfterH1(nextContent, `[Open in PrimeTask](${deepLink})`);
        }
        snapshotType = 'task';

        this.state.files[file.path] = {
          path: file.path,
          primetaskId: created.id,
          type: 'task',
          mtime: Date.now(),
          checkboxes: {},
          frontmatterSnapshot: {
            status: defaultTodoStatus?.name ?? undefined,
            priority: defaultPriority?.name ?? undefined,
            due: undefined,
            progress: 0,
            description,
            done: false,
            tags: [],
          },
        };
      } else {
        const created = await client.createProject({
          name,
          description,
          spaceId: lockedSpaceId,
        });
        if (!created?.id) {
          new Notice('PrimeTask did not return a project id — create failed');
          return null;
        }
        const projectStub: PrimeTaskProject = {
          id: created.id,
          name,
          color: null,
          status: 'active',
          description,
          taskCount: 0,
          completedCount: 0,
          overdueCount: 0,
          progress: 0,
          overallProgress: 0,
          health: null,
          deadline: null,
          startDate: null,
          isArchived: false,
        };
        const { renderProjectFile } = await import('./projectFile');
        const rendered = renderProjectFile({
          project: projectStub,
          spaceName: lockedSpace?.name ?? null,
          spaceId: lockedSpaceId,
          promotedTaskStems: [],
        });
        const fmData = parseFrontmatter(rendered.content).data;
        const merged = this.mergeFrontmatter(parsed.data, fmData);
        nextContent = replaceFrontmatter(currentContent, merged);
        // Inject the "[Open in PrimeTask]" link + the marker-bounded
        // "Promoted tasks" block into the user's existing body. Link
        // sits right after the H1; the block appends to the body (user
        // content above/below stays intact). Subsequent poll refreshes
        // only rewrite the bounded block, never the user's own content.
        const deepLink = typeof fmData['primetask-url'] === 'string' ? fmData['primetask-url'] : null;
        if (deepLink) {
          nextContent = injectLineAfterH1(nextContent, `[Open in PrimeTask](${deepLink})`);
        }
        nextContent = replaceBodyBlock(
          nextContent,
          PROMOTED_TASKS_MARKER_START,
          PROMOTED_TASKS_MARKER_END,
          renderPromotedTasksBlock([]),
        );
        snapshotType = 'project';

        this.state.files[file.path] = {
          path: file.path,
          primetaskId: created.id,
          type: 'project',
          mtime: Date.now(),
          checkboxes: {},
          projectSnapshot: {
            status: 'active',
            health: null,
            progress: 0,
            taskCount: 0,
            completedCount: 0,
            overdueCount: 0,
            deadline: null,
            startDate: null,
            isArchived: false,
            promotedTasks: [],
          },
        };
      }

      this.ownWrites.set(file.path, Date.now());
      await this.plugin.app.vault.modify(file, nextContent);
      await this.saveState();

      new Notice(`Converted note to PrimeTask ${snapshotType}: ${name}`);
      this.plugin.app.workspace.trigger('primetask:refresh');
      return file;
    } catch (err) {
      if (err instanceof SpaceMismatchError) {
        new Notice(`PrimeTask: Switch to your locked space in PrimeTask first. (${err.message})`);
        return null;
      }
      new Notice(`Convert failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Merge user's existing frontmatter with plugin-generated frontmatter.
   * PrimeTask-specific keys (primetask-*, status, priority, due, etc) are
   * overwritten by the plugin's values; other keys the user had (aliases,
   * cssclasses, custom properties) are preserved untouched.
   */
  private mergeFrontmatter(
    existing: Record<string, unknown>,
    ours: Record<string, unknown>,
  ): Record<string, unknown> {
    // Keys we own — we always set these from ours, never from the user.
    const ownedKeys = new Set<string>([
      'primetask-id', 'primetask-type', 'primetask-url', 'primetask-parent-id',
      'space', 'project', 'parent', 'origin',
      'status', 'priority', 'due', 'progress', 'tags', 'description', 'done',
      'health', 'task_count', 'completed_count', 'overdue_count',
      'deadline', 'start_date', 'is_archived',
      'promoted_tasks', 'promoted_projects',
      'created_at', 'updated_at', 'mirrored_at',
      'is_shared',
    ]);
    const merged: Record<string, unknown> = {};
    // Start with user's non-owned keys so their ordering is preserved.
    for (const [k, v] of Object.entries(existing)) {
      if (!ownedKeys.has(k)) merged[k] = v;
    }
    // Layer our keys on top.
    for (const [k, v] of Object.entries(ours)) {
      merged[k] = v;
    }
    return merged;
  }

  /**
   * Create a task in PrimeTask's Inbox from arbitrary selected text.
   * Does NOT touch the user's note — the selection stays as plain text
   * in its original context. Useful for "I wrote a thought in daily notes,
   * make it a PrimeTask task" without converting the line into a checkbox.
   */
  async sendSelectionToInbox(text: string): Promise<void> {
    const name = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (name.length < MIN_TASK_NAME_LENGTH) {
      new Notice('Selection is too short to be a task');
      return;
    }
    try {
      const client = this.plugin.connection.getClient();
      await client.createTask({
        name,
        status: this.resolveTodoStatusId() ?? undefined,
        spaceId: this.plugin.settings.defaultSpaceId ?? undefined,
        // No projectId — lands in Inbox
      });
      new Notice(`Added to PrimeTask Inbox: "${name.slice(0, 60)}${name.length > 60 ? '…' : ''}"`);
      this.plugin.app.workspace.trigger('primetask:refresh');
    } catch (err) {
      if (err instanceof SpaceMismatchError) {
        new Notice(`PrimeTask: Switch to your locked space in PrimeTask first. (${err.message})`);
        return;
      }
      new Notice(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Public entry point called by the right-click menu / command palette.
   * Sends the checkbox line at the given position to PrimeTask explicitly.
   */
  async sendLineToPrimeTask(file: TFile, lineNumber: number, lineText: string): Promise<void> {
    const m = lineText.match(/^(\s*)- \[([ xX])\]\s?(.*?)(?:\s*(?:<!--\s*pt:[a-zA-Z0-9_-]+\s*-->|%%\s*pt:[a-zA-Z0-9_-]+\s*%%))?\s*$/);
    if (!m) {
      new Notice('Cursor is not on a checkbox line');
      return;
    }
    const name = m[3].trim().replace(/\s*#primetask\s*$/i, '');
    if (name.length < MIN_TASK_NAME_LENGTH) {
      new Notice('Task name is too short');
      return;
    }
    // If the line already has an id comment, skip.
    if (/(<!--\s*pt:[a-zA-Z0-9_-]+\s*-->|%%\s*pt:[a-zA-Z0-9_-]+\s*%%)/.test(lineText)) {
      new Notice('This task is already synced');
      return;
    }
    // Determine project id from the file's frontmatter if it's a project file.
    let projectId: string | null = null;
    if (this.isInMirrorFolder(file.path)) {
      try {
        const content = await this.plugin.app.vault.read(file);
        const parsed = parseMirrorFile(content);
        projectId = extractProjectId(parsed.frontmatter);
      } catch {}
    }
    try {
      const client = this.plugin.connection.getClient();
      const done = m[2].toLowerCase() === 'x';
      const newTask = await client.createTask({
        name,
        projectId: projectId ?? undefined,
        status: done ? (this.resolveDoneStatusId() ?? undefined) : (this.resolveTodoStatusId() ?? undefined),
        spaceId: this.plugin.settings.defaultSpaceId ?? undefined,
      }) as { id?: string };
      if (newTask?.id) {
        await this.finalizeCreatedLine(file, lineNumber, newTask.id, /#primetask/i.test(lineText));
        new Notice('Task created in PrimeTask');
        this.plugin.app.workspace.trigger('primetask:refresh');
      }
    } catch (err) {
      if (err instanceof SpaceMismatchError) {
        new Notice(`PrimeTask: Switch to your locked space in PrimeTask first. (${err.message})`);
        return;
      }
      new Notice(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.isInMirrorFolder(file.path) && !this.isInMirrorFolder(oldPath)) return;
    // Migrate state entry from old path to new.
    const prev = this.state.files[oldPath];
    if (prev) {
      this.state.files[file.path] = { ...prev, path: file.path };
      delete this.state.files[oldPath];
      await this.saveState();
    }
  }

  private async handleDelete(file: TAbstractFile): Promise<void> {
    if (!this.isInMirrorFolder(file.path)) return;
    const prev = this.state.files[file.path];
    if (!prev) return;

    // User deleted a mirror file entirely. We DON'T delete the corresponding
    // PrimeTask entity — too destructive. We just clear state so the next
    // sync pass regenerates it.
    delete this.state.files[file.path];
    await this.saveState();
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  private async loadState(): Promise<void> {
    const all = (await this.plugin.loadData()) || {};
    const persisted = (all as any)[MIRROR_STATE_KEY];
    if (persisted && typeof persisted === 'object' && persisted.version === 1) {
      this.state = { ...DEFAULT_MIRROR_STATE, ...persisted };
    } else {
      this.state = { ...DEFAULT_MIRROR_STATE };
    }
  }

  private async saveState(): Promise<void> {
    const all = (await this.plugin.loadData()) || {};
    (all as any)[MIRROR_STATE_KEY] = this.state;
    await this.plugin.saveData(all);
  }
}

/**
 * Depth-first search a nested task tree for the task with the given id.
 * Returns null when no match is found. Used by subtask promotion to
 * resolve the parent's full task object (name, projectId) from the flat
 * id reference on a subtask.
 */
function findTaskInTree(tasks: PrimeTaskTask[], id: string): PrimeTaskTask | null {
  for (const t of tasks) {
    if (t.id === id) return t;
    if (t.subtasks && t.subtasks.length) {
      const hit = findTaskInTree(t.subtasks, id);
      if (hit) return hit;
    }
  }
  return null;
}
