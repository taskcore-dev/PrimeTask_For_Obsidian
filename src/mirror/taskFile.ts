/**
 * Task-note generation — the wikilink-native, file-per-task model.
 *
 * Each promoted PrimeTask task lives as its own markdown file under
 * `<mirrorFolder>/Tasks/`. The frontmatter mirrors a curated subset of
 * PrimeTask's Task schema (only fields the Plugin API currently exposes)
 * so Obsidian Bases / Dataview can query the vault as a personal database.
 *
 * Identity is carried via `primetask-id` — filename is user-facing only.
 * Renaming the file in Obsidian doesn't break sync; the ID is the anchor.
 *
 * Body is user-owned freeform markdown. PrimeTask's own `description`
 * field is NOT synced yet (the Plugin API doesn't return it). When we
 * wire description through, body becomes the source of truth.
 */

import type { PrimeTaskProject, PrimeTaskTask } from '../api/client';
import { asWikilink, stringifyFrontmatter } from './frontmatter';
import { safeFilename } from './markdown';

export interface RenderTaskFileOptions {
  task: PrimeTaskTask;
  /** Resolved project for `project: "[[X]]"` wikilink. null if orphan / inbox. */
  project: PrimeTaskProject | null;
  /** Locked space name for `space: "[[X]]"` wikilink + deep-link param. */
  spaceName: string | null;
  /** Locked space id — goes into the `primetask://` deep link. */
  spaceId: string | null;
  /** Human-friendly status name, if we've resolved it; else falls back to id. */
  statusName?: string | null;
  /** Human-friendly priority name, if resolved; else falls back to id. */
  priorityName?: string | null;
  /** ISO 8601 creation timestamp. Defaults to now() if omitted. */
  createdAt?: string | null;
  /** ISO 8601 last-updated timestamp. Defaults to now() if omitted. */
  updatedAt?: string | null;
  /**
   * Wikilink target representing where this task was captured FROM. Can be:
   *   - a source note basename (promote-from-selection flow)
   *   - the space hub name (promote-from-sidebar flow — the space itself
   *     becomes the graph ancestor because the task was pulled from
   *     PrimeTask's catalogue for that space).
   * Becomes an `origin: "[[X]]"` frontmatter field + a "Captured from [[X]] on
   * YYYY-MM-DD." body line that Obsidian's backlinks pane + Bases can
   * traverse. Leave null only if the task genuinely has no origin.
   */
  originBasename?: string | null;
  /**
   * ISO date (YYYY-MM-DD) to surface in the "Captured from ... on ..." body
   * line. Defaults to today if omitted.
   */
  captureDate?: string | null;
  /**
   * Whether the task's current status is a complete-category status. Drives
   * the `done: bool` checkbox frontmatter field — a one-tick completion
   * shortcut independent of typing the exact status name.
   */
  isComplete?: boolean;
  /**
   * Parent task, if this is a subtask. Presence flips the note's
   * `primetask-type` to `subtask` and surfaces parent metadata:
   *   - `primetask-parent-id` (stable id anchor)
   *   - `parent: [[stem]]`  when the parent is itself promoted to a note
   *   - `parent: "Name"`     plain string when parent isn't promoted yet
   * The plain-string form upgrades to a wikilink automatically on the
   * next sync after the parent becomes a note. `origin:` also flips to
   * the parent (instead of the space hub) so the graph view shows the
   * subtask as a child of its parent task.
   */
  parentId?: string | null;
  /** Parent task display name — used when the parent isn't promoted. */
  parentName?: string | null;
  /**
   * Parent task's promoted-file basename (no extension). Present when
   * the parent has its own task note; absent when it doesn't. Drives the
   * `parent: [[...]]` wikilink and the `origin:` backlink.
   */
  parentFileStem?: string | null;
}

export interface RenderedTaskFile {
  /** Full markdown including frontmatter + body. */
  content: string;
  /** Vault-relative path (caller prefixes with mirror root). */
  relativePath: string;
  /** The safe filename without extension, for wikilink back-references. */
  filenameStem: string;
}

/**
 * Produce a fully-rendered task markdown file from a PrimeTask task.
 * Filename is `<safe(task.name)>.md`. Caller owns collision resolution.
 */
export function renderTaskFile(opts: RenderTaskFileOptions): RenderedTaskFile {
  const { task, project, spaceName, spaceId, statusName, priorityName } = opts;

  const filenameStem = safeFilename(task.name);
  const relativePath = `Tasks/${filenameStem}.md`;

  // Deep link back into the desktop app. Including spaceId makes PrimeTask
  // switch to the correct space before opening the task — matters when the
  // user is browsing a different space at click time.
  const deepLink = buildDeepLink({ taskId: task.id, spaceId, spaceName });

  const nowIso = new Date().toISOString();
  // All datetime-typed frontmatter fields (`due`, `created_at`,
  // `updated_at`) must be written in local-naive form — Obsidian's
  // Properties panel renders the literal string for datetime props,
  // so a `...Z` UTC value would display 1h off for anyone outside UTC.
  const nowLocal = toLocalDatetimeFrontmatter(nowIso);
  const createdLocal = toLocalDatetimeFrontmatter(opts.createdAt) ?? nowLocal;
  const updatedLocal = toLocalDatetimeFrontmatter(opts.updatedAt) ?? nowLocal;
  const isSubtask = !!opts.parentId;
  // When this is a subtask, the graph ancestor is the PARENT task, not the
  // space hub. Use the parent's promoted file (wikilink) if available; fall
  // back to the plain parent name if not yet promoted; fall back to the
  // caller's `originBasename` only when there's no parent info at all.
  const parentValue: string | undefined = opts.parentFileStem
    ? asWikilink(opts.parentFileStem)
    : opts.parentName
      ? opts.parentName
      : undefined;
  const originValue: string | undefined = isSubtask
    ? parentValue
    : opts.originBasename
      ? asWikilink(opts.originBasename)
      : undefined;

  const frontmatter: Record<string, unknown> = {
    'primetask-id': task.id,
    'primetask-type': isSubtask ? 'subtask' : 'task',
    'primetask-parent-id': isSubtask ? (opts.parentId ?? undefined) : undefined,
    'primetask-url': deepLink,
    // Point `space:` at the prefixed space hub filename (PrimeTask - X).
    // Without the prefix we'd collide with any note the user happens to
    // have named the same as their space (e.g. "Obsidian.md").
    space: spaceName ? asWikilink(`PrimeTask - ${safeFilename(spaceName)}`) : undefined,
    project: project ? asWikilink(safeFilename(project.name)) : undefined,
    parent: isSubtask ? parentValue : undefined,
    // Backlink to wherever this task was captured from — a source note, or
    // the space hub when promoted from the sidebar, or the parent task for
    // a subtask. Obsidian's graph view and backlinks pane traverse this
    // automatically; Bases can filter by it.
    origin: originValue,
    // `done` first so it sorts to the top of the Properties panel — this
    // is the checkbox users will interact with most, so surfacing it
    // prominently matters for the UX.
    done: opts.isComplete === true,
    // `status` / `priority` always emitted (even when blank) so the
    // Properties panel always shows them, same reason as due / tags below.
    status: statusName || task.status || null,
    priority: priorityName || task.priority || null,
    // `due`, `progress`, `tags`, `description` are ALWAYS written even when
    // empty so users see editable fields in Obsidian's Properties panel.
    // null / [] / '' render as empty-typed properties thanks to the
    // null-aware stringifier; user can fill them in and changes sync back.
    due: toLocalDatetimeFrontmatter(task.dueDate),
    progress: typeof task.completionPercentage === 'number'
      ? task.completionPercentage
      : 0,
    // Defensive: tags from the wire are `{id,name,color}` objects, but
    // strip to `name` strings for Obsidian's tags property. Filter out
    // any malformed entries so one bad tag can't poison the list.
    tags: Array.isArray(task.tags)
      ? task.tags
          .map((t) => (typeof t === 'string' ? t : t?.name))
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      : [],
    // Description shown as plain text. PrimeTask stores descriptions as
    // HTML (Tiptap); we strip tags for a readable frontmatter value. On
    // edit, user-entered plain text round-trips back to PrimeTask as-is.
    description: stripDescriptionHtml((task as any).description) || '',
    // Stamped locally at promote time (we literally just created the task).
    // Once we wire server-driven sync, updated_at becomes the authoritative
    // conflict-resolution timestamp between PrimeTask edits and Obsidian
    // frontmatter edits. Written in local-naive form so Obsidian's
    // datetime widget displays the value in the user's wall-clock time.
    created_at: createdLocal,
    updated_at: updatedLocal,
  };

  const lines: string[] = [];
  lines.push(stringifyFrontmatter(frontmatter).trimEnd());
  lines.push('');
  lines.push(`# ${task.name}`);
  lines.push('');
  lines.push(`[Open in PrimeTask](${deepLink})`);
  // Body backlink line. For subtasks: point at the parent (wikilink if
  // promoted, plain bold if not). For regular tasks: whatever the caller
  // supplied as originBasename (source note or space hub).
  if (isSubtask) {
    const date = opts.captureDate || nowIso.slice(0, 10);
    lines.push('');
    if (opts.parentFileStem) {
      lines.push(`Subtask of [[${opts.parentFileStem}]] — promoted on ${date}.`);
    } else if (opts.parentName) {
      lines.push(`Subtask of **${opts.parentName}** — promoted on ${date}.`);
    }
  } else if (opts.originBasename) {
    const date = opts.captureDate || nowIso.slice(0, 10);
    lines.push('');
    lines.push(`Captured from [[${opts.originBasename}]] on ${date}.`);
  }
  lines.push('');
  // Leave a single blank line after the header region so the user's cursor
  // lands on a natural editing position when the file is opened.
  lines.push('');

  const content = lines.join('\n') + '\n';
  return { content, relativePath, filenameStem };
}

/**
 * Convert a UTC ISO string (what PrimeTask stores + sends) to a local
 * naive datetime-local format (`YYYY-MM-DDTHH:mm`) for the `due`
 * frontmatter field. Without this, Obsidian's datetime property
 * displays the raw UTC string, which looks wrong to users in non-UTC
 * timezones (e.g. "1am next day" instead of "midnight today"). Writing
 * in local-naive form matches how users actually think about time.
 *
 * The round-trip works: Obsidian saves the local-naive string back in
 * the frontmatter, the plugin's reconcile path feeds it to `new Date()`
 * which interprets it as local time, then `.toISOString()` converts
 * back to UTC for the PATCH — same instant, consistent across edits.
 */
/**
 * Compare two datetime strings for equality by parsing both to
 * timestamps. Handles the mixed-format case where one side carries an
 * ISO UTC string (`2026-04-22T00:00:00.000Z`) and the other a
 * local-naive string (`2026-04-22T01:00`) that represent the same
 * instant. Without this, simple `!==` on the strings would flag them
 * as different and the poll would rewrite the file on every cycle.
 */
export function datetimesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = a ? new Date(a).getTime() : null;
  const tb = b ? new Date(b).getTime() : null;
  if (ta === null && tb === null) return true;
  if (ta === null || tb === null) return false;
  if (isNaN(ta) && isNaN(tb)) return true;
  if (isNaN(ta) || isNaN(tb)) return false;
  return ta === tb;
}

/**
 * Normalise a datetime string (local-naive OR ISO) to canonical ISO
 * UTC for PATCH-ing the server. Ensures the wire format is consistent
 * regardless of what form the frontmatter stored.
 */
export function toIsoUtc(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function toLocalDatetimeFrontmatter(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Like `toLocalDatetimeFrontmatter` but produces a `YYYY-MM-DD` date-only
 * string for fields registered as `date` (not `datetime`) in Obsidian's
 * property types — e.g. project `deadline` and `start_date`. Without
 * local-time conversion, a UTC midnight stamp renders as the previous
 * day in any westerly timezone. Input can be a plain date or full ISO.
 */
export function toLocalDateFrontmatter(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // Plain YYYY-MM-DD input — skip Date() to avoid TZ interpretation drift.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Strip HTML tags and collapse whitespace so a rich PrimeTask description
 * (stored as Tiptap HTML on the server) renders as readable plain text in
 * the task file's frontmatter. Lossy by design: a round-trip from rich
 * text to plain text and back drops original formatting. Users who need
 * to preserve rich content edit in PrimeTask.
 */
export function stripDescriptionHtml(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  // Remove script + style blocks entirely (not just tags).
  let s = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Replace block-level tags with newline-equivalents so paragraphs survive.
  s = s.replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, '');
  // Decode the handful of HTML entities Tiptap emits.
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // Collapse whitespace.
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/**
 * Build the `primetask://` deep link for this task. Includes spaceName so
 * the existing desktop handler (which routes by space name) keeps working.
 */
function buildDeepLink(params: {
  taskId: string;
  spaceId: string | null;
  spaceName: string | null;
}): string {
  const qs: string[] = [`taskId=${encodeURIComponent(params.taskId)}`];
  if (params.spaceId) qs.push(`spaceId=${encodeURIComponent(params.spaceId)}`);
  if (params.spaceName) qs.push(`spaceName=${encodeURIComponent(params.spaceName)}`);
  return `primetask://task/open?${qs.join('&')}`;
}

/**
 * When two tasks share a name, suffix the filename with `(2)`, `(3)`, ...
 * Caller passes the already-allocated names so we can detect collisions.
 */
export function dedupeFilename(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/**
 * Extract the frontmatter fields we sync bidirectionally from a parsed
 * task file. Returns values in user-facing form (status NAME, not UUID)
 * because that's how we write them. Fields missing from the frontmatter
 * come back as undefined so the diff can tell "untouched" apart from
 * "explicitly cleared" (null on `due`).
 */
export function extractTaskSnapshot(frontmatter: Record<string, unknown>): {
  status?: string;
  priority?: string;
  due?: string | null;
  progress?: number;
  project?: string;
  description?: string;
  done?: boolean;
  parent?: string;
  parentId?: string;
} {
  const pickString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined;
  const pickNumber = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : undefined;
  const unwrapWikilink = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const m = v.match(/^\[\[(.+?)\]\]$/);
    return m ? m[1] : v;
  };
  // `due` is special: explicit null means "clear the due date", undefined
  // means "not present in frontmatter, don't touch."
  let due: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(frontmatter, 'due')) {
    const v = frontmatter['due'];
    due = typeof v === 'string' && v.trim() !== '' ? v : v === null ? null : undefined;
  }
  return {
    status: pickString(frontmatter['status']),
    priority: pickString(frontmatter['priority']),
    due,
    progress: pickNumber(frontmatter['progress']),
    project: unwrapWikilink(frontmatter['project']),
    description: typeof frontmatter['description'] === 'string' ? frontmatter['description'] : undefined,
    done: typeof frontmatter['done'] === 'boolean' ? frontmatter['done'] : undefined,
    parent: unwrapWikilink(frontmatter['parent']),
    parentId: pickString(frontmatter['primetask-parent-id']),
  };
}

/**
 * Rewrite only the frontmatter block of an existing file's content,
 * preserving the body verbatim. Used by the poll-side update when PrimeTask
 * diverges from the file's frontmatter — we update structured metadata
 * without touching anything the user may have written below.
 */
/**
 * Swap the content between two marker strings with a replacement. Markers
 * themselves are part of `replacement` (the caller emits them), so this
 * function finds the existing pair and substitutes. When the markers
 * aren't found at all, appends the replacement to the end of `content`
 * separated by a blank line — first-run scenario where a body that was
 * written before markers shipped hasn't got them yet.
 */
export function replaceBodyBlock(
  content: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string {
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    const sep = content.endsWith('\n\n') ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
    return `${content}${sep}${replacement}\n`;
  }
  const endIdx = content.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) {
    // Corrupt pair — treat as missing and append rather than destroy
    // whatever the user wrote after the start marker.
    return content;
  }
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + endMarker.length);
  return `${before}${replacement}${after}`;
}

/**
 * Insert a single line of content right after the first Markdown H1
 * heading in `body`. Used at convert-note time to drop the "[Open in
 * PrimeTask]" backlink into the user's document without disturbing
 * the rest of their content. When there's no H1, the line is prepended
 * at the top of the body instead.
 */
export function injectLineAfterH1(body: string, lineToInsert: string): string {
  const h1Regex = /^[ \t]*#\s+.+$/m;
  const match = body.match(h1Regex);
  if (!match || match.index === undefined) {
    const sep = body.startsWith('\n') ? '' : '\n';
    return `${lineToInsert}${sep}${body}`;
  }
  const insertAt = match.index + match[0].length;
  const tail = body.slice(insertAt);
  // If the line right after the H1 is already our link (idempotent
  // re-conversion), no-op.
  if (tail.startsWith(`\n\n${lineToInsert}`) || tail.startsWith(`\n${lineToInsert}`)) {
    return body;
  }
  return `${body.slice(0, insertAt)}\n\n${lineToInsert}${tail}`;
}

export function replaceFrontmatter(originalContent: string, newFrontmatter: Record<string, unknown>): string {
  const fmBlock = stringifyFrontmatter(newFrontmatter).trimEnd();
  const lines = originalContent.split('\n');
  if (lines.length > 0 && /^---\s*$/.test(lines[0])) {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^---\s*$/.test(lines[i])) { end = i; break; }
    }
    if (end !== -1) {
      const body = lines.slice(end + 1).join('\n');
      return `${fmBlock}\n${body}`;
    }
  }
  return `${fmBlock}\n${originalContent}`;
}
