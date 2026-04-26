<p align="center">
  <img src="public/Logo/Primetask_logo.png" alt="PrimeTask" width="320" />
</p>

# PrimeTask for Obsidian

Built on a deliberate idea: [PrimeTask](https://primetask.app) stays your task and project tool, and Obsidian stays where your thinking happens. The plugin connects the two without trying to turn either into the other.

The flow most people use day to day is the simplest one. You are writing in a note, you have an idea worth doing, you select the sentence, right-click, and **Send selection to PrimeTask and link here**. The selected text becomes a `[[wikilink]]` to a new task note, the task is born inside PrimeTask, and the task carries a permanent backlink to the note that produced it. You can always trace any task back to the thought it came from.

> Free companion plugin. Requires the PrimeTask desktop app running on the same machine. macOS or Windows.

## How this is different

Most Obsidian task plugins try to make Obsidian into a task manager. This one does the opposite. PrimeTask remains your execution layer (Focus Mode, Gantt, Kanban board, CRM, time tracking, recurring tasks, reports). Obsidian stays your capture and context layer, where ideas are born and notes accumulate around them.

This is why:

- The marquee flow is **note to task**, not the other way. There is no "push every task into the vault" button, and no way to start a promote from inside PrimeTask itself — that would invert the design.
- Task notes are **graph nodes**, not checkbox lines. Every promoted task is its own `.md` file with rich frontmatter (status, priority, due date, progress) so Bases and Dataview can query your vault as a personal task database.
- The vault stays clean by default. Nothing is auto-mirrored. Promotion is always explicit and user-initiated.
- Every task remembers where it came from, with `origin: [[Source Note]]` in its frontmatter and a `Captured from [[Source Note]]` line in the body. No other task manager can do this — Todoist, Linear, ClickUp, even Notion don't give you a wikilink-everywhere backlinks pane on every task. Forever after, each task shows "born inside `[[Monday standup]]`", "decided in `[[Q4 strategy memo]]`", "raised by John in `[[call-2026-04-18]]`".

## What it does

- **Capture from selection** (the primary flow). Select text inside any note, right-click, and choose **Send selection to PrimeTask and link here** (heavyweight — replaces the selection with a wikilink to a new task note in your vault) or **Send selection to PrimeTask** (lightweight — creates a task in PrimeTask's Inbox only, no vault file, your note stays untouched).
- **Convert existing notes.** Right-click anywhere in a note with no selection and choose **Convert note to PrimeTask task** or **Convert note to PrimeTask project**. The note's H1 becomes the title, the body becomes the description, and the file stays exactly where it is.
- **New Task modal** in the sidebar with one-step capture: optional **Create a task note in your vault** checkbox creates the task AND its markdown note, then opens the note. Archived projects are hidden from the project picker by default.
- **Live sidebar** showing every task and project in your locked PrimeTask space, with status, priority, due date, and progress inline. Inline pills for quick edits. Filter by due, project, has-note, completed, and (on Projects) archived. Right-click any row to promote it into a note.
- **Two-way sync on task Properties.** Status, priority, due date, progress, description, and the `done` checkbox all round-trip between Obsidian and PrimeTask.
- **Clickable status links in project notes.** Each promoted task in a project's `## Promoted tasks` section carries a clickable status link that reveals the sidebar with that task focused — change the status from the sidebar's coloured picker without leaving the note. Completed tasks fade to the bottom with strikethrough on the wikilink.
- **Self-healing project notes.** If you accidentally delete the marker-bounded promoted-tasks section, the plugin regenerates it on the next sync (within ~5s). A `---` rule below the section gives you an unambiguous "type below this line" boundary so your own writing space is never overwritten.
- **Project dashboards as notes.** Promoted project notes carry typed Properties (progress, health, task counts, overdue count, deadline, start date, archive state) that match the PrimeTask dashboard exactly and let you filter and sort in Bases.
- **Query your tasks as a database.** Because every promoted task carries typed frontmatter, Obsidian's built-in **Bases** can render live, filterable, sortable tables of your tasks anywhere in your vault. No plugin install required. Frontmatter edits round-trip back to PrimeTask so editing a Bases table row updates PrimeTask too. Dataview works the same way if you have it installed.
- **Open in PrimeTask** body link on every promoted note jumps straight to the same item inside PrimeTask, ready for Focus Mode, Gantt, time tracking, or anything else. Promoted task notes also carry a `Part of [[Project]]` body link to navigate up to the parent project.
- **Nothing auto-pushed.** Task and project notes only appear when you explicitly promote them. The plugin stays out of your vault until you invite it in.

## Requirements

- Obsidian 1.12 or newer.
- PrimeTask desktop app (macOS or Windows) installed and running on the same machine.
- **External Integrations** enabled in PrimeTask → Settings.

Desktop-only. Obsidian Mobile is not supported because the plugin talks to the PrimeTask desktop app on a local port.

## Install

The plugin is currently in private beta. It is not yet published to the Obsidian Community Plugins store.

Beta testers install manually:

1. Download the latest release from the Releases page.
2. Unzip into `<your-vault>/.obsidian/plugins/primetask-sync/`.
3. Enable the plugin under Settings → Community plugins.
4. Follow the in-app setup guide (authorize, lock a space, enable the mirror).

After install, a full manual regenerates inside your vault at `PrimeTask/PrimeTask for Obsidian.md` on the first sync.

Official setup and troubleshooting guide:

- https://www.primetask.app/docs/integrations/obsidian-integration

## Privacy and security

- **All traffic is local.** The plugin talks to the PrimeTask app over `127.0.0.1`. Nothing crosses the public internet.
- **No telemetry.** The plugin collects nothing. It calls only the PrimeTask app.
- **Explicit authorization.** You approve the plugin once from inside the PrimeTask app with a 6-character code comparison. Revoke any time.
- **Official build recognition.** Official PrimeTask releases are recognized by PrimeTask during authorization. Modified or unofficial builds may appear as unrecognized in the authorization dialog.
- **Per-plugin kill switch.** Pause the plugin without revoking from PrimeTask's Connected Plugins UI.

## Development

```bash
# Install deps
npm install

# Symlink (or copy) this folder into a test vault:
#   <vault>/.obsidian/plugins/primetask-sync
ln -s "$(pwd)" "/path/to/vault/.obsidian/plugins/primetask-sync"

# Dev build (watches for changes)
npm run dev

# Production build
npm run build
```

Open the test vault in Obsidian, enable the plugin under Settings → Community plugins, and iterate. Reload Obsidian with `Cmd+R` to pick up rebuilds.

### Build recognition

Official PrimeTask releases are recognized by PrimeTask during authorization. Local or modified builds may appear as unrecognized during authorization.

For regular users, the important rule is simple: install official releases and only approve builds you trust.

## Roadmap

Shipped:

- Live sidebar (tasks, projects, subtasks).
- Task / subtask / project promotion from sidebar + selection + whole-note conversion.
- Two-way task Properties sync.
- Project note dashboards with auto-refreshing "Promoted tasks" section.
- Per-plugin pause toggle on the PrimeTask side.

Coming in v0.2:

- Milestones and goals mirroring (opt-in promote flow).
- Small polish informed by beta feedback.

Later:

- CRM (contacts, companies, activities) mirroring. Requires PrimeTask Pro.
- Bidirectional tag sync (Obsidian → PrimeTask).
- Bases starter views.

## License

[Apache-2.0](./LICENSE)
