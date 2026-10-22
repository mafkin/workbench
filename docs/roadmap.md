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
| 2 | Markdown notes | Done (branch `claude/inspiring-einstein-vwftq8`) |
| 3 | File browser | Done (branch `claude/inspiring-einstein-vwftq8`) |
| 3½ | Workflow steps, no repeated nav | Done (same branch); see below |
| 4 | Project cards | Done (same branch) |
| 5 | Agent chats | Done (same branch) |
| 5½ | Agent profiles | Done (same branch); see below |
| 6 | Skills & MCP panel | Next in the suggested order |
| 7 | Context folders | |
| 8 | Polish | |

The user may pick parts in a different order; ask. For each part, the "Ask" items below are the questions to put to the user before planning. Don't decide them silently.

### Part 2: Markdown notes (done)

- **In Mr. Mak:** Markdown opens as a formatted document, an Edit switch edits it in the same window, and saving writes back to the file. Images, video and audio preview next to the file tree. It uses `react-markdown` + `remark-gfm`.
- **Decisions (2026-10-21):**

  | Question | Answer |
  | --- | --- |
  | Where notes live | A `notes:` folder per profile, plus note entries pointing at any file |
  | Editing style | View/Edit toggle in place (Ctrl+E); the editor is CodeMirror 6 |
  | Extras | All four: quick-create, search, wiki links, daily notes |
  | Saving | Autosave (1 s), paused on a conflict with Reload from disk / Keep mine |

- **Built:**
  - `server/notes.ts` with confinement by realpath, rev-checked atomic saves, list, search, images and folder watches.
  - The `setProfileField` op, so the UI can set `notes:` without losing comments.
  - The `daily` entry type: `folder` and `template` are relative to the notes folder; the template fills `{{date}}` and `{{title}}`.
  - Back navigation, which part 3's file browser can reuse.
- **Left for later:** see "Known gaps" in CLAUDE.md (no search index, `#heading` in wiki links, clickable checkboxes, links that follow a rename, code highlighting).

### Part 3: File browser (done)

- **In Mr. Mak:**
  - A right-hand Files rail with Main folders / All files tabs, chips that jump to key folders, a path bar, and a filter by name.
  - A folder tree showing file sizes.
  - Drag to move, delete to the trash, "open in file manager", new item, refresh.
  - Previews for images, video, audio and Markdown.
- **Hooks into:** `folder` entries (before this part, a placeholder with "Open in Files"), and each profile's `home:` as the default root.
- **Decisions (2026-10-21):**

  | Question | Answer |
  | --- | --- |
  | Placement | The main pane |
  | Chips | Built from the profile: home, notes folder, folder entries |
  | Operations | All: trash, rename, new folder or file, drag to move |
  | Previews | All: images, Markdown and text/code, PDF, video and audio |
  | Folder view | Expandable tree |
  | Hidden files | Dotfiles hidden (Ctrl+H), `.gitignore` matches dimmed |
  | Reach | The profile's roots (home, notes, folder entries) |
  | Markdown in the browser | Editable as notes |

- **Built:**
  - `server/files.ts`, with confinement in `server/paths.ts` shared with notes.
  - `/raw/` tickets for media.
  - `FolderWatcher` shared with notes.
  - `FileBrowser` and `FilePreview` in the UI.
  - `files:<path>` selections.
  - Folder chips on Home.
- **Left for later:** see "Known gaps" in CLAUDE.md (trash undo, cross-drive moves, copy, upload, folder sizes, virtualized rows).

### Between parts 3 and 4: workflow steps

The user asked for this before part 4: "no overlap in the selections". The centre repeated the nav (Home cards, folder chips). The user wants to "choose a project from the left and preserve the center for my customizable workflow", with workflow items like "assets", "modeling" and "design" that they name and customise.

| Question | Answer |
| --- | --- |
| What a step opens | A folder, a note or a launcher |
| Shared or per project | A profile default (`workflow:`), and each project can customise its own (`steps:`) |
| Where stored | The profile YAML |
| Home | Recent work plus today's note, instead of the nav cards |

Built: `StepItem` and the step ops, `ProjectView` with tabs, step mode in the entry dialog, `/api/open` with a step index, and Home as Recent work. The file browser's chips and Home's cards and chips are gone.

### Part 4: Project cards (done)

- **In Mr. Mak:** a `workspace.json` registry of entities with these fields: `id`, `title`, `description`, `icon`, `category`, `created`, `updated`, `folder`, `steps[] {name, path}` (tabs inside the card), `defaultStep`, `status` (active, done or archived) and `pinned`.
  - The dashboard groups cards by category, with a Pinned section on top.
  - Each card shows a category chip, title, description and "N steps · date".
  - Clicking the status dot changes status, category, pin or archive. Archived cards can be restored from search or "Show archive".
  - Tabs inside a card hold related iterations: HTML reports in an iframe, Markdown formatted, image previews.
- **Hooks into:** `project` entries (`project: <id>`). The Home overview could also become or include the card dashboard.
  - A card's tabs can reuse `FilePreview` (images, PDF, Markdown, text) and `NoteView` for notes. Any new file access goes through `browseRoots` in `server/paths.ts`.
  - **Workflow steps already cover Mr. Mak's `steps[]` tabs** for folder entries (`ProjectView`). Ask whether part 4's cards should build on folder entries and their steps rather than add a separate registry with its own tabs. Respect the "no repeated nav" rule: a card dashboard on Home would repeat the nav unless it shows something the nav doesn't (status, category, pinned).
- **Decisions (2026-10-21):**

  | Question | Answer |
  | --- | --- |
  | Card model | Folder entries are the cards; no separate registry, and `type: project` is removed |
  | Card details | Description, status (active, paused, done, archived), category (with colours), pinned |
  | Placement | The project page header and the nav (dots, pinned first, archive toggle); no dashboard |
  | New tab kinds | HTML report, single file, web link |

- **Built:**
  - The `setCard` op and `categoryColor`.
  - The card header in `ProjectView`, plus nav marks and menu.
  - The report, file and link step kinds.
  - Folder tickets for reports, and the `/raw/` guard exception for sandboxed reports.
- **Left for later:** category colours from the UI, and created or updated dates.

### Part 5: Agent chats (done)

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
- **Decisions (2026-10-21):**

  | Question | Answer |
  | --- | --- |
  | View | Terminal only (xterm.js); no Conversation view |
  | Placement | Tabs in the project, after its workflow steps |
  | Start points | New chat in a project (and the nav menu), a `chat` workflow step, Chat here in the file browser, a `chat` nav entry |
  | History | Chats keep running across reloads; a per-project History of Claude sessions, resumed with `claude --resume` |
  | Agents | Claude plus a shell |
  | Extras | Drop files as paths, a needs-you marker and notification, pin and colour, summarize and continue |
  | Nav | A spark on projects (and chat entries) with running chats |
  | Restart | Tabs come back as Stopped; Resume by hand, nothing starts by itself |

  Approved in the plan: pins, colours and names live in the service's chat list (`~/.local/state/workbench/chats.json`), not the YAML, because they belong to one running session.

- **Built:**
  - `ChatItem` (`agent`, `path`, `args`) as a nav entry and a step; host and slot keys from paths and labels.
  - `server/chats.ts`: node-pty (loaded with the first chat) with a headless xterm per chat for screen replay; titles, bell and quiet-after-work for needs-you; the saved list; resume by `--session-id`/`--resume`; handoff via `claude -p --resume <id> --fork-session`.
  - `server/claude-sessions.ts` for History and message counts.
  - `/api/chats` routes by address, the `/pty/:id` socket with a per-start token in `Sec-WebSocket-Protocol`, guarded in `preValidation`.
  - `ChatPane`, the lazy `ChatTerminal`, chat tabs, New chat and History in `ProjectView`, Chat here in the browser, the chat entry page, Other chats on Home, nav marks, notifications.
- **Left for later:** following `/clear` or `/resume` inside a chat (the tab resumes the session it started with); keeping a running chat when its step is renamed; switching tabs while dragging over them.

### After part 5: agent profiles (done)

The user asked for "agent profiles I can prepare and choose when initiating sessions inside projects or specific folders".

| Question | Answer |
| --- | --- |
| What a profile sets | Model and effort, permission mode, instructions (and a first prompt), folders, tools and MCP. "Model and effort can be bypassed if an orchestrator agent is being used" |
| Orchestrator | A profile can name a Claude Code agent (`--agent`); then model and effort are left to it |
| Editing | In the app, saved under `agents:` in the profile YAML |
| Choosing | A menu by New chat (also Chat here as…, New chat as… in the nav) |
| Defaults | A project names its default (`agent:` on the folder entry, set from a chip in the card); chat steps and entries name theirs |
| Permissions | All modes; bypass warns in the editor and marks its chats with a shield |

- **Built:** `AgentProfile` and `agents:` in the schema, `chatProgram`, `findAgent`, `agentSummary`; the `setAgent` op (rename updates references, a delete is refused while in use); `server/agents.ts` (`agentArgs`, `claudeAgents`); start-time resolution in `POST /api/chats` (request, else step or entry, else project default); `GET /api/chats/claude-agents`; `AgentProfilesDialog`, `agentEntries` menus, the agent chip, bypass marks.
- **Fixed on the way:** a comment after `key:` whose value is a block map or list now stays on the key's line through app edits (`applyOps` gets the source text); saves of `chats.json` are serialized (two at once collided on the temp file); `countPrompts` never rejects.
- **Left for later:** a chat started with a profile keeps its flags when the profile changes (by design); no per-folder rules (a profile can't claim `~/Projects/games/**`).

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
