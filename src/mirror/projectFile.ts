/**
 * Project-note generation — the opt-in, user-promoted project file.
 *
 * When a user right-clicks a project in the sidebar and chooses
 * "Promote project to note" (or converts an existing note to a project),
 * this module renders the `.md` file with a project-schema Properties
 * panel. Frontmatter is plugin-managed and regenerates from server state
 * on every sync; the body around the `## Promoted tasks` marker pair is
 * user-owned and never touched after the initial write.
 *
 * The `## Promoted tasks` section is the only body region the plugin
 * rewrites on sync — it lives between HTML comment markers so user
 * content before or after stays intact even when tasks get promoted
 * later. Graph view + Bases also see these as wikilinks via frontmatter.
 *
 * Project identity lives in `primetask-id`; filename is user-facing only.
 */

import type { PrimeTaskProject } from '../api/client';
import { asWikilink, stringifyFrontmatter } from './frontmatter';
import { safeFilename } from './markdown';
import { toLocalDatetimeFrontmatter, toLocalDateFrontmatter } from './taskFile';

/** HTML-comment markers that bound the plugin-managed "Promoted tasks"
 *  block inside a project note's body. Sync rewrites only the content
 *  between these; everything else the user writes is preserved. */
export const PROMOTED_TASKS_MARKER_START = '<!-- primetask:promoted-tasks:start -->';
export const PROMOTED_TASKS_MARKER_END = '<!-- primetask:promoted-tasks:end -->';

/**
 * One promoted task, ready to render in a project note's promoted-tasks
 * block. Carries the wikilink stem plus the status info that goes into
 * the markdown link's display text + diff signature.
 */
export interface PromotedTaskItem {
  /** Filename stem of the promoted task note (no extension). */
  stem: string;
  /** PrimeTask task id — used in the obsidian:// link that opens the
   *  sidebar focused on this task. */
  taskId: string;
  /** Resolved human-readable status name (e.g. "In Progress"). Falls
   *  back to the raw status id when the space's status config can't be
   *  loaded. Goes into the markdown link's display text. */
  statusName: string;
  /** True when the task's status entry has `is_complete: true`. Used
   *  only for the diff signature so a complete-flag flip triggers a
   *  re-render even when the name string is unchanged. */
  isComplete: boolean;
}

/**
 * Strip characters that would break a markdown link's display text.
 * Status names are user-controlled (custom statuses per space), so a
 * name like "Review (draft)" must not split the rendered link.
 */
function sanitiseLinkText(text: string): string {
  return text.replace(/[\[\]()]/g, '').trim() || 'Status';
}

/**
 * Render the body content between the PROMOTED_TASKS markers. Shared by
 * initial `renderProjectFile` output and the poll-side refresh so both
 * paths produce identical text for the same input.
 *
 * Each promoted task renders as `- [[Stem]] · [<glyph> <status>](obsidian://primetask-focus-task?vault=...&taskId=...)`.
 * The wikilink follows Obsidian's default — clicking it opens the task
 * note. The pill is a clickable obsidian:// link that the plugin's
 * protocol handler intercepts to reveal the sidebar with this task
 * focused, so the user can change status from the sidebar's existing
 * inline picker. Read-only inside the note avoids the dead-end "why
 * can't I edit this here?" UX while keeping a real action surface one
 * click away.
 */
export function renderPromotedTasksBlock(items: PromotedTaskItem[], vaultName?: string): string {
  const lines: string[] = [];
  // Markers wrap the plugin-owned region. Anything between the start
  // and end marker is rewritten on every sync; user edits inside this
  // region get overwritten silently. The visual `---` rules that show
  // users where the safe-to-type zone begins live OUTSIDE the markers
  // (see `renderProjectFile` and the self-heal path in `mirror.ts`).
  lines.push(PROMOTED_TASKS_MARKER_START);
  lines.push('');
  lines.push('## Promoted tasks');
  lines.push('');
  if (!items || items.length === 0) {
    lines.push('_None yet. Promote a task from the sidebar to see it here._');
  } else {
    // Sort: open tasks first (alphabetical), completed tasks at the
    // bottom (alphabetical). Without this split, a single completed
    // task in a long list of open ones gets buried alphabetically and
    // is impossible to spot at a glance now that we're not using
    // coloured pills inside the note (sidebar handles colour).
    const sorted = items.slice().sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
      return a.stem.localeCompare(b.stem);
    });
    for (const item of sorted) {
      const params: string[] = [`taskId=${encodeURIComponent(item.taskId)}`];
      if (vaultName) params.unshift(`vault=${encodeURIComponent(vaultName)}`);
      const href = `obsidian://primetask-focus-task?${params.join('&')}`;
      // Pure markdown link. The status name is the link text; clicking
      // in Obsidian fires the `primetask-focus-task` protocol handler
      // which reveals the sidebar with this task focused. Outside
      // Obsidian the URL is a no-op, but the status name stays
      // readable so the meaning is preserved across any markdown
      // viewer. No inline HTML, no inline styles, no colour — the
      // sidebar already shows the coloured pill where the user can
      // act on the status.
      // Completed tasks: wrap the wikilink in `~~...~~` so they
      // visually fade in the rendered list. The wikilink itself stays
      // clickable through the strikethrough; the status link after
      // the middot stays normal-weight so it remains easy to spot
      // and act on.
      const label = sanitiseLinkText(item.statusName);
      const wikilink = item.isComplete
        ? `~~${asWikilink(item.stem)}~~`
        : asWikilink(item.stem);
      lines.push(`- ${wikilink} · [${label}](${href})`);
    }
  }
  lines.push('');
  lines.push(PROMOTED_TASKS_MARKER_END);
  return lines.join('\n');
}

export interface RenderProjectFileOptions {
  project: PrimeTaskProject;
  /** Locked space name for the `space:` wikilink + deep link. */
  spaceName: string | null;
  /** Locked space id — used in the `primetask://` deep link. */
  spaceId: string | null;
  /** ISO 8601 creation timestamp. Defaults to now() if omitted. */
  createdAt?: string | null;
  /** ISO 8601 last-updated timestamp. Defaults to now() if omitted. */
  updatedAt?: string | null;
  /**
   * Promoted tasks under this project, rendered as a wikilink + clickable
   * status pill in the body. Frontmatter `promoted_tasks` derives the
   * wikilinks from the same input. Caller builds this from mirror state;
   * only tasks that have themselves been promoted to notes appear here.
   */
  promotedTasks?: PromotedTaskItem[];
  /** Active Obsidian vault name. Used in the obsidian:// links so the
   *  protocol handler bails when the user has multiple vaults open. */
  vaultName?: string;
}

export interface RenderedProjectFile {
  /** Full markdown including frontmatter + body. */
  content: string;
  /** Vault-relative path (caller prefixes with mirror root). */
  relativePath: string;
  /** The safe filename without extension. */
  filenameStem: string;
}

/**
 * Produce a fully-rendered project markdown file. Filename is
 * `<safe(project.name)>.md`. Caller owns collision resolution + the
 * final write into the vault.
 */
export function renderProjectFile(opts: RenderProjectFileOptions): RenderedProjectFile {
  const { project, spaceName, spaceId } = opts;

  const filenameStem = safeFilename(project.name);
  const relativePath = `Projects/${filenameStem}.md`;

  const deepLink = buildDeepLink({ projectId: project.id, spaceId, spaceName });

  const nowIso = new Date().toISOString();
  const nowLocal = toLocalDatetimeFrontmatter(nowIso);
  const createdLocal = toLocalDatetimeFrontmatter(opts.createdAt) ?? nowLocal;
  const updatedLocal = toLocalDatetimeFrontmatter(opts.updatedAt) ?? nowLocal;

  const promotedTasks = opts.promotedTasks ?? [];
  const promotedTaskLinks = promotedTasks.map((t) => asWikilink(t.stem));

  const frontmatter: Record<string, unknown> = {
    'primetask-id': project.id,
    'primetask-type': 'project',
    'primetask-url': deepLink,
    // Wikilink to the prefixed space hub so Obsidian graph + backlinks
    // show the project as a child of its space.
    space: spaceName ? asWikilink(`PrimeTask - ${safeFilename(spaceName)}`) : undefined,
    status: project.status,
    // Health is a server-side categorical signal the PrimeTask app uses
    // to flag projects that need attention. `null` when the calculator
    // couldn't run — rendered as empty in the Properties panel rather
    // than omitted so Bases can still filter on the field.
    health: project.health ?? null,
    // Authoritative weighted progress (tasks + milestones + goals) so the
    // frontmatter matches the project dashboard in the app. Falls back to
    // the simple task ratio when the health engine didn't populate it.
    progress: typeof project.overallProgress === 'number'
      ? project.overallProgress
      : (typeof project.progress === 'number' ? project.progress : 0),
    task_count: project.taskCount,
    completed_count: project.completedCount,
    overdue_count: project.overdueCount,
    // Server sends ISO timestamps (often UTC midnight). Convert to local
    // `YYYY-MM-DD` so Obsidian's `date` widget doesn't render the day as
    // "one earlier" for users west of UTC.
    deadline: toLocalDateFrontmatter(project.deadline),
    start_date: toLocalDateFrontmatter(project.startDate),
    is_archived: !!project.isArchived,
    promoted_tasks: promotedTaskLinks.length > 0 ? promotedTaskLinks : undefined,
    created_at: createdLocal,
    updated_at: updatedLocal,
  };

  const lines: string[] = [];
  lines.push(stringifyFrontmatter(frontmatter).trimEnd());
  lines.push('');
  lines.push(`# ${project.name}`);
  lines.push('');
  lines.push(`[Open in PrimeTask](${deepLink})`);
  if (project.description && project.description.trim()) {
    lines.push('');
    lines.push(project.description.trim());
  }
  lines.push('');
  // Promoted tasks section — bounded by markers so sync can rewrite it
  // without touching user content above/below.
  lines.push(renderPromotedTasksBlock(promotedTasks, opts.vaultName));
  lines.push('');
  // Visual safe-zone divider OUTSIDE the markers. The plugin only
  // writes this once at initial creation; subsequent syncs leave it
  // alone (replaceBodyBlock only touches content between markers).
  // Users can delete it if they want, but it gives them an obvious
  // "start typing below this rule" cue on first open.
  lines.push('---');
  lines.push('');
  // Blank line at the end so the user's cursor lands on a clean spot
  // when the file is opened, ready for long-form notes.
  lines.push('');

  const content = lines.join('\n') + '\n';
  return { content, relativePath, filenameStem };
}

/**
 * Snapshot of the project frontmatter fields we regenerate from server
 * state each sync. Stored on the MirrorFileState so the poll-side update
 * can diff against last-known values and skip redundant rewrites.
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
  /** Sorted, de-duped list of promoted task wikilink stems. */
  promotedTasks?: string[];
}

function buildDeepLink(params: {
  projectId: string;
  spaceId: string | null;
  spaceName: string | null;
}): string {
  const qs: string[] = [`projectId=${encodeURIComponent(params.projectId)}`];
  if (params.spaceId) qs.push(`spaceId=${encodeURIComponent(params.spaceId)}`);
  if (params.spaceName) qs.push(`spaceName=${encodeURIComponent(params.spaceName)}`);
  return `primetask://project/open?${qs.join('&')}`;
}
