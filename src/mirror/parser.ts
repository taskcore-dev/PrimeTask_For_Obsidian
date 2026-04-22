/**
 * Parse a mirrored markdown file into its structured representation
 * (frontmatter + body). Used by the reconcile path to read a file the
 * plugin owns so it can diff the frontmatter against the last-known
 * snapshot and PATCH changed fields back to PrimeTask.
 */

import { parseFrontmatter } from './frontmatter';

export interface ParseResult {
  primetaskId: string | null;
  type: string | null;
  frontmatter: Record<string, unknown>;
}

/**
 * Parse a file's content into its structured representation. The
 * reconcile path works off `frontmatter` only; explicit capture
 * commands that care about individual lines read the raw editor
 * content directly.
 */
export function parseMirrorFile(content: string): ParseResult {
  const fm = parseFrontmatter(content);
  return {
    primetaskId: typeof fm.data['primetask-id'] === 'string' ? (fm.data['primetask-id'] as string) : null,
    type: typeof fm.data['primetask-type'] === 'string' ? (fm.data['primetask-type'] as string) : null,
    frontmatter: fm.data,
  };
}

/**
 * Extract the project id for a file from its frontmatter. Used by the
 * explicit "send line to PrimeTask" path to inherit project context
 * when the source is a project hub file.
 */
export function extractProjectId(frontmatter: Record<string, unknown>): string | null {
  const type = frontmatter['primetask-type'];
  if (type !== 'project') return null;
  const id = frontmatter['primetask-id'];
  return typeof id === 'string' ? id : null;
}
