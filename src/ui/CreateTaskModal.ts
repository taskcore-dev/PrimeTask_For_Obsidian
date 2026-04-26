import { App, Modal, Notice, setIcon, Menu, TFile } from 'obsidian';
import type PrimeTaskPlugin from '../main';
import type { PrimeTaskProject, PrimeTaskStatus, PrimeTaskPriority, PrimeTaskTask } from '../api/client';

export interface CreateTaskContext {
  projects: PrimeTaskProject[];
  statuses: PrimeTaskStatus[];
  priorities: PrimeTaskPriority[];
  defaultProjectId?: string | null;
}

export class CreateTaskModal extends Modal {
  private plugin: PrimeTaskPlugin;
  private ctx: CreateTaskContext;
  private onCreate: () => void;

  private name = '';
  private description = '';
  private projectId: string | null = null;
  private statusId: string | null = null;
  private priorityId: string | null = null;
  private dueDate: string = '';
  private createNote = false;
  private submitting = false;

  // Re-render hooks so pill buttons reflect current selection after a menu change
  private projectBtnRender: (() => void) | null = null;
  private statusBtnRender: (() => void) | null = null;
  private priorityBtnRender: (() => void) | null = null;

  constructor(app: App, plugin: PrimeTaskPlugin, ctx: CreateTaskContext, onCreate: () => void) {
    super(app);
    this.plugin = plugin;
    this.ctx = ctx;
    this.onCreate = onCreate;
    this.projectId = ctx.defaultProjectId ?? null;
    this.statusId = ctx.statuses.find((s) => s.is_default)?.id ?? ctx.statuses[0]?.id ?? null;
    this.priorityId = ctx.priorities.find((p) => p.is_default)?.id ?? ctx.priorities[0]?.id ?? null;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass('primetask-create-modal');

    // Header
    const header = contentEl.createDiv({ cls: 'pt-create-header' });
    header.createEl('h2', { text: 'New task', cls: 'pt-create-title' });
    const closeBtn = header.createEl('button', { cls: 'pt-create-close', attr: { 'aria-label': 'Close' } });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => this.close());

    // Body
    const body = contentEl.createDiv({ cls: 'pt-create-body' });

    // Title
    const titleWrap = body.createDiv({ cls: 'pt-field' });
    titleWrap.createEl('label', { cls: 'pt-label', text: 'Title' });
    const titleInput = titleWrap.createEl('input', {
      cls: 'pt-input pt-input-title',
      attr: { type: 'text', placeholder: 'What needs to be done?' },
    });
    titleInput.addEventListener('input', () => { this.name = titleInput.value; });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        this.submit().catch(() => {});
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
    setTimeout(() => titleInput.focus(), 30);

    // Description
    const descWrap = body.createDiv({ cls: 'pt-field' });
    descWrap.createEl('label', { cls: 'pt-label', text: 'Description' });
    const descInput = descWrap.createEl('textarea', {
      cls: 'pt-input pt-input-desc',
      attr: { placeholder: 'Optional notes, context, acceptance criteria…', rows: '3', spellcheck: 'false' },
    }) as HTMLTextAreaElement;
    descInput.addEventListener('input', () => { this.description = descInput.value; });
    descInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.submit().catch(() => {});
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    // Row: Project + Due date
    const row1 = body.createDiv({ cls: 'pt-field-row' });
    const projectField = row1.createDiv({ cls: 'pt-field' });
    projectField.createEl('label', { cls: 'pt-label', text: 'Project' });
    this.renderProjectPill(projectField);

    const dueField = row1.createDiv({ cls: 'pt-field' });
    dueField.createEl('label', { cls: 'pt-label', text: 'Due date' });
    const dueInput = dueField.createEl('input', { cls: 'pt-input', attr: { type: 'date' } });
    dueInput.addEventListener('input', () => { this.dueDate = dueInput.value; });

    // Row: Status + Priority
    const row2 = body.createDiv({ cls: 'pt-field-row' });
    const statusField = row2.createDiv({ cls: 'pt-field' });
    statusField.createEl('label', { cls: 'pt-label', text: 'Status' });
    this.renderStatusPill(statusField);

    const priorityField = row2.createDiv({ cls: 'pt-field' });
    priorityField.createEl('label', { cls: 'pt-label', text: 'Priority' });
    this.renderPriorityPill(priorityField);

    // "Also create a task note in your vault" — only offered when the
    // markdown mirror is enabled, since the note can't land anywhere
    // without it. One-step capture for users who know up-front they
    // want a graph node alongside the task; otherwise they can still
    // promote later from the sidebar's right-click menu.
    if (this.plugin.settings.mirrorEnabled) {
      const noteField = body.createDiv({ cls: 'pt-field pt-field-checkbox' });
      const noteLabel = noteField.createEl('label', { cls: 'pt-checkbox-label' });
      const noteCheckbox = noteLabel.createEl('input', { attr: { type: 'checkbox' } });
      noteCheckbox.addEventListener('change', () => { this.createNote = noteCheckbox.checked; });
      noteLabel.createSpan({ text: 'Create a task note in your vault' });
      noteField.createEl('div', {
        cls: 'pt-field-hint',
        text: 'Adds a markdown file under Tasks/, with a backlink to this modal-created task. Useful when you want graph + Bases coverage for the task right away.',
      });
    }

    // Footer
    const footer = contentEl.createDiv({ cls: 'pt-create-footer' });
    footer.createSpan({ cls: 'pt-create-hint', text: 'Press Enter to create, Esc to cancel' });
    const actions = footer.createDiv({ cls: 'pt-create-actions' });

    const cancelBtn = actions.createEl('button', { cls: 'pt-btn pt-btn-ghost', text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const submitBtn = actions.createEl('button', { cls: 'pt-btn pt-btn-primary', text: 'Create task' });
    submitBtn.addEventListener('click', () => { this.submit().catch(() => {}); });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ---------------------------------------------------------------
  // Custom color-aware pill dropdowns
  // ---------------------------------------------------------------

  private renderProjectPill(parent: HTMLElement): void {
    const btn = parent.createEl('button', { cls: 'pt-pill' });
    const paint = () => {
      btn.empty();
      const project = this.projectId ? this.ctx.projects.find((p) => p.id === this.projectId) : null;
      if (project?.color) {
        const dot = btn.createSpan({ cls: 'pt-pill-dot' });
        dot.style.background = project.color;
      } else {
        setIcon(btn.createSpan({ cls: 'pt-pill-icon' }), 'folder');
      }
      btn.createSpan({ cls: 'pt-pill-text', text: project ? project.name : 'No project' });
      setIcon(btn.createSpan({ cls: 'pt-pill-caret' }), 'chevron-down');
    };
    paint();
    this.projectBtnRender = paint;
    btn.addEventListener('click', (evt) => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('No project').setChecked(!this.projectId).onClick(() => {
        this.projectId = null;
        this.projectBtnRender?.();
      }));
      // Hide archived projects from the dropdown — same UX as the
      // sidebar's Projects tab (archived hidden by default). If the
      // currently selected project happens to be archived (e.g. user
      // archived it in PT after opening this modal), keep it visible
      // in the list so the selection stays meaningful and they can
      // see what's selected.
      const visibleProjects = this.ctx.projects.filter(
        (p) => !p.isArchived || p.id === this.projectId,
      );
      for (const p of visibleProjects) {
        const label = p.isArchived ? `${p.name} (archived)` : p.name;
        menu.addItem((item) => item.setTitle(label).setChecked(this.projectId === p.id).onClick(() => {
          this.projectId = p.id;
          this.projectBtnRender?.();
        }));
      }
      menu.showAtMouseEvent(evt as MouseEvent);
    });
  }

  private renderStatusPill(parent: HTMLElement): void {
    const btn = parent.createEl('button', { cls: 'pt-pill' });
    const paint = () => {
      btn.empty();
      const status = this.statusId ? this.ctx.statuses.find((s) => s.id === this.statusId) : null;
      if (status?.color) {
        const dot = btn.createSpan({ cls: 'pt-pill-dot' });
        dot.style.background = status.color;
      }
      btn.createSpan({ cls: 'pt-pill-text', text: status ? status.name : 'Select status' });
      setIcon(btn.createSpan({ cls: 'pt-pill-caret' }), 'chevron-down');
    };
    paint();
    this.statusBtnRender = paint;
    btn.addEventListener('click', (evt) => {
      const menu = new Menu();
      const sorted = [...this.ctx.statuses].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      for (const s of sorted) {
        menu.addItem((item) => item.setTitle(s.name).setChecked(this.statusId === s.id).onClick(() => {
          this.statusId = s.id;
          this.statusBtnRender?.();
        }));
      }
      menu.showAtMouseEvent(evt as MouseEvent);
    });
  }

  private renderPriorityPill(parent: HTMLElement): void {
    const btn = parent.createEl('button', { cls: 'pt-pill' });
    const paint = () => {
      btn.empty();
      const priority = this.priorityId ? this.ctx.priorities.find((p) => p.id === this.priorityId) : null;
      if (priority?.color) {
        const dot = btn.createSpan({ cls: 'pt-pill-dot' });
        dot.style.background = priority.color;
      }
      btn.createSpan({ cls: 'pt-pill-text', text: priority ? priority.name : 'Select priority' });
      setIcon(btn.createSpan({ cls: 'pt-pill-caret' }), 'chevron-down');
    };
    paint();
    this.priorityBtnRender = paint;
    btn.addEventListener('click', (evt) => {
      const menu = new Menu();
      const sorted = [...this.ctx.priorities].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      for (const p of sorted) {
        menu.addItem((item) => item.setTitle(p.name).setChecked(this.priorityId === p.id).onClick(() => {
          this.priorityId = p.id;
          this.priorityBtnRender?.();
        }));
      }
      menu.showAtMouseEvent(evt as MouseEvent);
    });
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const trimmed = this.name.trim();
    if (!trimmed) {
      new Notice('Task title is required');
      return;
    }
    this.submitting = true;
    try {
      const created = await this.plugin.connection.getClient().createTask({
        name: trimmed,
        description: this.description.trim() || undefined,
        projectId: this.projectId ?? undefined,
        status: this.statusId ?? undefined,
        priority: this.priorityId ?? undefined,
        dueDate: this.dueDate ? new Date(this.dueDate).toISOString() : undefined,
        // Lock the create to the user's selected space, regardless of which
        // space is currently active in the PrimeTask app.
        spaceId: this.plugin.settings.defaultSpaceId ?? undefined,
      });

      let promotedFile: TFile | null = null;
      // One-step capture: if the user ticked "Create a task note in your
      // vault", promote the task as soon as it exists. Failures here
      // are non-fatal (the task still got created) — we surface a
      // distinct Notice and let the user retry from the sidebar.
      if (this.createNote && this.plugin.settings.mirrorEnabled) {
        const task = created as PrimeTaskTask | undefined;
        if (task && typeof task === 'object' && typeof (task as PrimeTaskTask).id === 'string') {
          try {
            promotedFile = await this.plugin.mirror.promoteExistingTaskToNote(task);
          } catch (err) {
            console.warn('[PrimeTask] Auto-promote after create failed', err);
          }
        }
      }

      new Notice(promotedFile ? 'Task and note created' : 'Task created');
      this.onCreate();
      this.close();
      // Open the freshly-promoted note so the user can immediately
      // drop notes into it. Fires after `close()` so the modal isn't
      // covering the editor when the new file opens.
      if (promotedFile) {
        const leaf = this.plugin.app.workspace.getLeaf(false);
        await leaf.openFile(promotedFile);
      }
    } catch (err) {
      new Notice(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
      this.submitting = false;
    }
  }
}
