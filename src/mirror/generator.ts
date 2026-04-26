/**
 * Markdown file generation from PrimeTask data.
 *
 * Emits the hub files that anchor the mirror folder (app root, space,
 * Inbox, guide, project hubs) plus triggers downstream writes for
 * promoted task / subtask notes. Milestones, goals, and CRM entities
 * are emitted by their own writers once enabled.
 */

import { normalizePath, Vault, TFile } from 'obsidian';
import type { PrimeTaskProject, PrimeTaskSpace, PrimeTaskTask } from '../api/client';
import type { PrimeTaskSettings } from '../settings';
import { getNormalisedMirrorFolder } from '../settings';
import { asWikilink, stringifyFrontmatter } from './frontmatter';
import { safeFilename } from './markdown';
import { toLocalDatetimeFrontmatter, toLocalDateFrontmatter } from './taskFile';
import type { EntityType, MirrorFileState, MirrorState } from './types';

export interface GenerationContext {
  vault: Vault;
  settings: PrimeTaskSettings;
  projects: PrimeTaskProject[];
  tasks: PrimeTaskTask[];
  state: MirrorState;
  spaceName: string | null;
  /**
   * Full locked-space object when available. Carries metadata (isShared,
   * color, id) that the Space hub file surfaces in its frontmatter beyond
   * the name alone. Null when the plugin is not yet connected to a space.
   */
  lockedSpace?: PrimeTaskSpace | null;
  /**
   * Called synchronously BEFORE every vault.modify / vault.create / rename
   * the generator issues, so the MirrorManager's own-write echo map is
   * updated in time for the watcher handler (which fires synchronously
   * inside vault.modify). Marking after the write races the modify event
   * and lets the watcher treat our writes as user edits, producing
   * phantom deltas and PATCH loops.
   */
  markOwnWrite?: (path: string) => void;
}

export interface GenerationResult {
  createdOrUpdated: string[];
  errors: Array<{ path: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Locked naming conventions — single source of truth
//
// Rule: hub-level files at the mirror root carry a `PrimeTask - ` prefix to
// avoid collisions with user notes ("Inbox.md", "Obsidian.md", "Personal.md"
// are all likely names users have their own files for). Entity files in
// typed subfolders (Tasks/, Projects/, etc.) stay unprefixed because the
// subfolder already namespaces them.
//
// Every write that targets a hub file goes through these helpers so a future
// rebrand is a single-file change.
// ---------------------------------------------------------------------------

/** Filename of the app-root anchor file, always at the mirror root. */
const APP_ROOT_FILENAME = 'PrimeTask.md';

/** Filename of the Inbox hub (orphan tasks aggregator). */
const INBOX_FILENAME = 'PrimeTask - Inbox.md';

/** Filename of the user-facing guide file — full manual, linked from the app root. */
const GUIDE_FILENAME = 'PrimeTask for Obsidian.md';
const GUIDE_STEM = 'PrimeTask for Obsidian';

/** Produce the space hub filename given a space name. */
function spaceHubFilename(spaceName: string): string {
  return `PrimeTask - ${safeFilename(spaceName)}.md`;
}

/** Wikilink stem (no extension) for the space hub — used in frontmatter / body. */
function spaceHubStem(spaceName: string): string {
  return `PrimeTask - ${safeFilename(spaceName)}`;
}

export async function generateMirror(ctx: GenerationContext): Promise<GenerationResult> {
  const result: GenerationResult = { createdOrUpdated: [], errors: [] };
  if (!ctx.settings.mirrorEnabled) return result;

  const root = getNormalisedMirrorFolder(ctx.settings);
  await ensureFolder(ctx.vault, root);

  // Rename legacy hub files (`Inbox.md`, `<SpaceName>.md`) to the new
  // prefixed scheme (`PrimeTask - Inbox.md`, `PrimeTask - <SpaceName>.md`).
  // Runs every generation pass; no-op when there's nothing to migrate.
  // Obsidian's rename machinery auto-updates existing wikilinks in the
  // vault (both body + frontmatter) when the user has "Automatically
  // update internal links" ON — which is the default.
  await migrateLegacyHubFiles(ctx, root);

  // Always write the app-root anchor — it's the top of the graph hierarchy
  // and doesn't depend on mirrorProjects. Small file, lightweight regen.
  const rootPath = normalizePath(`${root}/${APP_ROOT_FILENAME}`);
  try {
    await writeAppRootFile(ctx, rootPath);
    result.createdOrUpdated.push(rootPath);
  } catch (err) {
    result.errors.push({ path: rootPath, message: err instanceof Error ? err.message : String(err) });
  }

  // Guide — the full user manual. Lives alongside the app root so users
  // can discover + backlink it without digging. Regenerated every pass so
  // doc updates (shipped in plugin upgrades) propagate automatically.
  const guidePath = normalizePath(`${root}/${GUIDE_FILENAME}`);
  try {
    await writeGuideFile(ctx, guidePath);
    result.createdOrUpdated.push(guidePath);
  } catch (err) {
    result.errors.push({ path: guidePath, message: err instanceof Error ? err.message : String(err) });
  }

  if (ctx.settings.mirrorProjects) {
    // Map of primetask task id → promoted task note basename. Hub files
    // surface these as `[[wikilinks]]`; only user-promoted tasks appear
    // in hub listings.
    const promotedTaskMap = buildPromotedTaskMap(ctx);

    // Group tasks by project. Subtasks are nested inside parent tasks already
    // (API returns them nested via include_subtasks).
    const tasksByProject = new Map<string | null, PrimeTaskTask[]>();
    for (const t of ctx.tasks) {
      const key = t.projectId ?? null;
      const list = tasksByProject.get(key) ?? [];
      list.push(t);
      tasksByProject.set(key, list);
    }

    // Inbox hub for orphan tasks.
    const orphans = tasksByProject.get(null) ?? [];
    const inboxPath = normalizePath(`${root}/${INBOX_FILENAME}`);
    try {
      await writeInboxFile(ctx, inboxPath, orphans, promotedTaskMap);
      result.createdOrUpdated.push(inboxPath);
    } catch (err) {
      result.errors.push({ path: inboxPath, message: err instanceof Error ? err.message : String(err) });
    }

    // Space hub — the locked space's node in the graph, connecting the app
    // root, the Inbox, and every promoted entity in the space. Only
    // surfaces user-promoted projects and tasks (opt-in model); listing
    // every entity the server knows about would push dozens of files the
    // user never asked to see.
    if (ctx.spaceName) {
      const spacePath = normalizePath(`${root}/${spaceHubFilename(ctx.spaceName)}`);
      try {
        await writeSpaceFile(ctx, spacePath, ctx.spaceName);
        result.createdOrUpdated.push(spacePath);
      } catch (err) {
        result.errors.push({ path: spacePath, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return result;
}

/**
 * Build a map of `primetaskId → filename stem` for every task note currently
 * tracked in mirror state. Used by hub writers to render promoted tasks as
 * `[[...]]` wikilinks instead of `- [ ]` checkboxes.
 */
function buildPromotedTaskMap(ctx: GenerationContext): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, fileState] of Object.entries(ctx.state.files)) {
    // Include BOTH task and subtask types. Both carry task id semantics;
    // hub files should surface subtask notes alongside regular task notes
    // in their promoted-lists.
    if (fileState.type !== 'task' && fileState.type !== 'subtask') continue;
    const file = ctx.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) continue;
    out.set(fileState.primetaskId, file.basename);
  }
  return out;
}

// ---------------------------------------------------------------------------
// App-root file (PrimeTask.md) — the graph anchor
// ---------------------------------------------------------------------------

async function writeAppRootFile(ctx: GenerationContext, path: string): Promise<void> {
  const existing = ctx.state.files[path];
  const previousMirroredAt = (existing as any)?.mirroredAt as string | undefined;
  const nowIso = new Date().toISOString();
  const nowLocal = toLocalDatetimeFrontmatter(nowIso);

  const lockedSpaceLink = ctx.spaceName ? asWikilink(spaceHubStem(ctx.spaceName)) : null;

  const frontmatter: Record<string, unknown> = {
    'primetask-type': 'app',
    // Datetime frontmatter in local-naive form so Obsidian's Properties
    // panel displays wall-clock time, not raw UTC.
    mirrored_at: toLocalDatetimeFrontmatter(previousMirroredAt) || nowLocal,
    updated_at: nowLocal,
    locked_spaces: lockedSpaceLink ? [lockedSpaceLink] : undefined,
  };

  const lines: string[] = [];
  lines.push(stringifyFrontmatter(frontmatter).trimEnd());
  lines.push('');
  lines.push('# PrimeTask');
  lines.push('');
  lines.push('Your task, project, and CRM backend. This note is the graph anchor for everything the PrimeTask plugin brings into your vault.');
  lines.push('');
  lines.push('## Locked spaces');
  lines.push('');
  if (lockedSpaceLink) {
    lines.push(`- ${lockedSpaceLink}`);
  } else {
    lines.push('_No space locked yet. Pick one in Settings → PrimeTask → Locked space._');
  }
  lines.push('');
  lines.push('## Quick actions');
  lines.push('');
  lines.push('- Right-click a task in the sidebar and choose **Promote to task note** to give it its own graph node.');
  lines.push('- Select any text in a note, right-click, and choose **Send selection to PrimeTask and link here** to capture new tasks in context.');
  if (ctx.spaceName) {
    // PrimeTask's deep-link validator rejects nav commands without a
    // spaceName param, so we only emit the link when we have one to pass.
    const qs = `?spaceName=${encodeURIComponent(ctx.spaceName)}`;
    lines.push(`- [Open PrimeTask](primetask://nav/dashboard${qs})`);
  }
  lines.push('');
  lines.push('## Learn more');
  lines.push('');
  lines.push(`Full manual: ${asWikilink(GUIDE_STEM)}.`);

  const content = lines.join('\n') + '\n';
  await writeFileIfChanged(ctx, path, content, 'app:primetask', 'app', []);
  if (ctx.state.files[path] && !previousMirroredAt) {
    (ctx.state.files[path] as any).mirroredAt = nowIso;
  }
}

// ---------------------------------------------------------------------------
// Guide file (PrimeTask for Obsidian.md) — the full user manual
// ---------------------------------------------------------------------------

async function writeGuideFile(ctx: GenerationContext, path: string): Promise<void> {
  const nowLocal = toLocalDatetimeFrontmatter(new Date().toISOString());

  const frontmatter: Record<string, unknown> = {
    'primetask-type': 'guide',
    updated_at: nowLocal,
    origin: asWikilink('PrimeTask'),
  };

  const lines: string[] = [];
  lines.push(stringifyFrontmatter(frontmatter).trimEnd());
  lines.push('');
  lines.push('# PrimeTask for Obsidian');
  lines.push('');
  lines.push('The complete step-by-step manual for using the PrimeTask plugin inside Obsidian. This file regenerates on every sync, so any edits you make here will be overwritten. Keep your own notes elsewhere.');
  lines.push('');
  lines.push('Back to [[PrimeTask]].');
  lines.push('');

  // -----------------------------------------------------------------
  // Contents
  // -----------------------------------------------------------------
  lines.push('## Contents');
  lines.push('');
  lines.push('1. [What this plugin does](#what-this-plugin-does)');
  lines.push('2. [Before you start](#before-you-start)');
  lines.push('3. [Getting started (step by step)](#getting-started-step-by-step)');
  lines.push('4. [The PrimeTask sidebar](#the-primetask-sidebar)');
  lines.push('5. [Creating tasks and projects](#creating-tasks-and-projects)');
  lines.push('6. [Editing tasks](#editing-tasks)');
  lines.push('7. [Promoting tasks and projects to notes](#promoting-tasks-and-projects-to-notes)');
  lines.push('8. [Subtasks](#subtasks)');
  lines.push('9. [Projects](#projects)');
  lines.push('10. [Hub files (read-only)](#hub-files-read-only)');
  lines.push('11. [File organisation](#file-organisation)');
  lines.push('12. [Settings reference](#settings-reference)');
  lines.push('13. [What doesn\'t sync](#what-doesnt-sync)');
  lines.push('14. [Deleting](#deleting)');
  lines.push('15. [Troubleshooting](#troubleshooting)');
  lines.push('');

  // -----------------------------------------------------------------
  // What this plugin does
  // -----------------------------------------------------------------
  lines.push('## What this plugin does');
  lines.push('');
  lines.push('PrimeTask is a desktop task and project manager for macOS and Windows. This plugin connects Obsidian to a running PrimeTask app on the same machine and surfaces a locked space inside your vault as `.md` files.');
  lines.push('');
  lines.push('What you get:');
  lines.push('');
  lines.push('- A **sidebar** showing tasks and projects from your locked space, live.');
  lines.push('- **Task notes** for tasks you promote. Obsidian Properties you can edit and query with Bases or Dataview. Edits sync back to PrimeTask.');
  lines.push('- **Project notes** for projects you promote. Plugin-managed frontmatter (progress, health, counts, overdue, deadline). User-owned body: write anything you want around the plugin-managed "Promoted tasks" section.');
  lines.push('- **Capture flows** to turn selected text — or a whole existing note — into a PrimeTask task or project without leaving Obsidian.');
  lines.push('- **Navigation hubs** (app root, space hub, Inbox, this guide) that auto-maintain wikilinks to whatever you\'ve promoted.');
  lines.push('');
  lines.push('Nothing is auto-pushed into your vault per entity. Tasks and projects only get `.md` files when you explicitly promote them. Everything that isn\'t promoted lives in the sidebar only.');
  lines.push('');
  lines.push('All traffic is local-loopback between Obsidian and the PrimeTask desktop app. Nothing leaves your machine.');
  lines.push('');

  // -----------------------------------------------------------------
  // Before you start
  // -----------------------------------------------------------------
  lines.push('## Before you start');
  lines.push('');
  lines.push('You need:');
  lines.push('');
  lines.push('1. **The PrimeTask desktop app** installed and running on the same machine as Obsidian. macOS or Windows.');
  lines.push('2. **Obsidian 1.12+** with the PrimeTask plugin installed and enabled.');
  lines.push('3. **At least one space** in PrimeTask. The plugin reads and writes to one space at a time (the "locked space").');
  lines.push('4. **External Integrations** enabled in PrimeTask settings. You\'ll do this in Step 1 below.');
  lines.push('');
  lines.push('The plugin is desktop-only. Obsidian Mobile is not supported, because it can\'t reach a PrimeTask desktop app.');
  lines.push('');

  // -----------------------------------------------------------------
  // Getting started
  // -----------------------------------------------------------------
  lines.push('## Getting started (step by step)');
  lines.push('');
  lines.push('This is a one-time setup. Budget 2 to 3 minutes.');
  lines.push('');
  lines.push('### Step 1: Enable External Integrations in PrimeTask');
  lines.push('');
  lines.push('1. Open the PrimeTask desktop app.');
  lines.push('2. Go to **Settings**.');
  lines.push('3. Find the **External Integrations** card and switch it on.');
  lines.push('4. Leave PrimeTask running. The plugin talks to it over a local port on 127.0.0.1.');
  lines.push('');
  lines.push('If the toggle is off, the plugin can\'t reach the app and authorization will fail.');
  lines.push('');
  lines.push('### Step 2: Open the plugin settings in Obsidian');
  lines.push('');
  lines.push('1. In Obsidian, open **Settings** (cog icon, bottom-left) or press `Cmd/Ctrl + ,`.');
  lines.push('2. In the left sidebar, scroll to **Community plugins** and click **PrimeTask**.');
  lines.push('3. You should see the **Connection** section at the top. The **Status** row shows one of:');
  lines.push('   - **Connecting** (amber dot) when the plugin is still looking for the app.');
  lines.push('   - **Connected** (green dot) once the app is reachable.');
  lines.push('   - **Needs authorization** (amber) when the app is reachable but this vault is not yet authorized.');
  lines.push('   - **Disconnected** (red) when the app isn\'t running.');
  lines.push('');
  lines.push('If the status shows Disconnected, re-check Step 1.');
  lines.push('');
  lines.push('### Step 3: Authorize this vault');
  lines.push('');
  lines.push('1. In the plugin settings, find the **Authorization** row and click **Authorize...**.');
  lines.push('2. A Connect to PrimeTask dialog opens in Obsidian, showing a **6-character verification code**.');
  lines.push('3. A matching approval dialog appears in the PrimeTask app.');
  lines.push('4. **Compare the code** shown in Obsidian against the code shown in PrimeTask. They must match exactly.');
  lines.push('5. In PrimeTask, click **Allow**.');
  lines.push('6. Obsidian\'s dialog flips to "Connected". Close it.');
  lines.push('');
  lines.push('You can revoke authorization any time from either side:');
  lines.push('');
  lines.push('- **In Obsidian**: Settings → PrimeTask → Authorization → **Revoke on this device**.');
  lines.push('- **In PrimeTask**: Settings → External Integrations → **Connected plugins** list → revoke by name.');
  lines.push('');
  lines.push('### Step 4: Lock a space');
  lines.push('');
  lines.push('The plugin reads and writes to exactly one space at a time, independent of which space is currently active in the PrimeTask app. You need to pick it explicitly.');
  lines.push('');
  lines.push('1. In the plugin settings, find the **Locked space** dropdown under **Sync preferences**.');
  lines.push('2. Pick the space you want mirrored into this vault.');
  lines.push('3. The sidebar repopulates within a few seconds.');
  lines.push('');
  lines.push('You can change the locked space later, but only one is active at a time per vault.');
  lines.push('');
  lines.push('### Step 5: Enable the markdown mirror');
  lines.push('');
  lines.push('This turns on the `.md` file generation for the navigation hubs + any notes you promote. Off by default so the plugin stays invisible until you opt in.');
  lines.push('');
  lines.push('1. Scroll to the **Markdown mirror** section in settings.');
  lines.push('2. Switch **Enable markdown mirror** on.');
  lines.push('3. Optionally change **Mirror folder** (defaults to `PrimeTask`). The plugin will create this folder and its hub files on the next sync.');
  lines.push('4. Within a few seconds you should see:');
  lines.push('   - `PrimeTask/PrimeTask.md` (app root)');
  lines.push('   - `PrimeTask/PrimeTask for Obsidian.md` (this guide)');
  lines.push('   - `PrimeTask/PrimeTask - <SpaceName>.md` (space hub)');
  lines.push('   - `PrimeTask/PrimeTask - Inbox.md` (Inbox hub — lists promoted orphan tasks)');
  lines.push('');
  lines.push('The `Projects/` and `Tasks/` folders are created on demand, the first time you promote something into them.');
  lines.push('');
  lines.push('You\'re done with setup. Proceed to the sidebar and capture flows below.');
  lines.push('');

  // -----------------------------------------------------------------
  // The sidebar
  // -----------------------------------------------------------------
  lines.push('## The PrimeTask sidebar');
  lines.push('');
  lines.push('The sidebar is how you browse and edit tasks live without opening the desktop app.');
  lines.push('');
  lines.push('### Opening it');
  lines.push('');
  lines.push('- Click the **PrimeTask ribbon icon** on Obsidian\'s left edge, or');
  lines.push('- Run the **Open PrimeTask panel** command from the command palette (`Cmd/Ctrl + P`).');
  lines.push('');
  lines.push('### What you see');
  lines.push('');
  lines.push('- **Tasks tab**: every task in the locked space, grouped by project. Shows status, priority, due date, and progress inline.');
  lines.push('- **Projects tab**: every project in the locked space with progress and task counts.');
  lines.push('- **Note filter** (Tasks tab): dropdown to show "All tasks", "With note", or "Without note". Lets you see at a glance which tasks have been promoted.');
  lines.push('- **Has-note badge**: small file-check icon on rows where a task note already exists. Click the badge to open the note.');
  lines.push('');
  lines.push('### Inline edits');
  lines.push('');
  lines.push('- **Status**: click the status pill to open a dropdown and pick any status configured for the space. Changes are saved immediately.');
  lines.push('- **Priority**: click the priority pill. Same behaviour.');
  lines.push('- **Due date**: click the due-date pill to open a quick-picker with Today / Tomorrow / This weekend / Next week / Custom / Clear. "Custom" opens a datetime input so you can set a specific time of day.');
  lines.push('- **Completion checkbox** (circle on the left): one-click toggle that flips the task to your space\'s default complete or open status.');
  lines.push('- **Expand / collapse**: chevron on rows with subtasks.');
  lines.push('');
  lines.push('### Right-click on a task row');
  lines.push('');
  lines.push('- **Promote to task note** — creates a `.md` file for this task under `Tasks/`. See [Promoting tasks and projects to notes](#promoting-tasks-and-projects-to-notes).');
  lines.push('- **Open in PrimeTask** — opens the task in the desktop app via the `primetask://` deep link.');
  lines.push('');
  lines.push('### Right-click on a project row');
  lines.push('');
  lines.push('- **Promote project to note** — creates a `.md` file for this project under `Projects/`. No tasks are promoted automatically; each one stays in the sidebar until you promote it individually.');
  lines.push('- **Promote project + all tasks to notes** — creates the project note AND cascades promote over every task + subtask under the project. One click, full graph of linked notes.');
  lines.push('- **Open in PrimeTask** — deep link into the project in the desktop app.');
  lines.push('');
  lines.push('### Creating new tasks from the sidebar');
  lines.push('');
  lines.push('Click the **+** button at the top of the Tasks tab to create a task in the locked space. You\'ll be prompted for the task name.');
  lines.push('');

  // -----------------------------------------------------------------
  // Creating tasks
  // -----------------------------------------------------------------
  lines.push('## Creating tasks and projects');
  lines.push('');
  lines.push('Every capture is explicit. The plugin never auto-creates tasks or projects from text in your notes; you always pick the action.');
  lines.push('');
  lines.push('### From the PrimeTask desktop app');
  lines.push('');
  lines.push('The full experience. Open the app, use the normal task / project creation UI. Within a few seconds new items appear in the Obsidian sidebar.');
  lines.push('');
  lines.push('### From the Obsidian sidebar');
  lines.push('');
  lines.push('Click the **+** button at the top of the Tasks tab to create a task in the locked space. Fastest path if you\'re already in Obsidian.');
  lines.push('');
  lines.push('### From selected text inside a note (right-click)');
  lines.push('');
  lines.push('Select text in any note, right-click, and choose one of:');
  lines.push('');
  lines.push('- **Send selection to PrimeTask and link here** — creates a task AND a task note `.md`, then replaces your selected text with a `[[wikilink]]` pointing at the new note. Use this when the captured thing deserves its own graph node.');
  lines.push('- **Send selection to PrimeTask** — creates a task only. No file is created, your source note is untouched. Fire-and-forget capture.');
  lines.push('');
  lines.push('### From a whole note (right-click with no selection)');
  lines.push('');
  lines.push('Open any note, right-click without selecting text, and choose one of:');
  lines.push('');
  lines.push('- **Convert note to PrimeTask project** — turns the entire note into a project. The note\'s H1 (or filename) becomes the project name; body becomes the description. The note stays where it is and gets project frontmatter injected. A `[Open in PrimeTask]` link is added after the H1, and a marker-bounded `## Promoted tasks` section is appended to the body.');
  lines.push('- **Convert note to PrimeTask task** — same shape but creates a task instead of a project.');
  lines.push('');
  lines.push('Guarded: the menu items don\'t appear on notes that already carry a `primetask-id`, and plugin-generated hub files refuse conversion.');
  lines.push('');
  lines.push('### From the command palette');
  lines.push('');
  lines.push('Open the command palette (`Cmd/Ctrl + P`) and run:');
  lines.push('');
  lines.push('- **PrimeTask: Send selection to PrimeTask and link here** (same as the right-click variant).');
  lines.push('- **PrimeTask: Send selection to PrimeTask** (same as the right-click variant).');
  lines.push('- **PrimeTask: Send current line as task to PrimeTask** — when your cursor is on a `- [ ]` checkbox line that is not yet synced, this creates a task from that line.');
  lines.push('- **PrimeTask: Convert note to PrimeTask project** (same as the right-click variant).');
  lines.push('- **PrimeTask: Convert note to PrimeTask task** (same as the right-click variant).');
  lines.push('');
  lines.push('### Why no implicit triggers');
  lines.push('');
  lines.push('The plugin intentionally does **not** watch for patterns like `#primetask` or auto-create tasks from plain `- [ ]` checkboxes you type anywhere. That design prevents surprise task creation when you paste code blocks, copy notes, or type checkbox-shaped text as examples. All capture is explicit: you pick the menu item, command, or button.');
  lines.push('');

  // -----------------------------------------------------------------
  // Editing tasks
  // -----------------------------------------------------------------
  lines.push('## Editing tasks');
  lines.push('');
  lines.push('Three places to edit a task, all synced.');
  lines.push('');
  lines.push('### In the sidebar (fastest)');
  lines.push('');
  lines.push('Inline pills let you change status, priority, and due date without opening anything. Good for quick triage.');
  lines.push('');
  lines.push('### In a task note (Properties panel)');
  lines.push('');
  lines.push('Open any task note. The **Properties** panel at the top shows every structured field. Edit them inline; changes sync back within ~2 seconds.');
  lines.push('');
  lines.push('See [Task note Properties](#task-note-properties) below for the full field list.');
  lines.push('');
  lines.push('### In the PrimeTask desktop app');
  lines.push('');
  lines.push('The full editing surface (rich descriptions, custom fields, milestones, goals, CRM links, etc). Anything you change in PrimeTask reflects in Obsidian on the next sync.');
  lines.push('');
  lines.push('### Task note Properties');
  lines.push('');
  lines.push('Obsidian calls the structured metadata block at the top of a note the **Properties** panel. PrimeTask writes these properties into every task note. Most sync in both directions.');
  lines.push('');
  lines.push('| Property | Type | Sync direction | Notes |');
  lines.push('|---|---|---|---|');
  lines.push('| `status` | text | Obsidian ↔ PrimeTask | Pick from statuses defined in PrimeTask for this space. |');
  lines.push('| `priority` | text | Obsidian ↔ PrimeTask | Pick from priorities defined in PrimeTask. |');
  lines.push('| `due` | datetime | Obsidian ↔ PrimeTask | Shown in your local time. Supports date + time. |');
  lines.push('| `progress` | number (0 to 100) | Obsidian ↔ PrimeTask | Completion percentage. |');
  lines.push('| `project` | wikilink | PrimeTask → Obsidian | To reassign a task between projects, do it in PrimeTask. |');
  lines.push('| `description` | plain text | Obsidian ↔ PrimeTask | Rich text in PrimeTask is flattened to plain text here; edits round-trip as plain text. |');
  lines.push('| `done` | checkbox | Obsidian ↔ PrimeTask | One-click completion. Ticking maps to the space\'s default complete status; unticking to the default open status. |');
  lines.push('| `tags` | list | PrimeTask → Obsidian | Read-only in Obsidian for now. Manage tags in PrimeTask. |');
  lines.push('| `created_at` | datetime | Stamped once at promote | Never changes. |');
  lines.push('| `updated_at` | datetime | Stamped by the plugin | Bumps when a meaningful sync writes new data. |');
  lines.push('');
  lines.push('> [!info] Statuses, priorities, and tag names come from PrimeTask.');
  lines.push('> To use a new status, priority, or tag in Obsidian, create it in PrimeTask first. Once it exists there, it shows up in the Properties dropdown here.');
  lines.push('');
  lines.push('### The body is yours');
  lines.push('');
  lines.push('Everything below the first heading in a task note is your space for long-form thinking, references, images, and cross-links. Body content never syncs to PrimeTask, so write freely.');
  lines.push('');

  // -----------------------------------------------------------------
  // Promoting
  // -----------------------------------------------------------------
  lines.push('## Promoting tasks and projects to notes');
  lines.push('');
  lines.push('"Promoting" means turning a task or project into a dedicated `.md` file in your vault. Once promoted, the entity becomes a graph node you can link to from anywhere and query with Bases. Everything that isn\'t promoted stays in the sidebar only.');
  lines.push('');
  lines.push('### What promoting does (tasks)');
  lines.push('');
  lines.push('When you promote a task:');
  lines.push('');
  lines.push('1. The plugin creates `<mirror-folder>/Tasks/<task-name>.md`.');
  lines.push('2. The new file\'s Properties panel is populated from the task\'s current server state (status, priority, due, progress, project wikilink, description, tags).');
  lines.push('3. An `origin` property points at wherever the task was captured from (the selection\'s source note, or the space hub if promoted from the sidebar).');
  lines.push('4. The space hub\'s `promoted_tasks` list picks up the new note on the next sync. If the task belongs to a promoted project, that project note\'s `## Promoted tasks` block also picks it up.');
  lines.push('5. Future edits to the task note\'s Properties sync back to PrimeTask.');
  lines.push('');
  lines.push('### What promoting does (projects)');
  lines.push('');
  lines.push('When you promote a project:');
  lines.push('');
  lines.push('1. The plugin creates `<mirror-folder>/Projects/<project-name>.md`.');
  lines.push('2. The Properties panel carries the project\'s current metrics (status, health, progress, task counts, overdue count, deadline, start date, archive state) — same numbers the PrimeTask dashboard shows.');
  lines.push('3. The body contains a `[Open in PrimeTask]` link and a marker-bounded `## Promoted tasks` section. Any task notes you later promote under this project appear in that section automatically on the next sync.');
  lines.push('4. The space hub\'s `promoted_projects` list picks up the new note on the next sync.');
  lines.push('');
  lines.push('Promoting does not duplicate anything: there is still exactly one task / project in PrimeTask, with a `.md` file in your vault as its surface.');
  lines.push('');
  lines.push('### How to promote');
  lines.push('');
  lines.push('Four entry points, depending on what you\'re doing:');
  lines.push('');
  lines.push('**Entity already exists in PrimeTask** (common case):');
  lines.push('');
  lines.push('1. Open the Obsidian sidebar.');
  lines.push('2. Right-click the task or project row.');
  lines.push('3. For projects you get two promote variants: just the project, or the project plus every task under it.');
  lines.push('4. The new file opens automatically.');
  lines.push('');
  lines.push('**You\'re capturing from a selection inside another note:**');
  lines.push('');
  lines.push('1. Select the text.');
  lines.push('2. Right-click → **Send selection to PrimeTask and link here**.');
  lines.push('3. The plugin creates the task in PrimeTask, writes a task note, and replaces your selection with a `[[wikilink]]` to the new note.');
  lines.push('');
  lines.push('**You\'re converting a whole note:**');
  lines.push('');
  lines.push('1. Open the note. Don\'t select any text.');
  lines.push('2. Right-click → **Convert note to PrimeTask project** or **Convert note to PrimeTask task**.');
  lines.push('3. The note stays where it is; the plugin injects frontmatter at the top and (for projects) adds a `## Promoted tasks` block at the bottom of the body.');
  lines.push('');
  lines.push('**Cascading a project promotion:**');
  lines.push('');
  lines.push('Use **Promote project + all tasks to notes** on a project row when you want the full working set materialised in your vault in one click. Subtasks are promoted recursively.');
  lines.push('');
  lines.push('### Duplicate protection');
  lines.push('');
  lines.push('If you run Promote on an entity that already has a note, the existing note opens instead of a new one being created. The plugin tracks the mapping by `primetask-id`, not filename, so you won\'t get duplicates even after renames. Convert-note flows explicitly reject files that already have a `primetask-id`.');
  lines.push('');
  lines.push('### Renaming or moving a note');
  lines.push('');
  lines.push('Safe. Identity lives in the `primetask-id` property, not the path. Rename the file, drop it into any folder you like — the entity stays linked. This applies to both task notes and project notes.');
  lines.push('');

  // -----------------------------------------------------------------
  // Subtasks
  // -----------------------------------------------------------------
  lines.push('## Subtasks');
  lines.push('');
  lines.push('Subtasks are first-class in PrimeTask: a task can have any number of child tasks.');
  lines.push('');
  lines.push('### In the sidebar');
  lines.push('');
  lines.push('Subtasks appear nested under their parent in the Tasks tab. Click the chevron on the parent row to expand or collapse. Each subtask has its own status pill, priority pill, due-date pill, and completion checkbox.');
  lines.push('');
  lines.push('### Promoting a subtask');
  lines.push('');
  lines.push('Right-click a subtask row in the sidebar and choose **Promote to task note**. The resulting note is different from a regular task note in a few ways:');
  lines.push('');
  lines.push('- `primetask-type: subtask` instead of `task`.');
  lines.push('- `primetask-parent-id` holds the parent\'s id (a stable anchor).');
  lines.push('- `parent` is a `[[wikilink]]` to the parent task\'s note, if that note exists. If the parent isn\'t promoted yet, `parent` is the parent\'s plain name as a string.');
  lines.push('- `origin` points at the parent (not the space hub), so the graph view shows the subtask as a child of the parent.');
  lines.push('');
  lines.push('### Auto-upgrade when the parent later becomes a note');
  lines.push('');
  lines.push('If you promote a subtask before its parent has been promoted, the subtask\'s `parent` property starts as a plain string (not a live link). When you later promote the parent, the next sync **automatically** rewrites the subtask\'s `parent` property to a live `[[wikilink]]`. No action needed.');
  lines.push('');

  // -----------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------
  lines.push('## Projects');
  lines.push('');
  lines.push('Project notes are opt-in. A project gets a `.md` file only when you promote it (from the sidebar or by converting an existing note). Un-promoted projects live in the sidebar only. This is the same contract as tasks.');
  lines.push('');
  lines.push('### Hybrid ownership: Properties vs body');
  lines.push('');
  lines.push('A project note is split between plugin-managed and user-owned regions:');
  lines.push('');
  lines.push('- **Properties (frontmatter):** plugin-managed. Regenerated from server state on every sync. Editing properties in Obsidian has no effect — they will be overwritten on the next cycle. Manage project metadata in PrimeTask.');
  lines.push('- **Body above and below the `<!-- primetask:promoted-tasks:* -->` markers:** user-owned. Write long-form notes, embed images, link other files. The plugin never touches this content.');
  lines.push('- **The marker-bounded `## Promoted tasks` block:** plugin-managed. Rewritten on every sync to reflect the current list of promoted task notes under this project. Don\'t edit inside the markers — your edits would be overwritten.');
  lines.push('');
  lines.push('### Properties');
  lines.push('');
  lines.push('| Property | Type | What it means |');
  lines.push('|---|---|---|');
  lines.push('| `status` | text | Project status set in PrimeTask (active, completed, archived, etc). |');
  lines.push('| `health` | text | One of `on_track`, `at_risk`, `behind`, `critical`, `completed`. Same value the PrimeTask dashboard shows. Empty when the calculator couldn\'t run. |');
  lines.push('| `progress` | number | Percentage complete, 0 to 100. Authoritative weighted value — combines tasks + milestones + goals the same way the app\'s project dashboard does. |');
  lines.push('| `task_count` | number | Total tasks in the project, including subtasks. |');
  lines.push('| `completed_count` | number | Tasks currently in a complete status. |');
  lines.push('| `overdue_count` | number | Tasks with a past due date that are not yet complete. |');
  lines.push('| `deadline` | date | Project deadline (local date). |');
  lines.push('| `start_date` | date | Project start date (local date). |');
  lines.push('| `is_archived` | checkbox | Whether the project is archived in PrimeTask. |');
  lines.push('| `promoted_tasks` | list of wikilinks | Every task note promoted under this project. Also rendered in the body block. |');
  lines.push('');
  lines.push('### Querying projects with Bases');
  lines.push('');
  lines.push('All numeric and date properties are typed, so Bases can filter and sort directly. Some examples:');
  lines.push('');
  lines.push('- Projects needing attention: `where health in ("at_risk", "behind", "critical")`.');
  lines.push('- Active with overdue work: `where overdue_count > 0 and is_archived = false`.');
  lines.push('- Due in the next two weeks: `where deadline <= today() + 14`.');
  lines.push('- Nearly done: `where progress >= 80 and status != "completed"`.');
  lines.push('');
  lines.push('Create a new Base, add the `Projects/` folder as a data source, and drop these into the Filter clause.');
  lines.push('');

  // -----------------------------------------------------------------
  // Hub files
  // -----------------------------------------------------------------
  lines.push('## Hub files (read-only)');
  lines.push('');
  lines.push('Four auto-generated files serve as graph anchors. They regenerate on every sync; edits to them are overwritten.');
  lines.push('');
  lines.push('- **App root (`PrimeTask.md`)** — top of the graph hierarchy. Links to your locked space and to this guide.');
  lines.push('- **Guide (`PrimeTask for Obsidian.md`)** — this file.');
  lines.push('- **Space hub (`PrimeTask - <Space>.md`)** — lists every promoted project and every promoted task note in the space. Un-promoted entities live in the sidebar only and do not appear here.');
  lines.push('- **Inbox hub (`PrimeTask - Inbox.md`)** — lists promoted task notes that are not attached to any project.');
  lines.push('');
  lines.push('Typing inside any hub file has no sync effect: the reconcile path skips hub types entirely. This is by design, so you don\'t accidentally trigger task or project creation by taking notes inside a hub file.');
  lines.push('');
  lines.push('Project notes (under `Projects/`) are **not** hub files — they are user-promoted entities with a plugin-managed Properties region and a user-owned body. See [Projects](#projects).');
  lines.push('');

  // -----------------------------------------------------------------
  // File organisation
  // -----------------------------------------------------------------
  lines.push('## File organisation');
  lines.push('');
  lines.push('Inside your configured mirror folder (defaults to `PrimeTask/`):');
  lines.push('');
  lines.push('```');
  lines.push('PrimeTask/');
  lines.push('├── PrimeTask.md                    app root (hub, read-only)');
  lines.push('├── PrimeTask for Obsidian.md       this file (hub, read-only)');
  lines.push('├── PrimeTask - <Space>.md          space hub (read-only)');
  lines.push('├── PrimeTask - Inbox.md            orphan promoted tasks (read-only)');
  lines.push('├── Projects/                       created on first project promote');
  lines.push('│   └── <Project>.md                one per promoted project');
  lines.push('└── Tasks/                          created on first task promote');
  lines.push('    └── <Task>.md                   one per promoted task or subtask');
  lines.push('```');
  lines.push('');
  lines.push('Nothing in `Projects/` or `Tasks/` is auto-created. Both folders stay empty until you promote your first item into them. Un-promoted tasks and projects live in the PrimeTask app and the sidebar only.');
  lines.push('');
  lines.push('You can also convert any existing note anywhere in your vault into a task or project — see [Creating tasks and projects](#creating-tasks-and-projects). Those notes stay wherever you wrote them; they don\'t get moved into `Tasks/` or `Projects/`.');
  lines.push('');

  // -----------------------------------------------------------------
  // Settings reference
  // -----------------------------------------------------------------
  lines.push('## Settings reference');
  lines.push('');
  lines.push('Every toggle in the plugin settings, what it does, and when to change it.');
  lines.push('');
  lines.push('### Connection');
  lines.push('');
  lines.push('- **Enable sync** — master switch. When off, the plugin stops all syncing and network activity but leaves your files alone. Useful if you want to pause syncing without uninstalling.');
  lines.push('- **Show status indicator** — shows a coloured dot + label in Obsidian\'s status bar (bottom-right) reflecting the plugin\'s connection state. Hide if you prefer a minimal status bar.');
  lines.push('- **Status** (display only) — shows the current connection state and the local port in use.');
  lines.push('- **Authorization** — `Authorize...` button when not authorized, `Revoke on this device` when authorized. See [Getting started Step 3](#step-3-authorize-this-vault).');
  lines.push('');
  lines.push('### Sync preferences');
  lines.push('');
  lines.push('- **Locked space** — dropdown. Required for the mirror to run. Obsidian only ever reads and writes to the space you pick here, regardless of which space is active in the PrimeTask app. Switch spaces freely in PrimeTask; Obsidian stays on the locked one.');
  lines.push('- **Sync tasks** — keep tasks flowing between Obsidian and PrimeTask. On by default.');
  lines.push('- **Sync projects** — keep project metadata in sync. On by default.');
  lines.push('- **Sync CRM** — locked as **Coming soon**. CRM mirroring is being built.');
  lines.push('');
  lines.push('### Markdown mirror');
  lines.push('');
  lines.push('- **Enable markdown mirror** — off by default. When on, the plugin maintains the hub files + any notes you promote. See [Getting started Step 5](#step-5-enable-the-markdown-mirror).');
  lines.push('- **Mirror folder** — folder name inside your vault where PrimeTask files live. Defaults to `PrimeTask`. Created automatically.');
  lines.push('- **Projects (with tasks)** — legacy compatibility toggle. Projects are now opt-in promote-on-demand; this toggle is a no-op for project file generation and can be left on.');
  lines.push('- **Milestones / Goals** — reserved for upcoming releases. Milestone + goal mirroring is not yet wired; toggles are inert.');
  lines.push('- **Contacts / Companies / Activities** — locked as **Coming soon** (CRM is being built).');
  lines.push('- **Contact / Company file strategy** — legacy layout choice for CRM mirroring. Not active.');
  lines.push('- **Rename files when entities rename** — when on, renaming an entity in PrimeTask also renames the corresponding `.md` file in your vault. Off by default to avoid surprise moves.');
  lines.push('- **Regenerate all files** (button) — rebuilds hub files from current PrimeTask state. Promoted task + project notes are untouched. Use this if you\'ve deleted hub files or want a clean slate.');
  lines.push('');
  lines.push('### Advanced');
  lines.push('');
  lines.push('- **Log level** — how chatty the plugin is in Obsidian\'s developer console. `warn` is the default; set to `debug` when filing a bug report.');
  lines.push('- **Reset plugin data** (button) — clears the auth token and cached preferences. Your notes in the vault are not touched. Use this if authorization gets into a stuck state.');
  lines.push('');
  lines.push('### Fallback (legacy)');
  lines.push('');
  lines.push('- **Enable fallback** and **Fallback folder** — older markdown-write path used when the PrimeTask app isn\'t reachable. The markdown mirror supersedes this; leave the defaults.');
  lines.push('');

  // -----------------------------------------------------------------
  // What doesn't sync
  // -----------------------------------------------------------------
  lines.push('## What doesn\'t sync');
  lines.push('');
  lines.push('- **Body content of task notes** — always local to your vault. Write anything you want below the heading; it never reaches PrimeTask.');
  lines.push('- **Body content of project notes**, EXCEPT the marker-bounded `## Promoted tasks` block. Everything outside the markers is user-owned and untouched. Inside the markers is plugin-managed and will be overwritten on every sync.');
  lines.push('- **Hub file edits** — the app root, space hub, Inbox, and this guide are regenerated from server state every sync. Any changes you make to them are overwritten.');
  lines.push('- **Project note Properties** — plugin-managed, overwritten on every sync. Edit project metadata in the PrimeTask app.');
  lines.push('- **Tags on task notes** — PrimeTask → Obsidian only for now. To add, remove, or rename a tag, do it in PrimeTask.');
  lines.push('- **Project reassignment from Obsidian** — the `project` property shows which project a task belongs to, but editing it in Obsidian has no effect. Reassign a task\'s project in PrimeTask.');
  lines.push('- **Custom fields** — not yet surfaced in task-note Properties. Edit them in PrimeTask.');
  lines.push('');

  // -----------------------------------------------------------------
  // Deleting
  // -----------------------------------------------------------------
  lines.push('## Deleting');
  lines.push('');
  lines.push('**Deleting files in Obsidian never deletes anything in PrimeTask.** This is a safety choice: vault operations are too varied (sync conflicts, rebuilds, file sorting) to risk destructive server actions.');
  lines.push('');
  lines.push('- Delete a task note → the task stays in PrimeTask. The task simply becomes un-promoted; the next sync will NOT recreate the file. You can promote it again from the sidebar anytime.');
  lines.push('- Delete a project note → same story. Project stays in PrimeTask, becomes un-promoted in Obsidian, can be re-promoted from the sidebar.');
  lines.push('- Delete a hub file (app root, space hub, Inbox, guide) → regenerates on the next sync.');
  lines.push('- Delete the entire mirror folder → hub files regenerate; promoted entities become un-promoted (no `.md` files). You\'d need to promote things again from the sidebar or re-convert notes.');
  lines.push('');
  lines.push('To delete a task or project for real, do it in the PrimeTask desktop app.');
  lines.push('');

  // -----------------------------------------------------------------
  // Troubleshooting
  // -----------------------------------------------------------------
  lines.push('## Troubleshooting');
  lines.push('');
  lines.push('### The status bar shows Disconnected');
  lines.push('');
  lines.push('- Confirm PrimeTask is running on the same machine.');
  lines.push('- Open PrimeTask → Settings → External Integrations → make sure the master toggle is on.');
  lines.push('- In Obsidian plugin settings, click **Authorize...** if the button is enabled; if it\'s greyed out, the plugin hasn\'t seen PrimeTask yet (wait a few seconds or restart Obsidian).');
  lines.push('');
  lines.push('### The status bar shows "Paused in PrimeTask"');
  lines.push('');
  lines.push('This means the plugin is still authorized (token intact) but has been disabled from PrimeTask\'s **Connected plugins** list. The server returns 403 for this plugin\'s requests until you re-enable it. No need to re-authorize.');
  lines.push('');
  lines.push('- In PrimeTask, go to **Settings → External Integrations → Connected plugins**.');
  lines.push('- Find the plugin row and flip the **Enabled** toggle on.');
  lines.push('- Obsidian detects the change on the next ping (~10s) and flips back to Connected automatically.');
  lines.push('');
  lines.push('Use this Pause toggle when you need to temporarily stop one plugin from talking to PrimeTask without revoking + re-authorizing it later. The master **External Integrations** toggle still works as a kill switch for all plugins + MCP + deep links.');
  lines.push('');
  lines.push('### Authorization failed or got stuck');
  lines.push('');
  lines.push('- In Obsidian plugin settings, scroll to **Advanced** → **Reset plugin data**. This clears the token. Then re-run authorize from Step 3.');
  lines.push('- Also revoke the matching entry in PrimeTask → Settings → External Integrations → Connected plugins, to avoid stale records on the app side.');
  lines.push('');
  lines.push('### Nothing appears in the sidebar');
  lines.push('');
  lines.push('- Make sure you\'ve picked a **Locked space** in settings. Without one, the sidebar shows an empty state.');
  lines.push('- Check that the locked space actually has tasks or projects in PrimeTask.');
  lines.push('');
  lines.push('### No `.md` files are being created');
  lines.push('');
  lines.push('- The markdown mirror is off by default. Turn on **Enable markdown mirror** in settings.');
  lines.push('- Confirm the **Mirror folder** name doesn\'t conflict with an existing folder you don\'t want touched.');
  lines.push('');
  lines.push('### A task note\'s properties revert after I edit them');
  lines.push('');
  lines.push('- This is correct behaviour for **hub files** (app root, space hub, Inbox, guide). Edit in PrimeTask instead.');
  lines.push('- It\'s also correct for **project note Properties** — project metadata is plugin-managed. Edit projects in PrimeTask.');
  lines.push('- For **task / subtask notes**, properties should stick. If they revert, something\'s wrong with the sync direction detection. Set **Log level** to `debug`, reproduce the issue, and file a report.');
  lines.push('');
  lines.push('### A project note\'s `## Promoted tasks` section keeps resetting');
  lines.push('');
  lines.push('Expected. That block is plugin-managed — it lives between the `<!-- primetask:promoted-tasks:start -->` and `<!-- primetask:promoted-tasks:end -->` markers and regenerates on every sync to reflect the current list of promoted tasks. Write your own notes ABOVE or BELOW the markers; content outside them is preserved verbatim.');
  lines.push('');
  lines.push('### Dates look off by one day');
  lines.push('');
  lines.push('- The plugin writes dates in your local timezone. If you\'ve just upgraded the plugin, restart Obsidian so the Properties widget picks up updated date type registrations.');
  lines.push('');
  lines.push('### Tags I add in Obsidian disappear');
  lines.push('');
  lines.push('- Expected for now. Tag sync is Obsidian → PrimeTask one-way is not wired yet; only PrimeTask → Obsidian works. Add tags in PrimeTask.');
  lines.push('');
  lines.push('### I want to start over');
  lines.push('');
  lines.push('- Delete the mirror folder from your vault.');
  lines.push('- Click **Regenerate all files** in the plugin settings. All hub files and task notes rebuild from current server state.');
  lines.push('');

  const content = lines.join('\n') + '\n';
  await writeFileIfChanged(ctx, path, content, 'guide:primetask', 'app', []);
}

// ---------------------------------------------------------------------------
// Migration: rename legacy hub files to the prefixed naming scheme
// ---------------------------------------------------------------------------

async function migrateLegacyHubFiles(ctx: GenerationContext, root: string): Promise<void> {
  const renames: Array<{ from: string; to: string; reason: string }> = [
    { from: `${root}/Inbox.md`, to: `${root}/${INBOX_FILENAME}`, reason: 'Inbox hub' },
    // Guide filename changed from `PrimeTask - Guide.md` to
    // `PrimeTask for Obsidian.md` to reflect that it's the plugin's
    // manual, not a general PrimeTask guide. Auto-rename preserves any
    // backlinks the user might have added to the old filename (Obsidian
    // updates wikilinks on rename when "Automatically update internal
    // links" is on, which is the default).
    { from: `${root}/PrimeTask - Guide.md`, to: `${root}/${GUIDE_FILENAME}`, reason: 'Guide rename' },
  ];
  if (ctx.spaceName) {
    renames.push({
      from: `${root}/${safeFilename(ctx.spaceName)}.md`,
      to: `${root}/${spaceHubFilename(ctx.spaceName)}`,
      reason: 'Space hub',
    });
  }

  for (const { from, to, reason } of renames) {
    const fromNorm = normalizePath(from);
    const toNorm = normalizePath(to);
    if (fromNorm === toNorm) continue;
    const fromFile = ctx.vault.getAbstractFileByPath(fromNorm);
    if (!(fromFile instanceof TFile)) continue;
    // Safety: only migrate files we actually generated. If the user has a
    // personal "Inbox.md" or "<SpaceName>.md" they wrote themselves, it
    // won't be in `state.files` and we leave it alone.
    if (!ctx.state.files[fromNorm]) continue;
    if (ctx.vault.getAbstractFileByPath(toNorm)) continue; // new target already exists
    try {
      // Own-write both paths — rename fires both 'rename' and 'modify'-like
      // events depending on Obsidian's internals. Guard both.
      ctx.markOwnWrite?.(fromNorm);
      ctx.markOwnWrite?.(toNorm);
      await ctx.vault.rename(fromFile, toNorm);
      console.info(`[PrimeTask] Migrated legacy ${reason}: ${fromNorm} → ${toNorm}`);
    } catch (err) {
      console.warn(`[PrimeTask] Legacy ${reason} rename failed`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Inbox file
// ---------------------------------------------------------------------------

async function writeInboxFile(
  ctx: GenerationContext,
  path: string,
  tasks: PrimeTaskTask[],
  promotedMap: Map<string, string>,
): Promise<void> {
  // Only orphan tasks (no project) that have been promoted to notes show up
  // here as wikilinks. Un-promoted orphan tasks live in the PrimeTask
  // sidebar only; the Inbox hub is a pure wikilink aggregator, not a
  // capture surface.
  const promotedLinks: string[] = [];
  for (const t of tasks) {
    const stem = promotedMap.get(t.id);
    if (stem) promotedLinks.push(asWikilink(stem));
  }
  promotedLinks.sort();

  const frontmatter: Record<string, unknown> = {
    'primetask-type': 'inbox',
    'primetask-space': ctx.spaceName ?? undefined,
    space: ctx.spaceName ? asWikilink(spaceHubStem(ctx.spaceName)) : undefined,
    promoted_tasks: promotedLinks.length > 0 ? promotedLinks : undefined,
  };

  const lines: string[] = [];
  lines.push(stringifyFrontmatter(frontmatter).trimEnd());
  lines.push('');
  lines.push('# Inbox');
  lines.push('');
  lines.push('Orphan tasks (no project assigned) that have been promoted to notes. To capture new tasks into PrimeTask:');
  lines.push('');
  lines.push('- **Right-click selected text** in any note → **Send selection to PrimeTask** (task only) or **Send selection to PrimeTask and link here** (task + linked note).');
  lines.push('- Use the sidebar **+** button, or the command palette.');
  lines.push('');
  lines.push('## Promoted tasks');
  lines.push('');
  if (promotedLinks.length === 0) {
    lines.push('_No orphan task notes yet._');
  } else {
    for (const link of promotedLinks) lines.push(`- ${link}`);
  }

  const content = lines.join('\n') + '\n';
  // Empty tasks array — hub files don't track checkbox state.
  await writeFileIfChanged(ctx, path, content, 'inbox', 'inbox', []);
}

// ---------------------------------------------------------------------------
// Space hub file
// ---------------------------------------------------------------------------

async function writeSpaceFile(
  ctx: GenerationContext,
  path: string,
  spaceName: string,
): Promise<void> {
  // Scan mirror state for user-promoted entities in this space. Opt-in
  // model: un-promoted projects and tasks live in the sidebar only, the
  // hub lists only what the user has chosen to surface as notes.
  const promotedTaskLinks: string[] = [];
  const promotedProjectLinks: string[] = [];
  for (const fileState of Object.values(ctx.state.files)) {
    const file = ctx.vault.getAbstractFileByPath(fileState.path);
    if (!(file instanceof TFile)) continue;
    if (fileState.type === 'task' || fileState.type === 'subtask') {
      promotedTaskLinks.push(asWikilink(file.basename));
    } else if (fileState.type === 'project') {
      promotedProjectLinks.push(asWikilink(file.basename));
    }
  }
  promotedTaskLinks.sort();
  promotedProjectLinks.sort();

  // Preserve the original mirrored_at timestamp across regens so the user
  // can see when the space was first linked. Only bumped updated_at changes.
  const existing = ctx.state.files[path];
  const previousMirroredAt = (existing as any)?.mirroredAt as string | undefined;
  const nowIso = new Date().toISOString();
  const nowLocal = toLocalDatetimeFrontmatter(nowIso);

  const frontmatter: Record<string, unknown> = {
    'primetask-type': 'space',
    'primetask-space-name': spaceName,
    // Every space is a child of the app root in the graph hierarchy. Makes
    // the App → Space → Tasks chain explicit in Obsidian's graph view.
    origin: asWikilink('PrimeTask'),
    is_shared: ctx.lockedSpace?.isShared ?? undefined,
    // Local-naive datetime format so Obsidian displays in wall-clock time.
    mirrored_at: toLocalDatetimeFrontmatter(previousMirroredAt) || nowLocal,
    updated_at: nowLocal,
    promoted_projects: promotedProjectLinks.length > 0 ? promotedProjectLinks : undefined,
    promoted_tasks: promotedTaskLinks.length > 0 ? promotedTaskLinks : undefined,
  };

  const lines: string[] = [];
  lines.push(stringifyFrontmatter(frontmatter).trimEnd());
  lines.push('');
  lines.push(`# ${spaceName}`);
  lines.push('');
  lines.push('Your PrimeTask space. Hub for every project, task, and subtask you promote from the sidebar.');
  lines.push('');
  lines.push('Part of [[PrimeTask]].');
  lines.push('');
  lines.push('## Inbox');
  lines.push('');
  lines.push(`- [[${INBOX_FILENAME.replace(/\.md$/, '')}]]`);
  lines.push('');
  lines.push('## Promoted projects');
  lines.push('');
  if (promotedProjectLinks.length === 0) {
    lines.push('_None yet. Right-click a project in the sidebar → Promote project to note._');
  } else {
    for (const link of promotedProjectLinks) lines.push(`- ${link}`);
  }
  lines.push('');
  lines.push('## Promoted tasks');
  lines.push('');
  if (promotedTaskLinks.length === 0) {
    lines.push('_None yet. Right-click a task in the sidebar → Promote to task note._');
  } else {
    for (const link of promotedTaskLinks) lines.push(`- ${link}`);
  }

  const content = lines.join('\n') + '\n';
  await writeFileIfChanged(ctx, path, content, `space:${spaceName}`, 'space', []);
  // Stash mirrored_at on the state entry so future regens preserve it.
  if (ctx.state.files[path] && !previousMirroredAt) {
    (ctx.state.files[path] as any).mirroredAt = nowIso;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isLegacyOrServerDone(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'done' || s === 'completed' || s === 'complete';
}

async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  if (vault.getAbstractFileByPath(normalized)) return;
  try {
    await vault.createFolder(normalized);
  } catch (err) {
    // Folder may have been created by a race — ignore if it now exists.
    if (!vault.getAbstractFileByPath(normalized)) throw err;
  }
}

async function writeFileIfChanged(
  ctx: GenerationContext,
  path: string,
  content: string,
  primetaskId: string,
  type: EntityType,
  tasks: PrimeTaskTask[],
): Promise<void> {
  const existing = ctx.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    // Mark BEFORE the write — the 'modify' event fires synchronously
    // during vault.process, and the watcher's echo check needs the mark
    // set by then.
    ctx.markOwnWrite?.(path);
    // vault.process is atomic and race-safe for files not currently
    // open in an editor. The callback receives current content; we
    // return the desired content. When the two match, vault.process
    // skips the disk write entirely (same no-op behaviour as the
    // previous "if (current !== content) modify" pattern, just
    // pushed inside the API).
    await ctx.vault.process(existing, () => content);
    // Intentionally FALL THROUGH to the state snapshot below. Even when
    // content is identical and the disk write is skipped, state.files[path]
    // must be populated so future diffs have a valid baseline. Without
    // this, a fresh install / post-migration / data.json reset path that
    // the user then edits produces phantom move-project deltas.
  } else {
    ctx.markOwnWrite?.(path);
    await ctx.vault.create(path, content);
  }

  // Snapshot state for future diffs.
  const fileState: MirrorFileState = {
    path,
    primetaskId,
    type,
    mtime: Date.now(),
    checkboxes: {},
  };
  // Flatten tasks for state tracking (track parent relationships).
  const flatten = (list: PrimeTaskTask[], parent: string | null, line: { n: number }) => {
    for (const t of list) {
      fileState.checkboxes[t.id] = {
        line: line.n++,
        done: isLegacyOrServerDone(t.status),
        name: t.name,
        parentId: parent,
      };
      if (t.subtasks && t.subtasks.length) flatten(t.subtasks, t.id, line);
    }
  };
  flatten(tasks, null, { n: 0 });
  ctx.state.files[path] = fileState;
}
