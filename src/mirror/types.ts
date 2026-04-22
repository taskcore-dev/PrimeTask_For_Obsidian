/**
 * Entity type identifiers used in frontmatter (`primetask-type: ...`).
 * Kept as string literals so Bases / Dataview can query on them directly.
 */
export type EntityType = 'app' | 'space' | 'project' | 'task' | 'subtask' | 'milestone' | 'goal' | 'contact' | 'company' | 'inbox' | 'contacts-index' | 'companies-index';

/**
 * Map of PrimeTask entity id -> vault-relative file path. Used to resolve
 * wikilinks when a file's frontmatter references another entity.
 */
export interface EntityIndex {
  /** project-id → "PrimeTask/Projects/Q4 Launch.md" */
  projects: Map<string, string>;
  milestones: Map<string, string>;
  goals: Map<string, string>;
  contacts: Map<string, string>;
  companies: Map<string, string>;
  /** reverse lookup: vault path → primetask-id */
  pathToId: Map<string, string>;
  /** reverse lookup: primetask-id → entity type */
  idToType: Map<string, EntityType>;
}

/**
 * A single sync operation queued for transport to PrimeTask. Queue is
 * persisted in `data.json` so it survives plugin reload + Obsidian restart.
 */
export type QueueOp =
  | { kind: 'task.create'; payload: { tempId: string; name: string; projectId?: string | null; status?: string; priority?: string; dueDate?: string | null; description?: string; parentId?: string | null } }
  | { kind: 'task.update'; payload: { id: string; name?: string; status?: string; priority?: string; dueDate?: string | null; projectId?: string | null; description?: string; completionPercentage?: number } }
  | { kind: 'task.delete'; payload: { id: string } }
  | { kind: 'project.update'; payload: { id: string; name?: string; description?: string; status?: string } }
  | { kind: 'milestone.update'; payload: { id: string; name?: string; dueDate?: string | null } }
  | { kind: 'goal.update'; payload: { id: string; name?: string; progress?: number } };

export interface QueueEntry {
  id: string;
  op: QueueOp;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

/**
 * Last-known state for each mirrored file, used for diffing the current
 * file content against what the plugin last wrote.
 */
/**
 * Snapshot of the frontmatter fields we care about for bidirectional sync.
 * Stored on the task's MirrorFileState so that:
 *   - When the user edits the frontmatter in Obsidian, we diff against this
 *     snapshot to know what changed and what to PATCH to PrimeTask.
 *   - When the poll brings back updated server state, we diff against the
 *     snapshot to know whether the file needs a frontmatter rewrite.
 * Values are stored in user-facing form (names, not UUIDs) to match what
 * we write into the frontmatter itself.
 */
export interface TaskFrontmatterSnapshot {
  status?: string;
  priority?: string;
  due?: string | null;
  progress?: number;
  project?: string;
  /** Plain-text description (HTML stripped). Round-trips with PrimeTask. */
  description?: string;
  /**
   * One-click completion shortcut. Derived from the status's `is_complete`
   * flag on server→Obsidian direction; on Obsidian→server it maps to the
   * semantic 'done' / 'todo' tokens which the server resolves to the
   * space's actual default complete / open status id.
   */
  done?: boolean;
  /**
   * Tag NAMES (not full TaskTag objects) because that's what Obsidian
   * writes in frontmatter. Read-only from the plugin's side — we use
   * this only for diff detection so the poll rewrites the task file's
   * frontmatter when tags change server-side. Future bidirectional sync
   * would wire this through reconcileTaskFile too.
   */
  tags?: string[];
  /**
   * Parent task's promoted-file stem (when parent has a task note) OR
   * plain parent task name (when parent hasn't been promoted yet).
   * Used by the poll to detect when a previously-unpromoted parent just
   * got a note and upgrade this subtask's `parent:` frontmatter from a
   * plain string to a live `[[wikilink]]`.
   */
  parent?: string;
  /** Parent task's PrimeTask id. Stable anchor for parent resolution. */
  parentId?: string;
}

/**
 * Last-known project frontmatter values, kept on every `type: 'project'`
 * file so the poll-side refresh can diff against current server state and
 * skip redundant rewrites. Projects are read-only from Obsidian (frontmatter
 * regenerates from server), so this is a one-way server → file snapshot,
 * not a bidirectional diff base like `TaskFrontmatterSnapshot`.
 */
export interface ProjectFrontmatterSnapshot {
  status?: string;
  health?: string | null;
  progress?: number;
  taskCount?: number;
  completedCount?: number;
  overdueCount?: number;
  deadline?: string | null;
  startDate?: string | null;
  isArchived?: boolean;
  /** Sorted wikilink stems of every promoted task note under this project. */
  promotedTasks?: string[];
}

export interface MirrorFileState {
  path: string;
  primetaskId: string;
  type: EntityType;
  mtime: number;
  /** Checkbox id → (line number, done state, title) at last sync.
   *  Retained only for legacy checkbox-capture paths; task notes carry
   *  state via `frontmatterSnapshot` below. */
  checkboxes: Record<string, { line: number; done: boolean; name: string; parentId: string | null }>;
  /** Last-known frontmatter values for `type: 'task' | 'subtask'` files.
   *  Enables bidirectional sync by diff against the current file + server
   *  state. */
  frontmatterSnapshot?: TaskFrontmatterSnapshot;
  /** Last-known frontmatter values for `type: 'project'` files. Enables
   *  the poll-side refresh to skip writes when server state is unchanged. */
  projectSnapshot?: ProjectFrontmatterSnapshot;
}

export interface MirrorState {
  version: 1;
  /** path → file state */
  files: Record<string, MirrorFileState>;
  /** Queue of pending operations */
  queue: QueueEntry[];
}

export const DEFAULT_MIRROR_STATE: MirrorState = {
  version: 1,
  files: {},
  queue: [],
};
