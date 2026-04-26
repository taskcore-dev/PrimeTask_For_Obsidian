/**
 * Minimal YAML frontmatter read/write.
 *
 * Intentionally scoped to what we emit: string scalars, boolean scalars,
 * and string arrays (including `[[wikilink]]` style). No anchors, aliases,
 * block scalars, or nested maps. If a user hand-writes exotic YAML in a
 * mirrored file we preserve the raw block verbatim on subsequent writes.
 */

const FRONTMATTER_DELIM = /^---\s*$/;

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  /** Offset in the original string where the body starts (after the closing ---). */
  bodyStart: number;
  /** True if the file actually had a frontmatter block. */
  hadFrontmatter: boolean;
  /** Raw frontmatter block (without the --- delimiters) — preserved for round-trip when we don't rewrite. */
  rawBlock: string;
}

/** Parse YAML frontmatter out of a full file string. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(lines[0])) {
    return { data: {}, bodyStart: 0, hadFrontmatter: false, rawBlock: '' };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i])) { end = i; break; }
  }
  if (end === -1) {
    return { data: {}, bodyStart: 0, hadFrontmatter: false, rawBlock: '' };
  }
  const block = lines.slice(1, end);
  const data = parseSimpleYaml(block);

  // Compute body start offset: sum of the delimiter line + block lines + closing delimiter line, including their newlines.
  let bodyStart = 0;
  for (let i = 0; i <= end; i++) {
    bodyStart += lines[i].length + 1; // +1 for newline
  }

  return { data, bodyStart, hadFrontmatter: true, rawBlock: block.join('\n') };
}

/** Serialise a frontmatter data object to the `---\n...\n---\n` block.
 *
 *  Rendering rules:
 *    - `undefined` → skipped entirely (treated as "not present").
 *    - `null` → emitted as `key:` with empty value. Obsidian reads this as
 *      a typed-but-empty property, which is exactly what we want for due
 *      dates / descriptions that the user hasn't filled in yet — they see
 *      an editable date picker / text input in the Properties panel.
 *    - Empty arrays → emitted as `key:` same way, so `tags:` shows a tag
 *      chip editor ready for input rather than hiding the field.
 */
export function stringifyFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value === null) {
      lines.push(`${key}:`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}:`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${formatScalar(item)}`);
      }
    } else if (typeof value === 'object') {
      // Nested objects are not supported by this minimal writer — skip
      // silently so callers don't have to pre-flatten.
      continue;
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function formatScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  // Wrap in double quotes if the string contains YAML-special characters or
  // starts/ends with whitespace. Wikilinks need to be quoted so YAML parsers
  // don't interpret the brackets.
  if (/^(\[\[|\w+:\/\/)|[\s'"`:#\[\]{}|>&*!%@,]/.test(s) || /["']/.test(s) || s.trim() !== s) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  let currentArray: unknown[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Array item
    const arrayItem = line.match(/^\s+-\s+(.*)$/);
    if (arrayItem && currentArrayKey && currentArray) {
      currentArray.push(coerceScalar(arrayItem[1]));
      continue;
    }

    // Key: value
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (top) {
      const [, key, value] = top;
      if (value.trim() === '') {
        // Could be an array — commit if next lines are array items, else scalar empty
        currentArrayKey = key;
        currentArray = [];
        out[key] = currentArray;
      } else {
        out[key] = coerceScalar(value);
        currentArrayKey = null;
        currentArray = null;
      }
      continue;
    }
  }
  return out;
}

function coerceScalar(raw: string): unknown {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

/**
 * Helper: resolve a YAML value that looks like a wikilink (`[[Target]]`) back
 * to the plain target name.
 */
export function unwrapWikilink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^\[\[(.+?)\]\]$/);
  return m ? m[1] : null;
}

export function asWikilink(name: string): string {
  return `[[${name}]]`;
}

/**
 * Apply a partial frontmatter update to an existing file via Obsidian's
 * official `app.fileManager.processFrontMatter` API. Atomic, plays
 * nicely with other plugins editing the same file, and produces a
 * consistent YAML layout. Replaces the older "render new content,
 * splice YAML in via replaceFrontmatter, vault.modify the whole file"
 * pattern that the Obsidian community plugin guidelines flag.
 *
 * - `data` — keys to set on the frontmatter. `undefined` values are
 *   skipped (treated as "not present"). `null` values are written as
 *   empty YAML keys (so Obsidian's typed Properties widgets render
 *   editable empty fields).
 * - `keysToManage` — when provided, every listed key is removed from
 *   the existing frontmatter BEFORE applying `data`. Use this to drop
 *   PT-managed fields that no longer apply (e.g. `project` when a
 *   task moves to Inbox). User-added fields outside this list are
 *   preserved untouched.
 *
 * Caller is responsible for marking the file path in `ownWrites` BEFORE
 * calling this so the vault watcher's echo check knows the resulting
 * `modify` event was plugin-generated, not a user edit.
 */
export async function applyFrontmatter(
  app: { fileManager: { processFrontMatter: (file: unknown, fn: (fm: Record<string, unknown>) => void) => Promise<void> } },
  file: unknown,
  data: Record<string, unknown>,
  options?: { keysToManage?: readonly string[] },
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (options?.keysToManage) {
      for (const key of options.keysToManage) {
        delete fm[key];
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      fm[key] = value;
    }
  });
}

/**
 * Canonical list of frontmatter keys the plugin owns. Pass to
 * `applyFrontmatter`'s `keysToManage` so a sync clears stale PT fields
 * before writing the fresh values, instead of letting them linger.
 * Anything not in this list (user-added properties, custom Bases
 * fields) is preserved across syncs.
 */
export const PT_FRONTMATTER_KEYS_TASK: readonly string[] = [
  'primetask-id',
  'primetask-type',
  'primetask-url',
  'primetask-parent-id',
  'space',
  'project',
  'origin',
  'parent',
  'status',
  'priority',
  'due',
  'progress',
  'tags',
  'description',
  'done',
  'created_at',
  'updated_at',
];

export const PT_FRONTMATTER_KEYS_PROJECT: readonly string[] = [
  'primetask-id',
  'primetask-type',
  'primetask-url',
  'space',
  'status',
  'health',
  'progress',
  'task_count',
  'completed_count',
  'overdue_count',
  'deadline',
  'start_date',
  'is_archived',
  'promoted_tasks',
  'created_at',
  'updated_at',
];

export const PT_FRONTMATTER_KEYS_HUB: readonly string[] = [
  'primetask-id',
  'primetask-type',
  'primetask-name',
  'primetask-space-name',
  'primetask-url',
  'space',
  'is_shared',
  'mirrored_at',
  'updated_at',
  'promoted_tasks',
];
