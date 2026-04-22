/**
 * Markdown helpers for mirror file generation.
 */

/** Safe filename — strip characters Obsidian refuses, clamp length. */
export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return cleaned || 'Untitled';
}
