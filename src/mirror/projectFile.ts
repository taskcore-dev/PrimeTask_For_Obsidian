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
 * Render the body content between the PROMOTED_TASKS markers. Shared by
 * initial `renderProjectFile` output and the poll-side refresh so both
 * paths produce identical text for the same input.
 */
export function renderPromotedTasksBlock(stems: string[]): string {
  const lines: string[] = [];
  lines.push(PROMOTED_TASKS_MARKER_START);
  lines.push('## Promoted tasks');
  lines.push('');
  if (!stems || stems.length === 0) {
    lines.push('_None yet. Promote a task from the sidebar to see it here._');
  } else {
    for (const stem of stems.slice().sort()) {
      lines.push(`- ${asWikilink(stem)}`);
    }
  }
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
   * Promoted-task wikilinks to render in the `promoted_tasks` frontmatter
   * list. Caller builds this from mirror state — only tasks that have
   * themselves been promoted to notes under this project.
   */
  promotedTaskStems?: string[];
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

  const promotedTaskLinks = (opts.promotedTaskStems ?? []).map((s) => asWikilink(s));

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
  lines.push(renderPromotedTasksBlock(opts.promotedTaskStems ?? []));
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
