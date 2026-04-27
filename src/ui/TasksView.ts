import { ItemView, WorkspaceLeaf, setIcon, Notice, Menu } from 'obsidian';
import type PrimeTaskPlugin from '../main';
import type {
  PrimeTaskProject,
  PrimeTaskTask,
  PrimeTaskStatus,
  PrimeTaskPriority,
} from '../api/client';
import { LockedError } from '../api/client';
import { CreateTaskModal } from './CreateTaskModal';

export const PRIMETASK_VIEW_TYPE = 'primetask-view';

type Tab = 'tasks' | 'projects';
type DueFilter = 'all' | 'overdue' | 'today' | 'week' | 'nodate';

const POLL_INTERVAL_MS = 5_000;

type NoteFilter = 'all' | 'unpromoted' | 'promoted';

interface FilterState {
  due: DueFilter;
  projectId: string | null;
  showDone: boolean;
  search: string;
  /**
   * Filter by whether the task has a corresponding Obsidian note file.
   *   - 'all' (default): show everything
   *   - 'unpromoted': only tasks WITHOUT a note file (great for finding
   *     tasks you haven't yet given graph presence)
   *   - 'promoted': only tasks WITH a note file
   */
  noteFilter: NoteFilter;
  /** When true, archived projects are hidden from the Projects tab.
   *  Default true — most users archive projects to clear visual noise
   *  and want them gone from the default view. The eye-toggle next to
   *  the existing "show done" button flips this. */
  hideArchived: boolean;
}

export class TasksView extends ItemView {
  private plugin: PrimeTaskPlugin;
  private currentTab: Tab = 'tasks';
  private tasks: PrimeTaskTask[] = [];
  private projects: PrimeTaskProject[] = [];
  private statuses: PrimeTaskStatus[] = [];
  private priorities: PrimeTaskPriority[] = [];
  private loading = false;
  private lastError: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private expandedTaskIds = new Set<string>();
  private expandedProjectIds = new Set<string>();
  private filters: FilterState = { due: 'all', projectId: null, showDone: false, search: '', noteFilter: 'all', hideArchived: true };
  private searchInputRef: HTMLInputElement | null = null;
  /** Persistent DOM hosts for the split-render pattern. Header and body
   *  live in separate slots so poll-only updates (task data changed, tab
   *  unchanged) can rebuild the body alone — the header stays mounted,
   *  the logo image stays in the DOM, and no flicker happens. Both are
   *  built once on first render(). */
  private headerHost: HTMLElement | null = null;
  private bodyHost: HTMLElement | null = null;
  private lastHeaderFingerprint: string | null = null;
  private lastBodyFingerprint: string | null = null;
  /** Set by the `primetask:focus-task` workspace event when a user
   *  clicks a status pill in a project note. The next render reads this
   *  to (a) switch to the Tasks tab if needed, (b) expand any collapsed
   *  parents on the path to the target, (c) scroll the target row into
   *  view, (d) apply a brief flash highlight, then clear the field. */
  private pendingFocusTaskId: string | null = null;
  private focusTaskListener: ((taskId: string) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PrimeTaskPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return PRIMETASK_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'PrimeTask';
  }

  getIcon(): string {
    return 'list-checks';
  }

  private refreshListener: (() => void) | null = null;

  async onOpen(): Promise<void> {
    this.containerEl.addClass('primetask-view-root');
    this.render();
    this.refresh().catch(() => {});
    this.pollTimer = setInterval(() => this.refresh().catch(() => {}), POLL_INTERVAL_MS);

    // Listen for mirror-triggered refreshes so sidebar updates instantly when
    // the user edits a mirrored file (instead of waiting up to 5s for the next poll).
    this.refreshListener = () => { this.refresh().catch(() => {}); };
    this.plugin.app.workspace.on('primetask:refresh' as any, this.refreshListener);

    // Listen for focus requests fired by the obsidian:// status-pill
    // protocol handler. When a user clicks a status pill inside a
    // project note, the click reveals this view and then dispatches
    // this event with the task id. We expand any collapsed parents on
    // the path, switch to the Tasks tab, scroll the row into view, and
    // flash it so the user sees where they landed.
    this.focusTaskListener = (taskId: string) => {
      this.requestFocusTask(taskId);
    };
    (this.plugin.app.workspace as any).on('primetask:focus-task', this.focusTaskListener);
  }

  async onClose(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.refreshListener) {
      this.plugin.app.workspace.off('primetask:refresh' as any, this.refreshListener);
      this.refreshListener = null;
    }
    if (this.focusTaskListener) {
      (this.plugin.app.workspace as any).off('primetask:focus-task', this.focusTaskListener);
      this.focusTaskListener = null;
    }
    // Clear the cached host refs so a re-open does a fresh structural build
    // rather than trying to patch DOM that may already have been torn down.
    this.headerHost = null;
    this.bodyHost = null;
    this.lastHeaderFingerprint = null;
    this.lastBodyFingerprint = null;
  }

  private async refresh(): Promise<void> {
    const state = this.plugin.connection.getState();
    if (state.status !== 'connected') {
      this.render();
      return;
    }
    if (this.loading) return;
    this.loading = true;
    try {
      const client = this.plugin.connection.getClient();
      // Scope to the locked space so the sidebar mirrors what the user picked
      // in Obsidian, NOT whatever is currently active in PrimeTask. Without
      // this scoping the sidebar shows the active space's tasks while the
      // mirror folder mirrors the locked space — confusing inconsistency.
      const lockedSpaceId = this.plugin.settings.defaultSpaceId ?? undefined;
      // Per-call .catch returns a sentinel `null` for any non-Locked error so
      // we use whatever data we got. LockedError is rethrown so the outer
      // catch can detect "the desktop app is locked" and preserve the cached
      // data instead of wiping the sidebar to an empty state.
      const reraiseLocked = <T>(fallback: T) => (err: unknown): T => {
        if (err instanceof LockedError) throw err;
        return fallback;
      };
      const [tasks, projects, statuses, priorities] = await Promise.all([
        client.listTasks({ spaceId: lockedSpaceId }).catch((err) => {
          if (err instanceof LockedError) throw err;
          this.lastError = err instanceof Error ? err.message : String(err);
          return [] as PrimeTaskTask[];
        }),
        client.listProjects({ spaceId: lockedSpaceId }).catch(reraiseLocked([] as PrimeTaskProject[])),
        client.listStatuses({ spaceId: lockedSpaceId }).catch(reraiseLocked([] as PrimeTaskStatus[])),
        client.listPriorities({ spaceId: lockedSpaceId }).catch(reraiseLocked([] as PrimeTaskPriority[])),
      ]);
      this.tasks = tasks;
      this.projects = projects;
      this.statuses = statuses;
      this.priorities = priorities;
      this.lastError = null;
    } catch (err) {
      // Locked: keep the cached tasks/projects intact so the sidebar can
      // either show them or render the locked empty state without flashing
      // a misleading "no tasks found" message in between.
      if (!(err instanceof LockedError)) throw err;
    } finally {
      this.loading = false;
      this.render();
    }

    // Feed the markdown mirror with the same fresh data so it stays in sync
    // without making a duplicate set of fetches.
    if (this.plugin.settings.mirrorEnabled && this.plugin.mirror.isRunning()) {
      // The mirror is locked to whichever space the user picked in settings,
      // not whatever PrimeTask happens to have active right now. Pass the
      // locked space's name so the Space hub file matches the data we just
      // fetched (which was also scoped to the locked space).
      const lockedSpaceId = this.plugin.settings.defaultSpaceId;
      const lockedSpace = lockedSpaceId
        ? this.plugin.spaces.find((s) => s.id === lockedSpaceId)
        : null;
      this.plugin.mirror.syncOnce({
        tasks: this.tasks,
        projects: this.projects,
        spaceName: lockedSpace?.name ?? null,
        lockedSpace: lockedSpace ?? null,
      }).catch((err) => console.warn('[PrimeTask] Mirror sync failed', err));
    }
  }

  // ---------------------------------------------------------------
  // Helpers — status / priority lookups
  // ---------------------------------------------------------------

  private findStatus(id: string): PrimeTaskStatus | undefined {
    return this.statuses.find((s) => s.id === id || s.name.toLowerCase() === id.toLowerCase());
  }

  private findPriority(id: string): PrimeTaskPriority | undefined {
    return this.priorities.find((p) => p.id === id || p.name.toLowerCase() === id.toLowerCase());
  }

  private isDoneStatus(statusId: string): boolean {
    const status = this.findStatus(statusId);
    if (status) {
      if (status.is_complete) return true;
      const cat = (status.category || '').toLowerCase();
      return cat === 'complete' || cat === 'done';
    }
    return isLegacyDone(statusId);
  }

  private getToggleTargetStatus(currentStatusId: string): PrimeTaskStatus | undefined {
    const currentlyDone = this.isDoneStatus(currentStatusId);
    const wantComplete = !currentlyDone;
    const candidates = this.statuses.filter((s) => {
      const cat = (s.category || '').toLowerCase();
      return wantComplete ? (s.is_complete || cat === 'complete' || cat === 'done') : (!s.is_complete && cat !== 'complete' && cat !== 'done');
    });
    const defaulted = candidates.find((s) => s.is_default);
    if (defaulted) return defaulted;
    candidates.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    return candidates[0];
  }

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------

  private applyFilters(tasks: PrimeTaskTask[]): PrimeTaskTask[] {
    return tasks.filter((t) => this.passesFilters(t));
  }

  private passesFilters(task: PrimeTaskTask): boolean {
    // Show done toggle
    if (!this.filters.showDone && this.isDoneStatus(task.status)) return false;

    // Project filter
    if (this.filters.projectId && task.projectId !== this.filters.projectId) return false;

    // Search filter
    const q = this.filters.search.trim().toLowerCase();
    if (q) {
      const hit = (t: PrimeTaskTask): boolean => {
        if (t.name.toLowerCase().includes(q)) return true;
        if (Array.isArray(t.subtasks)) return t.subtasks.some(hit);
        return false;
      };
      if (!hit(task)) return false;
    }

    // Due filter
    if (this.filters.due !== 'all') {
      const due = task.dueDate ? new Date(task.dueDate) : null;
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const endOfToday = startOfToday + 24 * 3600 * 1000 - 1;
      const endOfWeek = startOfToday + 7 * 24 * 3600 * 1000;

      if (this.filters.due === 'nodate') {
        if (due) return false;
      } else {
        if (!due) return false;
        const ts = due.getTime();
        if (this.filters.due === 'overdue' && ts >= startOfToday) return false;
        if (this.filters.due === 'today' && (ts < startOfToday || ts > endOfToday)) return false;
        if (this.filters.due === 'week' && (ts < startOfToday || ts > endOfWeek)) return false;
      }
    }

    // Note-presence filter. 'unpromoted' hides tasks that already have a
    // mirrored .md file so the user can quickly scan what's left to
    // promote. 'promoted' does the inverse for reviewing existing notes.
    if (this.filters.noteFilter !== 'all') {
      const hasNote = this.promotedTaskIds.has(task.id);
      if (this.filters.noteFilter === 'unpromoted' && hasNote) return false;
      if (this.filters.noteFilter === 'promoted' && !hasNote) return false;
    }

    return true;
  }

  /**
   * Cache of PrimeTask task ids that have a mirrored note file, refreshed
   * on each render pass. Using a Set keeps O(1) lookup inside the render
   * loop, which is hot when the sidebar has hundreds of tasks.
   */
  private promotedTaskIds: Set<string> = new Set();
  private promotedProjectIds: Set<string> = new Set();

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  private render(): void {
    const container = this.contentEl;

    // First render — build the sticky header + body containers DIRECTLY
    // inside `contentEl` (no extra wrapper divs). A `position: sticky`
    // element must live inside the scroll container's containing block
    // to stick properly; wrapping the header in a short host div traps
    // it and breaks stickiness when the body scrolls.
    if (!this.headerHost || !this.bodyHost) {
      container.empty();
      container.addClass('primetask-view');
      this.headerHost = container.createDiv({ cls: 'primetask-view-header' });
      this.bodyHost = container.createDiv({ cls: 'primetask-view-body' });
      this.lastHeaderFingerprint = null;
      this.lastBodyFingerprint = null;
    }

    // Snapshot which tasks + projects currently have a mirrored note so
    // the render pass can tag rows + filter without hitting the mirror
    // state on each iteration. Cheap because the file set is user-curated,
    // not bulk.
    this.promotedTaskIds = this.plugin.mirror.getPromotedTaskIds();
    this.promotedProjectIds = this.plugin.mirror.getPromotedProjectIds();

    // Header: rebuild only when user-visible header state changes
    // (connection status, active tab, counts, filter labels, search
    // text that drives the filtered-count badge). Poll-only updates
    // where task DATA changed but the header-visible signals didn't
    // leave the header DOM untouched — logo stays mounted, no flicker.
    const headerFp = this.computeHeaderFingerprint();
    if (headerFp !== this.lastHeaderFingerprint) {
      this.headerHost.empty();
      this.populateHeader(this.headerHost);
      this.lastHeaderFingerprint = headerFp;
    }

    // Body: rebuild when the filtered task/project list or any derived
    // state (expansions, promoted badges) changes. Cheaper than header
    // because the body has no user-focus-sensitive inputs.
    const bodyFp = this.computeBodyFingerprint();
    if (bodyFp !== this.lastBodyFingerprint) {
      this.bodyHost.empty();
      this.populateBody(this.bodyHost);
      this.lastBodyFingerprint = bodyFp;
    }

    // Resolve any pending status-pill click. Done after the body has
    // rendered so the target row's DOM exists. Defers to the next
    // animation frame because Obsidian sometimes batches inserts.
    if (this.pendingFocusTaskId) {
      const targetId = this.pendingFocusTaskId;
      this.pendingFocusTaskId = null;
      window.requestAnimationFrame(() => this.applyFocusToRow(targetId));
    }
  }

  /**
   * Mark a task id as the next render's scroll-and-highlight target.
   * Switches to the Tasks tab and expands every parent on the path so
   * the row is reachable, then triggers a render. Called by the
   * `primetask:focus-task` workspace event listener.
   */
  private requestFocusTask(taskId: string): void {
    if (!taskId) return;
    // Walk up the task tree, expanding any collapsed parents on the
    // path. Without this, a subtask whose parent is collapsed would
    // have no DOM row to scroll to.
    const byId = new Map<string, PrimeTaskTask>();
    const flatten = (list: PrimeTaskTask[]) => {
      for (const t of list) {
        byId.set(t.id, t);
        if (t.subtasks?.length) flatten(t.subtasks);
      }
    };
    flatten(this.tasks);
    let cursor = byId.get(taskId);
    while (cursor?.parentId) {
      this.expandedTaskIds.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
    }
    // Always land on the Tasks tab — Projects tab groups by project,
    // which complicates the scroll target. Tasks tab is the canonical
    // flat list and matches the user's intent (they want to see and
    // interact with this one task).
    if (this.currentTab !== 'tasks') {
      this.currentTab = 'tasks';
    }
    this.pendingFocusTaskId = taskId;
    // Force a body rebuild — fingerprint hasn't changed if the task
    // data is the same, but we need the DOM in place to apply focus.
    this.lastBodyFingerprint = null;
    this.render();
  }

  /**
   * Scroll the task row matching the given id into view and apply a
   * brief flash highlight via CSS class. Silently no-ops when the row
   * is filtered out (e.g. user has "show done" off and the task is
   * complete) so the user is not left wondering why the click did
   * nothing visible.
   */
  private applyFocusToRow(taskId: string): void {
    if (!this.bodyHost) return;
    const row = this.bodyHost.querySelector(
      `.primetask-task-row[data-primetask-id="${CSS.escape(taskId)}"]`,
    ) as HTMLElement | null;
    if (!row) {
      new Notice('Task not visible in current filters — clear filters or toggle Show done');
      return;
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.addClass('is-focused');
    window.setTimeout(() => row.removeClass('is-focused'), 1600);
  }

  /**
   * String fingerprint of every signal that affects HEADER presentation.
   * Used by `render()` to decide whether the header needs a rebuild.
   * Components here MUST match every branch in `renderHeader` that reads
   * from `this.` state; missing a field means the header can go stale.
   */
  private computeHeaderFingerprint(): string {
    const s = this.plugin.connection.getState();
    const visibleTaskCount = this.applyFilters(this.tasks).length;
    return [
      s.status,
      s.authorized ? 't' : 'f',
      s.serverVersion ?? '',
      this.currentTab,
      visibleTaskCount,
      this.projects.length,
      this.filters.due,
      this.filters.projectId ?? '',
      this.filters.noteFilter,
      this.filters.showDone ? 't' : 'f',
      this.filters.hideArchived ? 't' : 'f',
      this.filters.search,
      this.loading ? 'l' : '',
      this.lastError ?? '',
    ].join('|');
  }

  /**
   * String fingerprint of every signal that affects BODY presentation.
   * Includes only fields that change the rendered task/project rows —
   * promoted-note badges, expand state, filter outcomes, per-task data.
   */
  private computeBodyFingerprint(): string {
    const s = this.plugin.connection.getState();
    if (s.status !== 'connected') return `state:${s.status}|${s.lastError ?? ''}`;

    // Per-task signature: enough fields to cover every visual cell we
    // render (status pill, priority dot, due pill, progress, subtask
    // chevron, has-note badge). `updated_at` on the server would be
    // cheaper but the current API doesn't expose it; this string stays
    // small (task counts are user-scale, not bulk).
    const taskSig = this.tasks
      .map((t) => `${t.id}:${t.status}:${t.priority}:${t.dueDate ?? ''}:${t.completionPercentage}:${t.subtaskCount}:${t.projectId ?? ''}`)
      .join(',');
    const projectSig = this.projects
      .map((p) => `${p.id}:${p.progress}:${p.taskCount}:${p.completedCount}:${p.overdueCount}:${p.health ?? ''}:${p.isArchived ? 'a' : ''}`)
      .join(',');
    const expandedSig = [
      ...[...this.expandedTaskIds].sort(),
      '|',
      ...[...this.expandedProjectIds].sort(),
    ].join(',');
    const promotedSig = [
      ...[...this.promotedTaskIds].sort(),
      '|',
      ...[...this.promotedProjectIds].sort(),
    ].join(',');

    return [
      this.currentTab,
      this.filters.due,
      this.filters.projectId ?? '',
      this.filters.noteFilter,
      this.filters.showDone ? 't' : 'f',
      this.filters.hideArchived ? 't' : 'f',
      this.filters.search,
      taskSig,
      projectSig,
      expandedSig,
      promotedSig,
    ].join('|');
  }

  private populateHeader(header: HTMLElement): void {
    const state = this.plugin.connection.getState();

    // Row 1 — logo | status + actions (no tabs here anymore)
    const titleRow = header.createDiv({ cls: 'primetask-view-titlerow' });

    const brand = titleRow.createDiv({ cls: 'primetask-view-brand' });
    const logoPath = `${this.plugin.manifest.dir ?? ''}/public/Logo/Primetask_logo.png`;
    try {
      const src = this.plugin.app.vault.adapter.getResourcePath(logoPath);
      brand.createEl('img', {
        cls: 'primetask-view-logo',
        attr: { src, alt: 'PrimeTask', draggable: 'false' },
      });
    } catch {
      brand.createSpan({ cls: 'primetask-view-brand-fallback', text: 'PrimeTask' });
    }

    const actions = titleRow.createDiv({ cls: 'primetask-view-actions' });

    const statusChip = actions.createSpan({ cls: 'primetask-view-statuschip primetask-view-statuschip-dotonly' });
    statusChip.setAttr('title',
      state.status === 'connected' ? 'Live' :
      state.status === 'needs-auth' ? 'Authorize' :
      state.status === 'disabled' ? 'Paused' :
      state.status === 'connecting' ? 'Connecting' :
      'Offline',
    );
    const dot = statusChip.createSpan({ cls: 'primetask-status-dot' });
    dot.addClass(`primetask-status-${state.status}`);

    const addBtn = actions.createEl('button', {
      cls: 'primetask-view-iconbtn',
      attr: { 'aria-label': 'New task', title: 'New task (Cmd+Shift+N)' },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openCreateModal());

    const refreshBtn = actions.createEl('button', {
      cls: 'primetask-view-iconbtn',
      attr: { 'aria-label': 'Refresh', title: 'Refresh now' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    if (this.loading) refreshBtn.addClass('is-spinning');
    refreshBtn.addEventListener('click', () => { this.refresh().catch(() => {}); });

    // Row 2 — search on its own row (full width)
    this.renderSearchBar(header);

    // Row 3 — filter row
    this.renderFilterBar(header);

    // Row 4 — tabs on their own row
    this.renderTabBar(header);
  }

  private renderSearchBar(root: HTMLElement): void {
    const row = root.createDiv({ cls: 'primetask-view-searchrow' });
    const searchWrap = row.createDiv({ cls: 'primetask-view-search' });
    const searchIcon = searchWrap.createSpan({ cls: 'primetask-view-search-icon' });
    setIcon(searchIcon, 'search');
    const searchInput = searchWrap.createEl('input', {
      cls: 'primetask-view-search-input',
      attr: { type: 'text', placeholder: 'Search tasks…', spellcheck: 'false' },
    });
    searchInput.value = this.filters.search;
    searchInput.addEventListener('input', () => {
      this.filters.search = searchInput.value;
      this.debouncedRender();
    });
    this.searchInputRef = searchInput;
    if (this.filters.search) {
      const clearBtn = searchWrap.createEl('button', {
        cls: 'primetask-view-search-clear',
        attr: { 'aria-label': 'Clear search', title: 'Clear' },
      });
      setIcon(clearBtn, 'x');
      clearBtn.addEventListener('click', () => {
        this.filters.search = '';
        this.render();
      });
    }
  }

  private renderTabBar(root: HTMLElement): void {
    const tabs = root.createDiv({ cls: 'primetask-view-tabs' });
    const visibleTaskCount = this.applyFilters(this.tasks).length;
    this.renderTab(tabs, 'tasks', 'Tasks', visibleTaskCount);
    this.renderTab(tabs, 'projects', 'Projects', this.projects.length);
  }

  private debouncedRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private debouncedRender(): void {
    if (this.debouncedRenderTimer) clearTimeout(this.debouncedRenderTimer);
    this.debouncedRenderTimer = setTimeout(() => {
      this.render();
      // Restore focus + caret position after re-render
      if (this.searchInputRef) {
        const el = this.contentEl.querySelector<HTMLInputElement>('.primetask-view-search-input');
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      }
    }, 120);
  }

  private renderTab(parent: HTMLElement, id: Tab, label: string, count: number): void {
    const tab = parent.createEl('button', { cls: 'primetask-view-tab' });
    if (this.currentTab === id) tab.addClass('is-active');
    tab.createSpan({ text: label, cls: 'primetask-view-tab-label' });
    if (count > 0) tab.createSpan({ text: String(count), cls: 'primetask-view-tab-count' });
    tab.addEventListener('click', () => {
      this.currentTab = id;
      this.render();
    });
  }

  private renderFilterBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: 'primetask-view-filterbar' });

    // Due dropdown (shared — filters tasks everywhere)
    const dueOptions: { value: DueFilter; label: string }[] = [
      { value: 'all', label: 'Any time' },
      { value: 'overdue', label: 'Overdue' },
      { value: 'today', label: 'Today' },
      { value: 'week', label: 'This week' },
      { value: 'nodate', label: 'No date' },
    ];
    const currentDue = dueOptions.find((o) => o.value === this.filters.due);
    const dueBtn = bar.createEl('button', { cls: 'primetask-view-filter-dropbtn' });
    setIcon(dueBtn.createSpan({ cls: 'primetask-view-filter-dropbtn-icon' }), 'calendar');
    dueBtn.createSpan({ text: currentDue?.label ?? 'Any time' });
    setIcon(dueBtn.createSpan({ cls: 'primetask-view-filter-caret' }), 'chevron-down');
    if (this.filters.due !== 'all') dueBtn.addClass('is-active');
    dueBtn.addEventListener('click', (evt) => {
      const menu = new Menu();
      for (const opt of dueOptions) {
        menu.addItem((item) => item.setTitle(opt.label).setChecked(this.filters.due === opt.value).onClick(() => {
          this.filters.due = opt.value;
          this.render();
        }));
      }
      menu.showAtMouseEvent(evt as MouseEvent);
    });

    // Project dropdown — only useful on Tasks tab (Projects tab is already about projects).
    if (this.currentTab === 'tasks') {
      const activeProject = this.filters.projectId ? this.projects.find((p) => p.id === this.filters.projectId) : null;
      const projBtn = bar.createEl('button', { cls: 'primetask-view-filter-dropbtn' });
      if (activeProject?.color) {
        const d = projBtn.createSpan({ cls: 'primetask-task-project-dot' });
        d.style.background = activeProject.color;
      } else {
        setIcon(projBtn.createSpan({ cls: 'primetask-view-filter-dropbtn-icon' }), 'folder');
      }
      projBtn.createSpan({ text: activeProject ? activeProject.name : 'All projects' });
      setIcon(projBtn.createSpan({ cls: 'primetask-view-filter-caret' }), 'chevron-down');
      if (activeProject) projBtn.addClass('is-active');
      projBtn.addEventListener('click', (evt) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle('All projects').setChecked(!this.filters.projectId).onClick(() => { this.filters.projectId = null; this.render(); }));
        for (const p of this.projects) {
          menu.addItem((item) => item.setTitle(p.name).setChecked(this.filters.projectId === p.id).onClick(() => { this.filters.projectId = p.id; this.render(); }));
        }
        menu.showAtMouseEvent(evt as MouseEvent);
      });
    } else {
      // Projects tab: expand/collapse all shortcut
      const expandAll = bar.createEl('button', { cls: 'primetask-view-filter-dropbtn' });
      const anyExpanded = this.expandedProjectIds.size > 0;
      setIcon(expandAll.createSpan({ cls: 'primetask-view-filter-dropbtn-icon' }), anyExpanded ? 'chevrons-down-up' : 'chevrons-up-down');
      expandAll.createSpan({ text: anyExpanded ? 'Collapse all' : 'Expand all' });
      expandAll.addEventListener('click', () => {
        if (anyExpanded) {
          this.expandedProjectIds.clear();
        } else {
          for (const p of this.projects) this.expandedProjectIds.add(p.id);
        }
        this.render();
      });
    }

    // Note-presence dropdown — applies to both tasks AND projects on
    // whichever tab is active. One filter, two target lists, same three
    // options. Labels stay neutral ("All items") rather than tab-specific
    // so the picker doesn't need to re-render when the user switches
    // tabs.
    const noteOptions: { value: NoteFilter; label: string }[] = [
      { value: 'all', label: 'All items' },
      { value: 'promoted', label: 'With note' },
      { value: 'unpromoted', label: 'Without note' },
    ];
    const currentNote = noteOptions.find((o) => o.value === this.filters.noteFilter);
    const noteBtn = bar.createEl('button', { cls: 'primetask-view-filter-dropbtn' });
    setIcon(noteBtn.createSpan({ cls: 'primetask-view-filter-dropbtn-icon' }), 'file-text');
    noteBtn.createSpan({ text: currentNote?.label ?? 'All items' });
    setIcon(noteBtn.createSpan({ cls: 'primetask-view-filter-caret' }), 'chevron-down');
    if (this.filters.noteFilter !== 'all') noteBtn.addClass('is-active');
    noteBtn.addEventListener('click', (evt) => {
      const menu = new Menu();
      for (const opt of noteOptions) {
        menu.addItem((item) => item.setTitle(opt.label).setChecked(this.filters.noteFilter === opt.value).onClick(() => {
          this.filters.noteFilter = opt.value;
          this.render();
        }));
      }
      menu.showAtMouseEvent(evt as MouseEvent);
    });

    // Show done toggle — pinned to the far right via the filter bar's
    // margin-left rule on icon buttons. Lives on both tabs.
    const doneBtn = bar.createEl('button', { cls: 'primetask-view-filter-iconbtn' });
    if (this.filters.showDone) doneBtn.addClass('is-active');
    doneBtn.setAttr('title', this.filters.showDone ? 'Hide completed' : 'Show completed');
    setIcon(doneBtn, this.filters.showDone ? 'eye' : 'eye-off');
    doneBtn.addEventListener('click', () => {
      this.filters.showDone = !this.filters.showDone;
      this.render();
    });

    // Hide archived toggle — Projects tab only. Same eye-on/eye-off
    // grammar as "show done" so the two share a mental model. Default
    // is hidden (most users archive projects to clear visual noise).
    if (this.currentTab === 'projects') {
      const archivedBtn = bar.createEl('button', { cls: 'primetask-view-filter-iconbtn' });
      // Active state means "I am revealing archived" (eye open) — flip
      // the icon when hideArchived is OFF so the toggle reads naturally.
      if (!this.filters.hideArchived) archivedBtn.addClass('is-active');
      archivedBtn.setAttr('title', this.filters.hideArchived ? 'Show archived projects' : 'Hide archived projects');
      setIcon(archivedBtn, this.filters.hideArchived ? 'archive' : 'archive-restore');
      archivedBtn.addEventListener('click', () => {
        this.filters.hideArchived = !this.filters.hideArchived;
        this.render();
      });
    }
  }

  private populateBody(body: HTMLElement): void {
    const state = this.plugin.connection.getState();

    if (state.status === 'disabled') {
      this.renderEmptyState(body, 'Sync is paused', 'Re-enable sync in Settings → PrimeTask to load your tasks and projects.');
      return;
    }

    if (state.status === 'needs-auth') {
      this.renderEmptyState(body, 'Authorize to get started', 'Click Authorize in PrimeTask settings to connect this vault.');
      return;
    }

    if (state.status === 'locked') {
      this.renderEmptyState(
        body,
        'PrimeTask is locked',
        'Unlock the desktop app (lock screen) and the plugin will reconnect automatically.',
      );
      return;
    }

    if (state.status !== 'connected') {
      this.renderEmptyState(body, 'PrimeTask is offline', 'Launch the desktop app. The plugin will reconnect automatically.');
      return;
    }

    if (this.lastError) {
      this.renderEmptyState(body, 'Could not load data', this.lastError);
      return;
    }

    if (this.currentTab === 'tasks') {
      this.renderTasksList(body);
    } else {
      this.renderProjectsList(body);
    }
  }

  private renderTasksList(root: HTMLElement): void {
    const visible = this.applyFilters(this.tasks);

    if (visible.length === 0) {
      if (this.tasks.length === 0) {
        this.renderEmptyState(root, 'No tasks yet', 'Click + in the header to create your first task.');
      } else {
        this.renderEmptyState(root, 'No matching tasks', 'Adjust the filters above to see more.');
      }
      return;
    }

    const projectById = new Map(this.projects.map((p) => [p.id, p]));
    const list = root.createDiv({ cls: 'primetask-view-list' });

    for (const task of visible) {
      this.renderTaskRow(list, task, projectById, 0);
    }
  }

  private renderTaskRow(list: HTMLElement, task: PrimeTaskTask, projectById: Map<string, PrimeTaskProject>, depth: number): void {
    const row = list.createDiv({ cls: 'primetask-task-row' });
    // Tag the row with its PrimeTask id so the focus-task protocol
    // handler can find it via querySelector for scroll-and-highlight.
    row.dataset.primetaskId = task.id;
    if (depth > 0) row.addClass('is-subtask');
    row.style.setProperty('--primetask-indent', `${depth * 18}px`);

    const done = this.isDoneStatus(task.status);
    if (done) row.addClass('is-done');

    // Status circle — first element, sits at the row's left edge for alignment
    const statusDot = row.createEl('button', {
      cls: 'primetask-task-status',
      attr: { 'aria-label': done ? 'Mark incomplete' : 'Mark complete', title: done ? 'Mark incomplete' : 'Mark complete' },
    });
    if (done) statusDot.addClass('is-done');
    statusDot.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleTaskCompletion(task);
    });

    // Expand chevron for parents with subtasks — sits AFTER the circle, before the title
    if (task.subtasks && task.subtasks.length > 0) {
      const expanded = this.expandedTaskIds.has(task.id);
      const chevron = row.createEl('button', {
        cls: 'primetask-task-chevron',
        attr: { 'aria-label': expanded ? 'Collapse' : 'Expand' },
      });
      if (expanded) chevron.addClass('is-expanded');
      setIcon(chevron, 'chevron-right');
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        if (expanded) this.expandedTaskIds.delete(task.id); else this.expandedTaskIds.add(task.id);
        this.render();
      });
    }

    // Title + meta
    const bodyCol = row.createDiv({ cls: 'primetask-task-body' });
    const name = bodyCol.createDiv({ cls: 'primetask-task-name', text: task.name });

    const meta = bodyCol.createDiv({ cls: 'primetask-task-meta' });

    const status = this.findStatus(task.status);
    if (status && !done) {
      const statusPill = meta.createEl('button', { cls: 'primetask-task-statuspill' });
      if (status.color) {
        const sd = statusPill.createSpan({ cls: 'primetask-task-statuspill-dot' });
        sd.style.background = status.color;
      }
      statusPill.createSpan({ text: status.name });
      statusPill.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openStatusMenu(e as MouseEvent, task);
      });
    }

    if (task.projectId && depth === 0) {
      const project = projectById.get(task.projectId);
      if (project) {
        const projChip = meta.createSpan({ cls: 'primetask-task-project' });
        if (project.color) {
          const pd = projChip.createSpan({ cls: 'primetask-task-project-dot' });
          pd.style.background = project.color;
        }
        projChip.createSpan({ text: project.name });
      }
    }

    if (task.dueDate) {
      const label = formatDue(task.dueDate);
      if (label) {
        const dueBtn = meta.createEl('button', {
          cls: 'primetask-task-due',
          text: label,
          attr: { 'aria-label': 'Change due date', title: 'Click to change due date' },
        });
        const urgency = dueUrgency(task.dueDate);
        if (urgency) dueBtn.addClass(`primetask-due-${urgency}`);
        dueBtn.addEventListener('click', (evt) => {
          evt.stopPropagation();
          this.openDueDateMenu(evt as MouseEvent, task);
        });
      }
    } else if (!done) {
      // Tiny "set due date" affordance for tasks without one — faint dot
      // click-target. Keeps the row visually quiet but always reachable.
      const dueBtn = meta.createEl('button', {
        cls: 'primetask-task-due primetask-task-due-empty',
        text: '+ due',
        attr: { 'aria-label': 'Set due date', title: 'Set due date' },
      });
      dueBtn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        this.openDueDateMenu(evt as MouseEvent, task);
      });
    }

    if (task.subtaskCount > 0 && (!task.subtasks || task.subtasks.length === 0)) {
      meta.createSpan({ cls: 'primetask-task-subtasks', text: `${task.subtaskCount} subtask${task.subtaskCount === 1 ? '' : 's'}` });
    }

    // Tag chips. Click a chip to seed Obsidian's global search with
    // `tag:#<name>` so the user can find every note carrying the tag
    // (promoted task notes write the tag list into frontmatter, which
    // Obsidian indexes natively). Tag editing still happens in
    // PrimeTask — these are read-only display chips, just navigable.
    if (task.tags && task.tags.length > 0) {
      for (const tag of task.tags) {
        if (!tag?.name) continue;
        // Plain span — keeps the same look as before (just colored
        // text). `role="button"` + tabindex for keyboard accessibility.
        // Avoids Obsidian's default <button> chrome (background, border,
        // padding) which renders as ugly boxes around each tag.
        const chip = meta.createSpan({
          cls: 'primetask-task-tag',
          text: `#${tag.name}`,
          attr: {
            role: 'button',
            tabindex: '0',
            'aria-label': `Search vault for tag ${tag.name}`,
          },
        });
        if (tag.color) {
          chip.style.color = tag.color;
        }
        const trigger = (e: Event) => {
          e.stopPropagation();
          this.openTagSearch(tag.name);
        };
        chip.addEventListener('click', trigger);
        chip.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            trigger(e);
          }
        });
      }
    }

    // "Has note" indicator — tells the user at a glance which tasks have
    // been promoted into graph-node .md files. Click the icon to open the
    // note directly, skipping the right-click → Promote flow entirely.
    if (this.promotedTaskIds.has(task.id)) {
      const noteBadge = meta.createEl('button', {
        cls: 'primetask-task-note-badge',
        attr: { 'aria-label': 'Open task note', title: 'Has note — click to open' },
      });
      setIcon(noteBadge, 'file-check');
      noteBadge.addEventListener('click', async (e) => {
        e.stopPropagation();
        const file = this.plugin.mirror.findFileByPrimetaskId(task.id);
        if (!file) { new Notice('Task note not found'); return; }
        const leaf = this.plugin.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      });
    }

    // Priority dot
    const priority = this.findPriority(task.priority);
    const priorityBtn = row.createEl('button', {
      cls: 'primetask-task-priority',
      attr: { title: priority ? `Priority: ${priority.name}` : `Priority: ${task.priority}`, 'aria-label': 'Change priority' },
    });
    if (priority?.color) {
      priorityBtn.style.background = priority.color;
    } else {
      priorityBtn.addClass(`primetask-priority-${task.priority}`);
    }
    priorityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPriorityMenu(e as MouseEvent, task);
    });

    name.addEventListener('click', () => this.openTaskInPrimeTask(task.id));

    // Right-click anywhere on the row to promote the task into a graph-node
    // markdown file. Deliberately doesn't fire from the individual status /
    // priority / chevron buttons so their own handlers still win.
    row.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      this.openTaskRowContextMenu(evt, task);
    });

    // Recurse into subtasks if expanded
    if (task.subtasks && task.subtasks.length > 0 && this.expandedTaskIds.has(task.id)) {
      for (const sub of task.subtasks) {
        this.renderTaskRow(list, sub, projectById, depth + 1);
      }
    }
  }

  private renderProjectsList(root: HTMLElement): void {
    if (this.projects.length === 0) {
      this.renderEmptyState(root, 'No projects yet', 'Create your first project in PrimeTask.');
      return;
    }

    // Apply the shared note-presence filter + the projects-tab archive
    // filter. Note filter: `promoted` keeps only projects with a note,
    // `unpromoted` keeps only projects without, `all` leaves untouched.
    // Archive filter: when `hideArchived` is on (default), archived
    // projects are dropped — the eye toggle in the filter bar reveals
    // them again.
    const projects = this.projects.filter((p) => {
      if (this.filters.hideArchived && p.isArchived) return false;
      if (this.filters.noteFilter === 'all') return true;
      const hasNote = this.promotedProjectIds.has(p.id);
      return this.filters.noteFilter === 'promoted' ? hasNote : !hasNote;
    });

    if (projects.length === 0) {
      this.renderEmptyState(
        root,
        this.filters.noteFilter === 'promoted' ? 'No promoted projects' : 'All projects have notes',
        this.filters.noteFilter === 'promoted'
          ? 'Right-click a project in the sidebar → Promote project to note.'
          : 'Switch the filter to "All items" to see your projects.',
      );
      return;
    }

    const list = root.createDiv({ cls: 'primetask-view-list' });
    const projectById = new Map(this.projects.map((p) => [p.id, p]));

    for (const project of projects) {
      const expanded = this.expandedProjectIds.has(project.id);
      const card = list.createDiv({ cls: 'primetask-project-row' });
      if (expanded) card.addClass('is-expanded');

      // Summary button — the whole row is the click target for expansion,
      // but the Open icon is its own action on the right.
      const summaryRow = card.createDiv({ cls: 'primetask-project-summary-row' });

      const summary = summaryRow.createEl('button', { cls: 'primetask-project-summary' });

      const chevron = summary.createSpan({ cls: 'primetask-project-chevron' });
      if (expanded) chevron.addClass('is-expanded');
      setIcon(chevron, 'chevron-right');

      if (project.color) {
        const dot = summary.createSpan({ cls: 'primetask-project-dot' });
        dot.style.background = project.color;
      }

      // Text column — name + optional description
      const textCol = summary.createDiv({ cls: 'primetask-project-textcol' });
      const nameRow = textCol.createDiv({ cls: 'primetask-project-namerow' });
      nameRow.createSpan({ cls: 'primetask-project-name', text: project.name });
      // Archived pill — visible only when revealing archived projects,
      // so the user can tell at a glance which rows are still active.
      if (project.isArchived) {
        nameRow.createSpan({
          cls: 'primetask-project-archived-pill',
          text: 'Archived',
          attr: { title: 'This project is archived in PrimeTask' },
        });
      }
      if (project.description && project.description.trim()) {
        const cleaned = stripMarkdown(project.description).trim();
        if (cleaned) {
          const descEl = textCol.createSpan({ cls: 'primetask-project-desc', text: cleaned });
          descEl.setAttr('title', cleaned);
        }
      }

      summary.addEventListener('click', () => {
        if (this.expandedProjectIds.has(project.id)) this.expandedProjectIds.delete(project.id);
        else this.expandedProjectIds.add(project.id);
        this.render();
      });

      const rightActions = summaryRow.createDiv({ cls: 'primetask-project-rightactions' });
      rightActions.createSpan({
        cls: 'primetask-project-count',
        text: `${project.completedCount}/${project.taskCount}`,
      });

      // Has-note badge — same affordance as on task rows. Appears only
      // when the project has been promoted to a note; click to open.
      if (this.promotedProjectIds.has(project.id)) {
        const noteBadge = rightActions.createEl('button', {
          cls: 'primetask-task-note-badge',
          attr: { 'aria-label': 'Open project note', title: 'Has note — click to open' },
        });
        setIcon(noteBadge, 'file-check');
        noteBadge.addEventListener('click', async (e) => {
          e.stopPropagation();
          const file = this.plugin.mirror.findFileByPrimetaskId(project.id);
          if (!file) { new Notice('Project note not found'); return; }
          const leaf = this.plugin.app.workspace.getLeaf(false);
          await leaf.openFile(file);
        });
      }

      const openBtn = rightActions.createEl('button', {
        cls: 'primetask-project-openicon-btn',
        attr: { 'aria-label': 'Open in PrimeTask', title: 'Open in PrimeTask' },
      });
      setIcon(openBtn, 'external-link');
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openProjectInPrimeTask(project.id);
      });

      // Right-click the whole summary row for promote / open actions.
      // Deliberately not bound to the card — we don't want the context
      // menu firing when the user right-clicks a nested task row.
      summaryRow.addEventListener('contextmenu', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.openProjectRowContextMenu(evt, project);
      });

      if (expanded) {
        const tasksWrap = card.createDiv({ cls: 'primetask-project-tasks' });

        const projectTasks = this.tasks.filter((t) => t.projectId === project.id);
        const visible = projectTasks.filter((t) => this.filters.showDone || !this.isDoneStatus(t.status));
        if (visible.length === 0) {
          tasksWrap.createDiv({ cls: 'primetask-project-empty', text: projectTasks.length === 0 ? 'No tasks in this project' : 'All tasks complete. Toggle the eye icon on the Tasks tab to see them.' });
        } else {
          const inner = tasksWrap.createDiv({ cls: 'primetask-view-list primetask-project-tasklist' });
          for (const task of visible) {
            this.renderTaskRow(inner, task, projectById, 0);
          }
        }
      }
    }
  }

  private renderEmptyState(root: HTMLElement, title: string, description: string): void {
    const wrap = root.createDiv({ cls: 'primetask-view-empty' });
    wrap.createDiv({ cls: 'primetask-view-empty-title', text: title });
    wrap.createDiv({ cls: 'primetask-view-empty-desc', text: description });
  }

  /**
   * Open Obsidian's global search prefilled with `tag:#<name>`. Promoted
   * task notes carry the PrimeTask tag list in YAML frontmatter, which
   * Obsidian indexes as native tags, so the search lands on every note
   * carrying the tag. Falls back to a Notice when the global-search
   * internal plugin isn't available (e.g. user disabled it).
   */
  private openTagSearch(tagName: string): void {
    const trimmed = (tagName || '').trim();
    if (!trimmed) return;
    // Obsidian tag search treats spaces as separators; quote multi-word
    // tags so the whole name is matched as one tag.
    const queryName = /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
    const query = `tag:#${queryName}`;
    const internalPlugins = (this.app as any).internalPlugins;
    const searchPlugin = internalPlugins?.getPluginById?.('global-search');
    const instance = searchPlugin?.instance;
    if (typeof instance?.openGlobalSearch === 'function') {
      instance.openGlobalSearch(query);
      return;
    }
    new Notice('Global search is not available in this vault.');
  }

  // ---------------------------------------------------------------
  // Write actions
  // ---------------------------------------------------------------

  private async toggleTaskCompletion(task: PrimeTaskTask): Promise<void> {
    const target = this.getToggleTargetStatus(task.status);
    if (!target) {
      new Notice('No matching status available');
      return;
    }
    await this.patchTask(task.id, { status: target.id }, this.isDoneStatus(target.id) ? 'Completed' : 'Reopened');
  }

  /**
   * Per-task row context menu. Currently surfaces "Promote to task note" so
   * users can turn any existing PrimeTask task into a graph-node markdown
   * file without having to retype its text. Future entries (Open in
   * PrimeTask, Delete, etc.) slot in here.
   */
  private openTaskRowContextMenu(evt: MouseEvent, task: PrimeTaskTask): void {
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle('Promote to task note')
        .setIcon('file-plus')
        .onClick(async () => {
          const file = await this.plugin.mirror.promoteExistingTaskToNote(task);
          if (file) {
            const leaf = this.plugin.app.workspace.getLeaf(false);
            await leaf.openFile(file);
          }
        });
    });
    menu.addItem((item) => {
      item
        .setTitle('Open in PrimeTask')
        .setIcon('external-link')
        .onClick(() => this.openTaskInPrimeTask(task.id));
    });
    menu.showAtMouseEvent(evt);
  }

  /**
   * Per-project row context menu. Two promote variants:
   *   - `Promote project to note` — project file only, no task cascade.
   *   - `Promote project + all tasks to notes` — project + every task
   *     and subtask under it, one click. Useful for big projects where
   *     the user wants the full working set as linked notes without
   *     clicking each task individually.
   */
  private openProjectRowContextMenu(evt: MouseEvent, project: PrimeTaskProject): void {
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle('Promote project to note')
        .setIcon('file-plus')
        .onClick(async () => {
          const file = await this.plugin.mirror.promoteExistingProjectToNote(project);
          if (file) {
            const leaf = this.plugin.app.workspace.getLeaf(false);
            await leaf.openFile(file);
          }
        });
    });
    menu.addItem((item) => {
      item
        .setTitle('Promote project + all tasks to notes')
        .setIcon('layers')
        .onClick(async () => {
          const file = await this.plugin.mirror.promoteExistingProjectToNote(project, {
            includeTasks: true,
          });
          if (file) {
            const leaf = this.plugin.app.workspace.getLeaf(false);
            await leaf.openFile(file);
          }
        });
    });
    menu.addItem((item) => {
      item
        .setTitle('Open in PrimeTask')
        .setIcon('external-link')
        .onClick(() => this.openProjectInPrimeTask(project.id));
    });
    menu.showAtMouseEvent(evt);
  }

  /**
   * Due-date picker — quick presets plus a "Custom…" path that opens a
   * native datetime-local input in a modal. All presets produce an ISO
   * string in the user's local timezone, then patch the task. Clear
   * removes the due date entirely (dueDate: null).
   */
  private openDueDateMenu(evt: MouseEvent, task: PrimeTaskTask): void {
    const menu = new Menu();

    const patchDue = async (iso: string | null, successLabel: string) => {
      try {
        const lockedSpaceId = this.plugin.settings.defaultSpaceId ?? undefined;
        await this.plugin.connection.getClient().updateTask(task.id, { dueDate: iso, spaceId: lockedSpaceId });
        new Notice(successLabel);
        this.refresh().catch(() => {});
      } catch (err) {
        new Notice(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const atEndOfDay = (offsetDays: number): string => {
      // Default time when user picks a date-only preset: end of day
      // (23:59 local). Matches the app's convention that midnight means
      // "due by end of day, not immediately overdue."
      const d = new Date();
      d.setDate(d.getDate() + offsetDays);
      d.setHours(23, 59, 0, 0);
      return d.toISOString();
    };

    menu.addItem((item) => item.setTitle('Today').setIcon('sun').onClick(() => patchDue(atEndOfDay(0), 'Due today')));
    menu.addItem((item) => item.setTitle('Tomorrow').setIcon('sunrise').onClick(() => patchDue(atEndOfDay(1), 'Due tomorrow')));
    menu.addItem((item) => item.setTitle('This weekend').setIcon('calendar').onClick(() => {
      // Saturday of the current week (or tomorrow if today is Saturday).
      const d = new Date();
      const day = d.getDay(); // 0 = Sun
      const daysToSat = (6 - day + 7) % 7 || 7;
      d.setDate(d.getDate() + daysToSat);
      d.setHours(23, 59, 0, 0);
      patchDue(d.toISOString(), `Due ${d.toLocaleDateString()}`);
    }));
    menu.addItem((item) => item.setTitle('Next week').setIcon('calendar-clock').onClick(() => patchDue(atEndOfDay(7), 'Due next week')));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Custom date / time…').setIcon('calendar-plus').onClick(() => {
      this.openCustomDueModal(task, patchDue);
    }));
    if (task.dueDate) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle('Clear due date').setIcon('x').onClick(() => patchDue(null, 'Due date cleared')));
    }

    menu.showAtMouseEvent(evt);
  }

  /**
   * Minimal datetime-local modal for picking an exact date + time.
   * Obsidian doesn't ship a first-party date picker, and pulling in a
   * heavy library for a single edit affordance is overkill. Native
   * `<input type="datetime-local">` handles keyboard + native pickers
   * on both macOS and Windows and respects the user's locale.
   */
  private openCustomDueModal(task: PrimeTaskTask, patchDue: (iso: string | null, label: string) => Promise<void>): void {
    const { Modal } = require('obsidian') as typeof import('obsidian');
    const modal = new Modal(this.plugin.app);
    modal.titleEl.setText('Set due date');
    const wrap = modal.contentEl.createDiv({ cls: 'primetask-due-modal' });

    const input = wrap.createEl('input', { type: 'datetime-local', cls: 'primetask-due-modal-input' });
    // Seed with the current due date (converted to local datetime-local
    // format) or now + 1h as a sensible default for new picks.
    const seed = task.dueDate ? new Date(task.dueDate) : new Date(Date.now() + 60 * 60 * 1000);
    if (!isNaN(seed.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      input.value = `${seed.getFullYear()}-${pad(seed.getMonth() + 1)}-${pad(seed.getDate())}T${pad(seed.getHours())}:${pad(seed.getMinutes())}`;
    }

    const buttons = wrap.createDiv({ cls: 'primetask-due-modal-buttons' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'primetask-due-modal-btn' });
    cancelBtn.addEventListener('click', () => modal.close());
    const saveBtn = buttons.createEl('button', { text: 'Save', cls: 'primetask-due-modal-btn primetask-due-modal-btn-primary' });
    saveBtn.addEventListener('click', async () => {
      const v = input.value;
      if (!v) { modal.close(); return; }
      // datetime-local is naive-local; interpret as local timezone.
      const picked = new Date(v);
      if (isNaN(picked.getTime())) { new Notice('Invalid date'); return; }
      await patchDue(picked.toISOString(), `Due ${picked.toLocaleDateString()}`);
      modal.close();
    });

    modal.open();
    // Focus the input so keyboard users can type immediately.
    setTimeout(() => input.focus(), 0);
  }

  private openStatusMenu(evt: MouseEvent, task: PrimeTaskTask): void {
    if (this.statuses.length === 0) {
      new Notice('No statuses available');
      return;
    }
    const menu = new Menu();
    const sorted = [...this.statuses].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    for (const status of sorted) {
      menu.addItem((item) => {
        item.setTitle(status.name).setChecked(task.status === status.id).onClick(async () => {
          await this.patchTask(task.id, { status: status.id }, `Status: ${status.name}`);
        });
      });
    }
    menu.showAtMouseEvent(evt);
  }

  private openPriorityMenu(evt: MouseEvent, task: PrimeTaskTask): void {
    if (this.priorities.length === 0) {
      new Notice('No priorities available');
      return;
    }
    const menu = new Menu();
    const sorted = [...this.priorities].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    for (const priority of sorted) {
      menu.addItem((item) => {
        item.setTitle(priority.name).setChecked(task.priority === priority.id).onClick(async () => {
          await this.patchTask(task.id, { priority: priority.id }, `Priority: ${priority.name}`);
        });
      });
    }
    menu.showAtMouseEvent(evt);
  }

  private async patchTask(taskId: string, input: { status?: string; priority?: string; name?: string; dueDate?: string | null }, successLabel: string): Promise<void> {
    const patchInTree = (list: PrimeTaskTask[]): PrimeTaskTask[] => list.map((t) => {
      if (t.id === taskId) return { ...t, ...(input.status !== undefined ? { status: input.status } : {}), ...(input.priority !== undefined ? { priority: input.priority } : {}) };
      if (t.subtasks && t.subtasks.length) return { ...t, subtasks: patchInTree(t.subtasks) };
      return t;
    });
    const original = JSON.parse(JSON.stringify(this.tasks)) as PrimeTaskTask[];
    this.tasks = patchInTree(this.tasks);
    this.render();

    try {
      // Always scope writes to the locked space so the server hits the right
      // storage. Without this the server defaults to the active space and the
      // taskId isn't found there → optimistic patch reverts with a confusing
      // "Update failed" toast even though the user is locked to a valid space.
      const lockedSpaceId = this.plugin.settings.defaultSpaceId ?? undefined;
      await this.plugin.connection.getClient().updateTask(taskId, { ...input, spaceId: lockedSpaceId });
      new Notice(successLabel);
      this.refresh().catch(() => {});
    } catch (err) {
      this.tasks = original;
      this.render();
      new Notice(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private openCreateModal(): void {
    if (this.plugin.connection.getState().status !== 'connected') {
      new Notice('PrimeTask is not connected.');
      return;
    }
    if (this.statuses.length === 0 || this.priorities.length === 0) {
      new Notice('Statuses / priorities not loaded yet. Try again in a moment.');
      return;
    }
    const modal = new CreateTaskModal(this.app, this.plugin, {
      projects: this.projects,
      statuses: this.statuses,
      priorities: this.priorities,
      defaultProjectId: this.filters.projectId ?? this.plugin.settings.defaultProjectId,
    }, () => { this.refresh().catch(() => {}); });
    modal.open();
  }

  private openTaskInPrimeTask(taskId: string): void {
    const spaceName = this.resolveActiveSpaceName();
    if (!spaceName) {
      new Notice('Open in PrimeTask failed: active space unknown.');
      return;
    }
    const url = `primetask://task/open?taskId=${encodeURIComponent(taskId)}&spaceName=${encodeURIComponent(spaceName)}`;
    window.open(url);
    new Notice('Opening in PrimeTask…');
  }

  private openProjectInPrimeTask(projectId: string): void {
    const spaceName = this.resolveActiveSpaceName();
    if (!spaceName) {
      new Notice('Open in PrimeTask failed: active space unknown.');
      return;
    }
    const url = `primetask://project/open?projectId=${encodeURIComponent(projectId)}&spaceName=${encodeURIComponent(spaceName)}`;
    window.open(url);
    new Notice('Opening in PrimeTask…');
  }

  /**
   * Returns the name of the space the sidebar is bound to. Prefers the
   * LOCKED space (user's explicit choice in settings) over PrimeTask's
   * currently-active space — opening a task in PrimeTask should switch to
   * the locked space, not whatever the user happens to be browsing there.
   */
  private resolveActiveSpaceName(): string | null {
    const spaces = this.plugin.spaces;
    const defaultId = this.plugin.settings.defaultSpaceId;
    if (defaultId) {
      const match = spaces.find((s) => s.id === defaultId);
      if (match) return match.name;
    }
    const active = spaces.find((s) => s.isActive);
    if (active) return active.name;
    return spaces[0]?.name ?? null;
  }
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function isLegacyDone(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'done' || s === 'completed' || s === 'complete';
}

function formatDue(iso: string): string {
  try {
    const date = new Date(iso);
    // new Date(<invalid>) doesn't throw — it returns an Invalid Date
    // whose toLocaleDateString prints literally "Invalid Date". Guard so
    // a malformed payload never leaks that string into the sidebar.
    if (isNaN(date.getTime())) return '';
    const now = new Date();
    const msPerDay = 24 * 60 * 60 * 1000;
    const sameDay = date.toDateString() === now.toDateString();
    const tomorrow = new Date(now.getTime() + msPerDay).toDateString() === date.toDateString();
    const yesterday = new Date(now.getTime() - msPerDay).toDateString() === date.toDateString();

    // If the date has a non-midnight time component, append it. Matches
    // the app's date-picker behaviour: midnight = "date-only", any other
    // time = "date + time" (due by a specific hour). Respects the user's
    // locale for both day and time formatting.
    const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
    const timeLabel = hasTime
      ? ` ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      : '';

    if (sameDay) return `Today${timeLabel}`;
    if (tomorrow) return `Tomorrow${timeLabel}`;
    if (yesterday) return `Yesterday${timeLabel}`;
    const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${day}${timeLabel}`;
  } catch {
    return '';
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold **x**
    .replace(/\*([^*]+)\*/g, '$1')         // italic *x*
    .replace(/__([^_]+)__/g, '$1')         // bold __x__
    .replace(/_([^_]+)_/g, '$1')           // italic _x_
    .replace(/`([^`]+)`/g, '$1')           // inline code
    .replace(/~~([^~]+)~~/g, '$1')         // strikethrough
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^#+\s+/gm, '')              // headings
    .replace(/\n+/g, ' ');                // flatten to single line
}

function dueUrgency(iso: string): 'overdue' | 'today' | 'soon' | null {
  try {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfToday = startOfToday + 24 * 3600 * 1000 - 1;
    const ts = date.getTime();
    if (ts < startOfToday) return 'overdue';
    if (ts <= endOfToday) return 'today';
    if (ts <= startOfToday + 3 * 24 * 3600 * 1000) return 'soon';
    return null;
  } catch {
    return null;
  }
}
