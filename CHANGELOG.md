# Changelog

## v0.1.2

Second round of beta-tester feedback fixes — clearer status when the desktop app is locked, faster authorise flow, and clickable tag chips in the sidebar.

### Added

- **"PrimeTask is locked" status indicator.** When the desktop app is on its lock/PIN screen, the plugin now shows a clear "PrimeTask is locked" message in the sidebar and status bar instead of the generic "PrimeTask is offline" text. Pairs with a desktop-side change in PrimeTask v0.6.4: the local API server stays running while locked but refuses every endpoint with HTTP 423 and reports `locked: true` from `/ping` so the plugin can distinguish "locked" from "the app is closed".
- **Typed `LockedError` from the API client.** Subsequent authenticated calls that hit a 423 response throw a typed error and converge the connection state to `locked` immediately, without waiting for the next `/ping` cycle.
- **Clickable tag chips in the sidebar task list.** Click any `#tag` chip on a task row to seed Obsidian's global search with `tag:#<name>` — finds every note carrying that tag (promoted task notes write the tag list into YAML frontmatter, which Obsidian indexes natively). Multi-word tag names are quoted automatically. Tag editing still happens in PrimeTask; the chips are read-only display + navigation surfaces.

### Changed

- The status bar reads `PrimeTask · locked` and the sidebar empty state suggests unlocking the desktop app rather than restarting it.

## v0.1.1

First round of beta-tester feedback fixes plus a community-plugin compliance pass.

### Added

- **Clickable status links on promoted-task lists in project notes.** Each promoted task now renders as `- [[Task]] · [Status Name](obsidian://...)` instead of a bare wikilink. Pure markdown — no inline HTML, no inline styles, fully portable across every markdown viewer and across all three Obsidian modes (Live Preview, Reading, Source). Clicking the wikilink opens the task note as before. Clicking the status link reveals the PrimeTask sidebar with that task focused, scrolled into view, and briefly highlighted — so you can change status from the sidebar's existing coloured picker (where colour belongs). The link avoids the dead-end of "why can't I edit this here?" by routing every click to a real action surface.
- **Multi-vault link safety.** Status pills include the active vault name in their `obsidian://` link. If you click a pill in Vault A while Vault B is also open, the click bails silently in the wrong vault instead of landing in the wrong workspace.
- **Hide archived projects toggle on the Projects tab.** A new eye-style icon next to the existing "show completed" toggle hides archived projects from the Projects tab (default on). Click to reveal archived projects when you need them — each shows a small **Archived** pill next to its name so you can tell active and archived rows apart at a glance.
- **Archived state reflects live in the sidebar.** Archive a project in PrimeTask and the sidebar updates within ~5s without needing a manual refresh.
- **Visual boundary around the promoted-tasks section.** The plugin-managed section in project notes is now wrapped between two horizontal rules (`---`) so you can see at a glance where the plugin's content ends and your own writing space begins. Type your own notes anywhere outside the rules; they will not be touched on sync.
- **Self-healing for accidentally deleted sections.** If you delete the promoted-tasks section (whether intentionally or by accident), the plugin detects the missing markers on the next ~5s poll and regenerates the section automatically. No need to re-promote anything in PrimeTask.
- **Create a task note in one step from the New Task modal.** A new "Create a task note in your vault" checkbox in the New Task modal (visible only when the markdown mirror is enabled) lets you create a task in PrimeTask AND its corresponding note file in your vault in a single submit. The note opens automatically after creation so you can drop your thinking into it right away.
- **Archived projects are now hidden from the New Task modal's project picker.** Same UX as the sidebar Projects tab — archived projects no longer clutter the dropdown when picking where a new task should land. If a task happens to be assigned to an already-archived project (e.g. someone archived it after you opened the modal), the project still shows in the list with an "(archived)" suffix so the selection stays meaningful.
- **Project backlink in promoted task notes.** Each promoted task note now has a `Part of [[Project Name]].` line in the body, alongside the existing "Captured from..." origin line. Click it to navigate up to the parent project note (or sit as a dangling reference if the project itself isn't promoted yet — still picked up by Obsidian's graph view + backlinks pane).
- **Completed tasks in project notes are visually de-emphasized.** Done tasks now sort to the bottom of the promoted-tasks list and render with a strikethrough on the wikilink (`~~[[Done Task]]~~ · [Done](...)`). Open tasks stay alphabetical at the top so the active working set is always front and centre. Pure Markdown — works in every viewer.

### Compliance with Obsidian Community Plugins guidelines

- **Frontmatter writes go through `app.fileManager.processFrontMatter`.** The plugin used to splice YAML manually via a custom parser/writer; v0.1.1 routes every frontmatter update on existing files through Obsidian's official atomic API. Plays nicely with other plugins editing the same file's properties (Bases, Dataview, etc.) and produces a consistent YAML layout.
- **Background file edits use `vault.process` instead of `vault.modify`.** All file rewrites on files that aren't currently open in an editor now go through Obsidian's atomic, race-safe API. No more "two plugins fighting over the same file" failure mode.
- **User-defined paths normalised through `normalizePath()`.** The Mirror folder setting is now scrubbed for cross-platform safety: forward/backward slashes collapsed, leading/trailing separators stripped, non-breaking spaces replaced, Unicode NFC normalised.
- **Command IDs cleaned up.** Internal command identifiers no longer duplicate the plugin id prefix; user-visible command palette entries are unchanged.
- Manifest description tightened to follow the Obsidian style guide (action-led, plain language, ends with a period).

### Changed

- Project notes refresh whenever a promoted task's status (or its colour) changes in PrimeTask, not only when the list of promoted tasks itself changes. Previously a status flip in PrimeTask left the project note showing stale state until something else triggered a rewrite.
- The `<!-- primetask:promoted-tasks:start -->` / `:end -->` section markers inside project notes are now hidden in Obsidian's Live Preview mode (already invisible in Reading mode). Source mode keeps them visible so power users can still see the boundaries the plugin manages.

### Notes

- The pill section inside a project note is plugin-managed (between the `<!-- primetask:promoted-tasks:* -->` markers). Edits made directly to the pill text or order will be overwritten on the next sync — change status from the sidebar instead, or edit the task note's frontmatter (which syncs back).
- Status colours match exactly what you set in PrimeTask. Statuses without a colour configured fall back to a neutral grey pill.

## v0.1.0-beta.1

Initial beta release of PrimeTask for Obsidian.

### Added

- Browse PrimeTask tasks and projects from inside Obsidian.
- Connect Obsidian to the local PrimeTask desktop app.
- Promote PrimeTask tasks and projects into linked Obsidian notes.
- Mirror selected PrimeTask data into Markdown files for use with Obsidian workflows.
- Create PrimeTask tasks from Obsidian.
- Keep all communication local between Obsidian and PrimeTask.

### Notes

- This is an early beta release for invited testers.
- PrimeTask desktop support for this integration is required.
- The plugin is intended to be installed from official PrimeTask release packages only.
