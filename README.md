<p align="center">
  <img src="public/Logo/Primetask_logo.png" alt="PrimeTask" width="320" />
</p>

# PrimeTask for Obsidian

Your [PrimeTask](https://primetask.app) tasks and projects, live inside Obsidian. Browse them in a sidebar, promote any item into a linked note, query with Bases or Dataview. Runs locally, nothing leaves your machine.

> Free companion plugin. Requires the PrimeTask desktop app running on the same machine. macOS or Windows.

## What it does

- **Live sidebar** showing every task and project in your locked PrimeTask space, with status, priority, due date, and progress inline. Click to expand subtasks. Inline pills for quick edits.
- **Promote on demand.** Right-click any task or project in the sidebar to turn it into a `.md` file in your vault, or cascade-promote a whole project plus every task under it in one click.
- **Convert existing notes.** Right-click any note in your vault (no selection needed) to turn it into a PrimeTask task or project in place. Your body content stays untouched.
- **Capture from selection.** Select text inside any note, right-click, and either create a task note (with a wikilink back to your source) or fire-and-forget to PrimeTask.
- **Two-way sync on task Properties.** Status, priority, due date, progress, description, and the `done` checkbox all round-trip between Obsidian and PrimeTask.
- **Project dashboards as notes.** Promoted project notes carry typed Properties (progress, health, task counts, overdue count, deadline, start date, archive state) that match the PrimeTask dashboard exactly and let you filter + sort in Bases.
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
