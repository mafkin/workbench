# Roadmap, decisions and reference notes

This is the working memory for building Workbench part by part. Read it before starting a part, and update it when a part is done or a decision changes.

## Decisions so far (2026-10-21)

The user's original request was:

> An organized workbench for my Linux environment. A clean UI where I can switch between work and personal views, manage projects and files, documentation and notes. Dark aesthetic with tame colours for highlights. On the left an extensive nav panel with headings for each category of work, all configurable. Build it part by part the way I want. Use mr-mak-workspace for inspiration but don't take the whole project; look at its features and ask what I want.

These are the answers they gave:

| Question | Answer | Consequence |
| --- | --- | --- |
| Core features from Mr. Mak | All four: project cards, file browser, Markdown notes, agent chats | These are parts 2–5 |
| Extras | Skills & MCP panel, context folders. Phone access: "Keep normal /remote-control available. No separate app required." Voice: not chosen | No mobile app and no voice. Chats must be the real `claude` CLI in a PTY so `/remote-control` works |
| Work/personal switching | Separate profiles | Each profile has its own nav, folders, accent and (later) notes and projects. No shared section |
| App type | Local web app (Vite + React + Node service), wrapped in Tauri later if wanted | No Rust toolchain on the machine |
| What a nav entry can be | Folder, note, project card, link/launcher (all four) | Plus `group` for one level of nesting |
| Nav configuration | In the UI and in a file | Readable YAML per profile, editable in the app and by hand; comments survive app edits |
| Palette | "Slate & Sage" | Base `#141518`, panel `#1b1d21`, border `#2a2d33`, text `#d4d6db`, muted `#8a8f98`; work `#7d93ab`, personal `#8fa58a` |
| First part | Shell + nav panel | Done; see the Part 1 row in the table below |

Additions in part 1 that the user didn't explicitly choose, but approved in the part 1 plan:

- **Paths:** config in `~/.config/workbench/` with one file per profile; the port is 7420.
- **Seed:** the first-run nav is built from existing folders on the user's machine.
- **Security:** the request guard, and launches named by entry address, never by command.
- **Window:** GNOME Web app mode if installed, otherwise the default browser.

## Parts

| Part | Scope | Status |
| --- | --- | --- |
| 1 | Shell, profiles, configurable nav | Done (`2a8811a`) |
| 2 | Markdown notes | Next in the suggested order |
| 3 | File browser | |
| 4 | Project cards | |
| 5 | Agent chats | |
| 6 | Skills & MCP panel | |
| 7 | Context folders | |
| 8 | Polish | |

The user may pick parts in a different order; ask. For each part, the "Ask" items below are the questions to put to the user before planning. Don't decide them silently.

### Part 2: Markdown notes

- **In Mr. Mak:** Markdown opens as a formatted document, an Edit switch edits it in the same window, and saving writes back to the file. Images, video and audio preview next to the file tree. It uses `react-markdown` + `remark-gfm`.
- **Hooks into:** `note` entries, which open in `MainPane` instead of the current placeholder. The "Notes" heading in each seeded profile is empty, waiting for this part.
- **Ask:**
  - Where notes live: a notes root per profile (a `notes:` key in the profile YAML, e.g. `~/Documents/work/notes`), or anywhere a note entry points.
  - Editing style: a raw Markdown textarea with a toggle, side-by-side split, or WYSIWYG-ish.
  - Whether to have quick-create ("New note" under a heading, which also adds a nav entry), daily notes, search across notes, and wiki links.
  - Autosave or explicit save, and how to handle a conflict when the file changed on disk (reuse the rev/409 pattern from `config-store`).
- **Notes:**
  - File reads and writes need a new API. Scope it to paths under the profile's allowed roots, so the service can't read arbitrary files.
  - Keep the guard on every route.

### Part 3: File browser

- **In Mr. Mak:**
  - A right-hand Files rail with Main folders / All files tabs, chips that jump to key folders, a path bar, and a filter by name.
  - A folder tree showing file sizes.
  - Drag to move, delete to the trash, "open in file manager", new item, refresh.
  - Previews for images, video, audio and Markdown.
- **Hooks into:** `folder` entries (currently a placeholder with "Open in Files"), and each profile's `home:` as the default root.
- **Ask:**
  - Placement: the main pane, a rail, or both.
  - Which quick-jump chips to show, and whether they're configurable per profile.
  - Which operations: move, rename, delete to trash, new folder or file.
  - Which previews: image, video, audio, PDF, text/code.
  - Hidden files on or off, and whether to respect `.gitignore`.
- **Notes:** use `gio trash` or a trash library for deletes, never permanent deletes by default. Keep paths confined to the profile's roots plus explicit nav paths.

### Part 4: Project cards

- **In Mr. Mak:** a `workspace.json` registry of entities with these fields: `id`, `title`, `description`, `icon`, `category`, `created`, `updated`, `folder`, `steps[] {name, path}` (tabs inside the card), `defaultStep`, `status` (active, done or archived) and `pinned`.
  - The dashboard groups cards by category, with a Pinned section on top.
  - Each card shows a category chip, title, description and "N steps · date".
  - Clicking the status dot changes status, category, pin or archive. Archived cards can be restored from search or "Show archive".
  - Tabs inside a card hold related iterations: HTML reports in an iframe, Markdown formatted, image previews.
- **Hooks into:** `project` entries (`project: <id>`). The Home overview could also become or include the card dashboard.
- **Ask:**
  - Where the registry lives: per profile in `~/.config/workbench/projects/<profile>.yaml`, or a file inside each project folder.
  - Which card fields and categories they want.
  - What a card's tabs can be: notes, folders, URLs, HTML reports.
  - Whether a project card replaces or sits alongside folder entries.

### Part 5: Agent chats

- **In Mr. Mak:**
  - Chats are real CLIs in PTYs (`node-pty` 1.1.0 + `@xterm/xterm` 6 + `addon-fit` + `addon-web-links`), with tabs, history, pinning, colours and groups by project.
  - A Conversation|Terminal switch that reads the CLI's own transcript.
  - Permission menus shown as buttons, re-checked before any keys are sent.
  - Slash-command autocomplete, and edit-and-rewind of a sent message.
  - "Summarize and continue" handoff after 40 messages.
  - A recent-projects list taken from `~/.claude.json`, and dropped files inserted as paths.
- **Hard requirement:** run the real `claude` CLI so `/remote-control` keeps working for phone access.
- **Ask:**
  - Terminal-only, or also a Conversation view.
  - Where chats open (the main pane, a split, a separate window).
  - How chats tie to nav entries ("new chat here" on folder entries?).
  - History and resume, and which agents (Claude only, or also Codex).
- **Notes:**
  - **Security:** a PTY is shell access, so add a per-start random token on top of the guard. Pass it via the URL fragment or an `HttpOnly` cookie, and check it on the WebSocket upgrade.
  - **Build:** node-pty builds natively; gcc and make are present. Mr. Mak's spawn-helper chmod fix is macOS-only.

### Part 6: Skills & MCP panel

- **In Mr. Mak:**
  - A right rail with Skills, Knowledge, Workflows, MCP, Settings and Help.
  - The MCP view lists servers by scope:
    - global: `~/.claude.json` `mcpServers`
    - local: `~/.claude.json` `projects[<path>].mcpServers`
    - project: `.mcp.json`
    - managed: `managed-mcp.json`
    - plugins: their `.mcp.json`
  - Each server gets a connection check.
- **Ask:**
  - Read-only, or also enable and disable.
  - Which sources: user skills `~/.claude/skills`, plugin skills, project `.claude/skills`.
  - Whether to show per-project scope for the profile's folders.
- **Notes:** mask secret values (env vars, headers, tokens) everywhere. Read-only is the safe default.

### Part 7: Context folders

- **In Mr. Mak:**
  - `context/` holds identity, preferences and goals; `knowledge/` holds focused reusable notes; `processes/` holds workflows; `inbox/` holds attachments and handoffs.
  - A table says which kind of request belongs where, e.g. "Remember how I want reports written" goes to `context/preferences.md`.
- **Ask:**
  - Per profile or shared.
  - Where on disk.
  - Whether agent chats (part 5) should get these folders automatically, e.g. via `--add-dir` or a generated `CLAUDE.md`.
  - How they show in the nav (a fixed heading or ordinary entries).

### Part 8: Polish

These are candidates; ask which ones matter:

- Ctrl+K quick switcher across entries and notes.
- A systemd user service so the GNOME Web app launcher always finds the service running.
- UI for profile settings (name, accent, home) and for adding profiles.
- Selection that follows moved entries.
- Tauri wrapper (needs Rust).

## Reference

The reference is Mr. Mak Workspace (<https://github.com/witnesstodark/mr-mak-workspace>, MIT): a Tauri 2 shell with a React 19 UI and a Node service. The notes above summarize what's relevant, so re-reading it is only needed for specifics. Take ideas, not code wholesale; the user asked for that explicitly.
