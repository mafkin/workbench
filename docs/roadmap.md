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
| 5¾ | Sidebar open buttons, themes and backgrounds | Done (same branch); see below |
| 6 | Skills & MCP panel (built as Claude setup) | Done (same branch); see below |
| 7 | Context folders | Done (same branch); see below |
| 8 | Polish, the known gaps, Servers | Done (same branch); merged to `main` with parts 2–7 (PR #1) |
| 9 | Git per project | Done; merged to `main`; see below |
| 10 | Assets and media | Done (branch restarted from `main`); merged to `main` with the profile menu, drawers, MCP switches and items (PR #3); see below |
| 11 | The wiki: pages as configuration | Done; see below |
| 12 | Workspaces: drawer rail, pinned skills, chats dock | Done; see below |

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

Later, in part 6, the user said "No repeated nav is not an explicit rule, if it makes sense it should be implemented." Avoid repeating the nav by default, but a list of projects is fine where it serves a purpose, like the Claude setup page's For picker.

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

### After part 5: sidebar open buttons, themes and backgrounds (done)

The user asked: launchers in the sidebar started on a single click of their name; they wanted an explicit button with a hover highlight, and the text as just text. And themes ("a few example themes, your choice") with a background based on the theme, or their own picture.

| Question | Answer |
| --- | --- |
| Which entries get the button | Launchers and links |
| Scope of the look | Per profile (`theme:`, `background:` in its YAML) |
| How a background shows | Behind everything, frosted panels |
| Own picture | Picked from a file (file browser or path); the app keeps a copy in `<config>/backgrounds/` |

- **Built:** the open button in `NavPanel` (row click does nothing for launchers and links); `THEMES` and the six themes in `src/lib/themes.ts` (tokens plus a gradient background each); `server/backgrounds.ts` and `/api/backgrounds`; `LookPanel` (palette button in the sidebar header); "Use as background" in the file browser; the `.app.backdrop` frosted layout. The background follows the theme by default; None is the old flat look.
- **Left for later:** theme colours or new themes from the UI; a light theme (the app stays dark-only); per-picture tint or blur settings.

### Part 6: Skills & MCP panel, built as Claude setup (done)

- **In Mr. Mak:**
  - A right rail with Skills, Knowledge, Workflows, MCP, Settings and Help.
  - The MCP view lists servers by scope: global, local, project, managed and plugins.
  - Each server gets a connection check.
- **Decisions (2026-10-22):**

  | Question | Answer |
  | --- | --- |
  | Read-only, or enable and disable too | Read-only for now |
  | Which skill sources | All: yours, plugin and project skills |
  | Per-project view | Yes |
  | Where it shows | Both, to pick one later: a page from the sidebar and a project tab. "No repeated nav is not an explicit rule, if it makes sense it should be implemented. Start with both so I can decide if I want to drop one." |
  | The page | A page in the main pane, from a button in the sidebar header |
  | Checks | On demand, per server (and Check all): start it, do the MCP handshake, list its tools, stop it |
  | Also list | Claude agents, slash commands, hooks, plugins |
  | Project tab | What applies in this folder: merged user, project, local, plugin and managed config, each item with a scope badge |

- **Built:**
  - `server/claude-setup.ts` (`readSetup`): every source with its scope, name clashes, MCP states (on, off, not approved, blocked, overridden, broken) and plugins.
  - `server/mcp-check.ts`: stdio, Streamable HTTP and legacy SSE handshakes, protocol `2025-11-25`, falling back to tools/list without initialize.
  - `server/mask.ts`.
  - The routes `/api/claude/{setup,doc,check}`.
  - `ClaudeSetupView` (a lazy chunk) for the page (`setup:` selection) and the project tab (`setup:` saved tab).
  - The Theme and Agent profiles dialogs became lazy chunks, to keep the main bundle under 800 kB.
- **Formats that aren't documented** are read leniently. Shapes that don't match are listed as problems at the top of the page:
  - the layout of `installed_plugins.json` (v1 object or v2 array per id) and `known_marketplaces.json`,
  - the shape of `managed-mcp.json` (read like `.mcp.json`),
  - where `disabledMcpServers` is kept (read from `~/.claude.json` `projects[<folder>]`),
  - `.claude.json` inside `$CLAUDE_CONFIG_DIR` when that is set.
- **Left for later:**
  - Enabling or disabling things from the app (MCP servers came later; see the next section).
  - Watching claude's files (there is a Refresh button instead).
  - Skills in nested folders below the project (claude loads them when it works there).
  - Skills, agents or MCP servers passed only on the command line (`--agents`, `--mcp-config`); agent profiles name the latter.
  - OAuth sign-in for remote servers (done in claude with `/mcp`).

### MCP switches (after drawers, done)

- **Why:** chats for Blender work or the game loaded Slack, Gmail and the other plugin servers. `/mcp`'s off list is per folder, so turning them off once didn't reach other projects.
- **Decisions (2026-10-23):**

  | Question | Answer |
  | --- | --- |
  | Where a switch acts | Per folder, writing the same `disabledMcpServers` list as `/mcp`, so the app and `/mcp` agree |
  | Defaults | Off by default per profile (`mcpOff:`). The first chat the app starts in a folder turns them off there, once, so one switched back on stays on |
  | Hide | No separate Hide: servers that are off fold behind "N off · Show" |
  | Extras | A plugin's servers all at once (its detail pane). Not chosen: Approve/Reject for project servers, whole plugins on/off |

- **What claude does** (read from its binary, 2.x):
  - `/mcp` toggles write `projects[<key>].disabledMcpServers` in `~/.claude.json`. Plugin servers are named `plugin:<plugin>:<name>`, others by name.
  - `<key>` is the git root of the cwd (real path), else the cwd. `readSetup` used the folder itself before; it now uses `projectKey`.
  - There is no `claude mcp enable/disable`.
  - Spike on the desktop: a claude running in the folder saved its state after an outside write, and the outside change survived (claude checks the file's stats and re-reads it).
- **Built:**
  - `server/mcp-switch.ts`: `setFoldersOff`, which re-reads, changes only those lists, and writes atomically with the mode kept and claude's 2-space JSON. `McpDefaults` keeps the ledger (`mcp-defaults.json` in the state dir) of defaults already applied per folder.
  - `POST /api/claude/mcp`: keys must be listed and switchable. With a folder, it switches that folder. Without one, it runs the `setMcpOff` op (rev-checked) and switches every project.
  - `agentFor` applies the defaults before a claude chat starts.
  - `McpEntry.key` and `fixed` (blocked, broken and overridden servers can't be switched).
  - UI: the switch on rows and in the detail pane, the fold, the plugin buttons, and a toast with Undo.
- **Left for later:** Approve/Reject for `.mcp.json` servers; whole plugins on/off (`enabledPlugins`); defaults for folders outside the app's chats (a claude started in a terminal in a new folder loads everything until a switch or an app chat runs there).

### Items: blank entries built from removable steps (after MCP switches, done)

- **Why:** "Creating an item should give a blank slate. An item can then have a file-browser, note, git-tree etc. Those steps should then be removable. Removing a step does not delete files permanently."
- **Decisions (2026-10-23):**

  | Question | Answer |
  | --- | --- |
  | Which entries | Every new nav entry is an item: no kind to pick |
  | A new item shows | Nothing but an Add menu (File browser, Note, Git, Claude setup, More…); All files, Git and Claude setup are ordinary steps |
  | Existing entries | Kept as they are, nothing rewritten; old projects keep their tabs until their first step change |
  | `workflow:` | A template: Add profile steps / Save as profile steps |
  | Folder | Optional; a File browser, Git or Claude setup step asks for one |
  | One step | Full page, no tab row; the row shows from two tabs |
  | Card | On every item |
  | Removing | Only the tab; files stay, Undo in the toast |

- **Built:**
  - Schema: `type: item` is read as the one internal kind `folder` (a preprocess), and a line keeps its word on edit. `path` is optional. Step kinds `files`, `git`, `setup` (`FOLDER_STEPS`, `STEP_LABEL`). `legacySteps` gives an old project's tabs. `projectRef` (path, else `id:<id>`, else `label:<label>`) keys chats, saved tabs and pages. `itemBase` (folder, else the profile's home) is where relative step paths, launchers and chats start. `itemsWithFolder` is used by git and servers.
  - Ops:
    - `addItem` with `type: item` writes `steps: []` and, without a folder, an 8-character `id` (a letter first, so YAML never reads it as a number).
    - The first step op on an old project writes `seed`, the tabs it showed. The client sends it, or the ops route works it out with Git only in a repository (`stepsFor`).
    - `addStep` of a folder step takes `folder` for an item without one.
    - `addWorkflow` replaced `resetSteps`, and `setWorkflow` keeps the item's own steps.
  - UI:
    - ProjectView takes its tabs only from steps, with an empty state, single-step pages, Remove tab (also Delete) and the profile-steps menu.
    - ItemDialog has no kind picker for entries (Add item: label, optional folder, icon). The step dialog has the ten kinds and asks for the item's folder when needed.
    - `resolveEntry` keeps an entry selected when only its folder changed.
- **Left for later:**
  - Nav icons: a folderless item still shows the folder icon unless it names one.
  - Old entries can't be turned into items in the app.
  - A shared entry finds a folderless original by its label alone.

### Part 7: Context folders (done)

- **In Mr. Mak:**
  - `context/` holds identity, preferences and goals; `knowledge/` holds focused reusable notes; `processes/` holds workflows; `inbox/` holds attachments and handoffs.
  - A table says which kind of request belongs where.
- **Decisions (2026-10-22):**

  | Question | Answer |
  | --- | --- |
  | Per profile or shared | Per profile |
  | Where on disk | Inside the profile's notes folder: `<notes>/context`, `knowledge`, `processes`, `inbox` |
  | Chats | Every claude chat gets them automatically |
  | In the app | A fixed Context heading at the top of the nav |
  | First time | Set up context: the folders plus starter notes (identity, preferences, goals, the routing note); never by itself |
  | Routing | An editable note, `context/README.md`, whose text chats get |
  | Opening an entry | The folder in the file browser; Context also has tabs for its notes |
  | Inbox extras | Count badge in the nav; Summarize and continue saves its handoff there; Send to inbox in the file browser |

- **Built:**
  - `server/context.ts` (`Context`: status, setup, `chatContext`, `saveHandoff`, `sendToInbox`, watching for the inbox count) and `/api/context{,/setup,/inbox}`, with the SSE event `context`.
  - `agentArgs` merges the context: one `--append-system-prompt` (the profile's instructions first) and one `--add-dir`.
  - `Chat.context`, shown in the chat bar.
  - `handoff(id, {onSummary})`.
  - The nav's `ContextBlock`, `ContextView` (`context:<name>` selection), and Send to inbox in `FileBrowser`.
- **What chats are told:**
  - the folders,
  - the routing note,
  - identity, preferences and goals pasted in up to 16 KB (later ones are named by path instead).
  - Knowledge and processes are read on demand.
  - Flags are fixed when a chat starts, like agent profiles.
- **Left for later:**
  - Shared context across profiles.
  - Turning context off for one agent profile.
  - Moving files out of the inbox in one click.
  - Inbox counts for profiles other than the active one.

### Part 8: Polish, the known gaps and Servers (done)

- **Decisions (2026-10-22):**

  | Question | Answer |
  | --- | --- |
  | Which polish items | All: Ctrl+K, a systemd user service, profile settings, selection that follows moves |
  | Tauri | Decide later (still needs Rust) |
  | Known gaps | All four groups: nav and steps, notes, files, cards and chats |
  | Ctrl+K | Everything (entries, steps, notes, context, chats, pages) plus actions |
  | Profiles | Edit, add and remove in the app |
  | systemd | The service plus a rebuild and restart after `git pull` |
  | Servers: what counts | Found from `/proc` in project folders, plus optional declared `servers:` with a health check |
  | Servers: where | A Servers page and marks in the nav (and a line on the card) |
  | Servers: actions | Open, Stop (asks first), Copy URL; polled every 3 s on the page, 15 s for the nav |

- **Milestone 1, polish** (07eec5d):
  - `QuickSwitcher.tsx` and `src/lib/switcher.ts` (`fuzzy`, `rank`), lazy.
  - `ProfileDialog.tsx`; `ConfigStore.createProfile` / `removeProfile` (the file to the Trash); `POST /api/profiles`, `DELETE /api/profiles/:id`.
  - `bin/workbench --install / --uninstall / --print-units / --update`. The path unit watches `.git/logs/HEAD`.
  - `entryId` and `resolveEntry` in `src/lib/nav.ts`: the selection and Recent work find an entry again by type, label and path.
- **Milestone 2, the known gaps** (0824f5a):
  - The pencil is disabled while the file is broken; a renamed step stays the open tab; renaming a chat step moves its chat (`Chats.moveSlot`).
  - Notes: heading links, task boxes in View (`src/lib/tasks.ts`), code colours (`src/lib/highlight.ts`, the editor's parsers with `classHighlighter`), midnight rollover, a text cache keyed by mtime and size.
  - Files: copy (Duplicate, Ctrl+C/V, Ctrl+drag), upload from the desktop, folder sizes, Search all folders (`find`), Undo for Trash (`server/trash.ts`, XDG `.trashinfo`), virtual rows past 400.
  - Cards: category colours (`setCategory`), created and updated dates (`server/project-dates.ts`).
  - Chats follow `/clear` and `/resume`: a `SessionStart` hook given with `--settings` runs `server/session-hook.mjs`, which writes `<state>/sessions/<chat>.json`; `Chats` watches it.
- **Milestone 3, Servers:**
  - `server/procfs.ts`: listening sockets (`/proc/net/tcp{,6}`, state `0A`), matched to your processes by socket inode; each process's cwd, name, command and start time.
  - `server/servers.ts`: `scan(profile)` (cached 1 s), rows per project (deepest project wins), declared servers merged by port, an HTTP probe (1.5 s), and `stop`, which re-scans and checks owner, port and project before SIGTERM. Routes `GET /api/servers`, `POST /api/servers/stop`.
  - `ServersView.tsx` (lazy), the nav button and marks, the card line.
- **Left for later:**
  - A Tauri window.
  - Servers: no logs or restart (Workbench didn't start them), UDP isn't listed, and a server started outside a project folder isn't shown even if it serves that project.
  - Upload has no progress bar; copying to another drive works, moving there is still refused.

### Part 9: Git per project (done)

- **Decisions (2026-10-22):**

  | Question | Answer |
  | --- | --- |
  | What part 9 is | Git per project (over project tasks and logs, a tasks board from notes, and assets and media) |
  | Actions | Stage and commit; pull, push and fetch; branches; discard and stash |
  | Staging | By hunk, unified diff |
  | Marks | Card and nav |
  | Commit messages | A Draft button (`claude -p` on the staged diff); never commits by itself |
  | Fetch | Every 10 minutes in the background, and when the tab opens |
  | History | A list plus commit details |
  | Conflicts | Listed; resolved elsewhere (note, default app, or Ask claude in a chat); Mark resolved and Abort |
  | The tab | Built in after All files, in every project that is in a repository |

- **Built:**
  - `server/git.ts` (`Git`), `shared/git.ts`, routes `/api/git/*`; `Chats.print` for Draft (`-p <prompt> --no-session-persistence --tools ""`).
  - `GitView.tsx`, `GitDiff.tsx`, `src/lib/git.ts`; the tab and card line in `ProjectView`, `GitMarkView` in the nav, marks polled in `App`, Ctrl+K "<project> › Git".
  - Safety: `core.fsmonitor` off for every git run (tested with a monitor script that would make a file), no prompts, no shell, requests name the project and only things git lists, hunks found again by hash, error text masked.
- **Choices made while building:**
  - A conflicted file that isn't Markdown opens in its default app (where it can be edited), not in the read-only file preview.
  - Untracked files are listed one by one (`--untracked-files=all`) in the tab; the nav's counts use `normal` (a new folder counts once) to stay cheap.
  - Discard's Undo is kept in memory for an hour; the content itself is a git object.
- **Left for later:** rebase, cherry-pick, tags, submodules, force push, editing remotes, `git init` and clone, a branch graph, resolving conflicts inside the tab (ours/theirs per file).

### Part 10: Assets and media (done)

- **Decisions (2026-10-22):**

  | Question | Answer |
  | --- | --- |
  | What part 10 is | Assets and media (over project tasks and logs, a tasks board, activity and time) |
  | Where | A List / Gallery switch in every file browser, remembered per folder |
  | Thumbnails | Workbench's own cache (`~/.cache/workbench`): made in the browser; `.blend` from the preview inside the file |
  | 3D | A viewer for glTF/GLB, OBJ, FBX and STL (three.js, lazy) |
  | Extras | All four: type filters and size slider; open with the right program; image info and compare; audio waveforms |

- **Built:** `server/thumbs.ts`, `server/open-with.ts`, `server/programs.ts`; `Gallery.tsx`, `src/lib/thumbs.ts`, `ModelPreview.tsx`, `AudioPreview.tsx`, `ImageCompare.tsx`; `FileBrowser` and `FilePreview` changes; `openWith:` in the schema; folder tickets for 3D files.
- **Choices made while building:**
  - A subfolder takes its parent's view until it has its own (otherwise a gallery's subfolders opened as lists).
  - The audio preview shows length and channels, not the sample rate: the browser resamples when decoding.
  - Open with runs a profile rule even when its program isn't found (the error says so); the built-in rules apply only when Blender or Godot is installed.
- **Left for later:** thumbnails for Godot scenes, TGA/EXR/PSD/DDS decoding, Draco glTF, animation playback in the viewer, a gallery step kind, and keeping the view choice in the YAML.

### After part 10: profile menu and drawers (done)

- **Spec (2026-10-23):** "Profile selection in to a menu selection" and "New project or subject selection that has its own structure", called a **drawer**: its own structure, its own little logo no bigger than the narrowest sidebar, its items shown when chosen, and material shared between drawers. Planned first, then a clickable prototype (<https://claude.ai/artifact/A9ZDGSRPGPC14dr5tT3gm4>), approved before building.
- **Decisions:**

  | Question | Answer |
  | --- | --- |
  | Profile button | Icon only: a person icon tinted with the accent; menu with the profiles (Ctrl+N), Profile settings…, Add profile… |
  | What a drawer is | Its own nav inside a profile (headings, entries, groups, projects); Context stays on top |
  | Where the picker sits | Where the profile tabs were: logo, name, menu (drawers, New drawer…, Drawer settings…) |
  | Logo | A square picture scaled to 64×64 (22 px in the picker, 24 px in the menu); else initials on a tint |
  | Sharing | Show an entry in other drawers (the same entry, marked); a shared folder per drawer, picked per drawer, used by others under a fixed Shared heading and given to chats with `--add-dir` |
  | Per drawer | The last drawer per profile (localStorage); Ctrl+K searches every drawer. Recent work stays per profile |
  | Defaults approved with the prototype | Without `drawers:` the file keeps `sections:` as its one drawer, moved into a first drawer named after the profile on the first drawer change; a shared entry lands under a heading of the same title (added if missing); the Shared heading lists the drawer's own folder too; deleting an original removes it everywhere after asking |

- **Built:** `Drawer`, `SharedItem`, `drawer` in addresses (`d:s.i` keys past the first drawer), `drawersOf`/`entryAt`/`sharedRefs`/`walkItems` in the schema; ops `addDrawer`, `setDrawer`, `deleteDrawer`, `setShared` and drawer-aware section ops with cascades; `server/logos.ts`, `/api/logos`, `/api/drawers/folder`; `drawerContext` merged into chat args; `DrawerDialog.tsx` (lazy), `DrawerLogo.tsx`, `src/lib/logos.ts`; NavPanel's picker and `SharedBlock`.
- **Choices made while building:**
  - A shared entry opens under its own address (the nav highlight and drawer stay), while the page and its ops use the original's address.
  - Entries can't be moved across drawers (the op refuses); Show in drawers is the way.
  - Picking a drawer goes Home when the page showing is an entry of the drawer left; notes, folders and other pages stay.
  - The one-click shared folder is made by the service from the drawer's name only (`<notes or home>/drawers/<slug>`).
  - Logos are content-named PNGs; nothing prunes unused ones.
- **Left for later (the user's other two sharing ideas):** a shared shelf heading shown in every drawer of a profile, and dragging entries onto a drawer in the picker (Ctrl to link instead of move). Also: reordering drawers in the app, and pruning unused logos.

### Part 11: the wiki is the configuration (done)

The user asked how to simplify the workflow and configuration and make Workbench more wiki-like. The plan is in the session's plan file and summarized here.

- **What's complicated today:** a project is described in three places (nav entry, folder, notes); nav entries and steps are two vocabularies with explicit `type:` fields; `workflow:` forks silently into `steps:`; the nav is the only index; six selection kinds and a fixed Context heading outside the file; notes are a feature rather than the substrate (`[[links]]` only inside the notes folder, no backlinks, no frontmatter, renames break links).
- **Decisions (2026-10-23):**

  | Question | Answer |
  | --- | --- |
  | How far | Everything: projects, nav, workflow, agent profiles and the profile itself become Markdown pages; no profile YAML. `settings.yaml` stays, as a map of profile id to wiki folder |
  | Project page | `<wiki>/projects/<Name>.md`: frontmatter is the card (`folder`, `status`, `category`, `pinned`, `agent`, `icon`, `servers`), `## Workflow` is the tabs, the body is notes |
  | Nav | `<wiki>/index.md`: frontmatter is the profile (name, accent, theme, background, home, categories, openWith); headings and link lists are the nav; a nested list is a group |
  | Default workflow | `<wiki>/Workflow.md`, inherited until a project page has its own `## Workflow` (superseded below: a template) |
  | Link kinds | From the target, no `type:`: `[[Page]]`, `path/` (folder), `x.md`, `x.html` (report), other files, URLs, `run:<command line>`, `chat:[agent] [folder] [-- args]`, `daily:`, and `folder:`/`note:`/`report:`/`file:` overrides |
  | Chats and the wiki | Every claude chat gets `--add-dir <wiki>` and, in a project, is told its page so it can keep the page's Log |
  | Claude setup | The project tab stays; the page and its sidebar button go |
| Drawers (asked after drawers landed) | A page per drawer: `<wiki>/drawers/<Name>.md` with frontmatter `logo`, `folder`, `uses` and the nav as its body. `index.md` lists the drawers in order (`- [[drawers/Name]]`); without drawer links its body is the one drawer. Show in <drawer> adds the same `[[Page]]` line there, so `type: shared` goes |
| Nav pages | Every `[[Page]]` linked from the nav is an item: card from its frontmatter, tabs from its `## Workflow` (`files:`, `git:`, `setup:`, `x.md`, `run:`, `chat:`, …); without a Workflow section the page itself fills the view. Note entries and blank items become one thing |
| Workflow | A template, as items already do: `Workflow.md` is copied in (Add profile steps) or saved to (Save as profile steps); a new item starts blank. No inheritance |
| Item pages | New item makes `projects/<Name>.md`; any page anywhere can still be linked from the nav |

- **Milestones:** (1) the wiki substrate, no config change; (2) the wiki store (`wiki-md.ts`, `wiki.ts` replacing the config store with the same `Op`s, `settings.yaml` map, migration, seed, the dialog's target field, New project…, `page:` selection); (3) nav and project page (Context links in `index.md`, the Page tab and Mentions, chats get the wiki, the setup page dropped, `collapsed` to localStorage, `Workflow.md` menu); (4) polish and docs (tags, Pages to write, `templates/project.md`, README/CLAUDE.md).
- **Milestone 1, built:**
  - `shared/wikilinks.ts`: the link helpers the UI and the service share (`parseWiki`, `resolveWiki`, `resolveHref`, `linksIn`, `linkPath`, `rewriteLinks`, `relativePath`, `resolveProject`, `blankFrontmatter`, `FRONTMATTER`); `src/lib/wikilinks.ts` keeps the remark plugin and re-exports them.
  - `server/frontmatter.ts` (moved out of `claude-setup.ts`). `NoteFile` carries `meta` (and `metaError`); the view shows it as a properties strip and blanks the block so task lines keep their numbers.
  - `Notes.backlinks` (`GET /api/notes/backlinks`): notes linking to a note, with the lines; a **Mentions** section under every note. `Notes.rename` (`POST /api/notes/rename`, and the file browser's rename of a `.md` inside the notes folder): the file is renamed and `[[Old]]`, `[[folder/Old]]` (headings and aliases kept) and relative links are rewritten in every note of the folder; notes elsewhere are named by the config, so they are refused (422). **Rename** / F2 in the note view. `Notes.template` (`GET /api/notes/template`): `templates/page.md` fills `{{title}}` and `{{date}}` for New note… and notes made from wiki links.
  - `[[Project/path]]` links: a file in a project's folder by the project's label; Markdown opens as a note, anything else opens its folder.
- **Milestone 2, built (the wiki store):**
  - `server/wiki-md.ts`: the pages as text. `parsePage` (frontmatter, `##` headings, list items with their nested level and spans, fences skipped; a list under a `#` title or before the first heading is the *lead* list, which `Workflow.md` uses), `parseLink`, `targetKind` (the kind from the target's shape; `folder:`/`note:`/`report:`/`file:` overrides), `splitCommand`/`joinCommand`, `run:` with `cd <dir> &&`, `chat:[agent] [folder] [-- args]` (a bare folder is written `src/` so it does not read as an agent), `daily:`, `navItemOf`/`stepOf` (a line that cannot be read keeps its index as a note opening the page, with a problem), `linkOf` (pages by their name when unique, else their path; paths with spaces percent-encoded, command lines in angle brackets), and the line edits (`insertItem`, `removeItem`, `replaceLink`, `moveItem`, `addSection`, `renameSection`, `deleteSection`, `moveSection`, `setMeta`).
  - `server/wiki.ts`: `Wiki`, the store with the old store's surface (`state`, `profile`, `apply`, `undo`, `setActive`, `createProfile`, `removeProfile`) and the same `Op` names. `settings.yaml` maps ids to wiki folders (`profiles: {work: ~/notes}`); a list of ids is the old form and loads `profiles/*.yaml` read-only (`legacy`), until `migrate()` (`POST /api/migrate`, the nav banner, `bin/workbench --migrate`). `#read` builds the `Profile`: `index.md` (frontmatter, nav or `## Drawers`), drawer pages, every page the nav links (`known()` by path or by name, projects/ first), `Workflow.md`, `agents/*.md` (frontmatter plus the body as instructions); a composite rev over every file read; `problems` for lines and pages that could not be used; a broken `index.md` or drawer page is the profile's `error`. Ops run on a `Draft` over the files and are validated by reading the draft back before anything is written; undo restores every file the last batch touched (a page it made is removed). Watchers on the wiki root, `drawers/`, `projects/`, `agents/` and the folders of pages read. A folder link gets a page in `projects/` the moment it needs a card or a step; a profile without drawers gets its first drawer page on the first drawer op (`ownDrawers`). `setShared` links the page from the other drawer's page under a heading of the same title; `type: shared` is gone.
  - `server/migrate.ts`: a YAML profile as pages (`migrateProfile`), used by `Wiki.migrate`, by `seedWiki` (the first run starts with wikis) and by the test fixtures (`tests/fixtures/wiki.ts`: `migrateFixture`; e2e `writeWork`). A folderless item keeps its `id`. Comments are not carried over.
  - UI: the nav's banners (Move to pages; a soft one listing problems), the wiki folder in Profile settings (new profiles need one; nested wikis are refused), an item page without a Workflow shows the page itself with the ways to add a tab (`.item-page`), Show in <drawer> reads its state from the drawer pages, and the profile copy copies `index.md` and `Workflow.md`.
- **Milestone 3, built (nav and item page):**
  - **Context as links:** `Context.setup` still makes the folders and starter notes, and then runs nav ops: a `## Context` heading at the top of the first drawer's page with `[Context](context/)`, `[Knowledge](knowledge/)`, `[Processes](processes/)` and `[Inbox](inbox/)`, unless an entry already opens `context/`. The nav's fixed block (`ContextBlock`) shows only the Set up button, until `context/` exists. A folder link to `<notes>/context` opens the Context view (its notes as tabs); the Inbox entry shows the count. `openContext` in App selects the entry by path.
  - **The Page tab:** first in an item's tab row, a compact `NoteView` of its page (properties strip, text, Mentions, Edit in place). The row shows from two tabs on, as before, so an item with one tab has no Page tab (a known gap). The card menu (Pin, Mark, Archive) is only on items with a page; a plain folder link is just the file browser.
  - **Chats and the wiki:** `wikiContext(profile, home, page)` in `context.ts`: the wiki root in `--add-dir` and a prompt section naming `index.md`, `projects/*.md`, `Workflow.md` and `agents/*.md`; in a project, "This project's page is …: add a line under a `## Log` heading there when you finish something; leave the frontmatter and `## Workflow` to me". `agentFor` merges context, wiki and drawer folders into the one `--add-dir`/`--append-system-prompt`. The chat bar says `context · wiki`.
  - **Smaller:** **Open Workflow.md** in the tab menu (beside Add profile steps); nav sections carry `role="group"` with their title; `collapsed` is not read from the pages (localStorage only, as planned).
  - **Kept, to decide with the user:** the Claude setup page and its sidebar button. The decision was "project tab only", but the page's Everywhere view is where MCP switches set the profile's `mcpOff:` defaults, which landed after that decision.
- **Milestone 4, built (polish):**
  - **Tags:** `tagsIn(text, meta)` in `shared/wikilinks.ts` (frontmatter `tags:` as a list or a string, and `#tag` tokens outside fences and backticks; a tag starts with a letter, so headings, `#1` and URL anchors are not tags). `Notes` keeps a note's tags with its cached text; a `#word` in a search query is a tag the note must carry (`#tag` occurrences are highlighted). The properties strip shows `tags` as links that search for the tag.
  - **Overview** (`Notes.overview`, `GET /api/notes/overview`): tag counts, most used first, and the pages to write: `[[targets]]` no note resolves (project links through `resolveProject` excluded), spelled as the newest linker spells them, with how many notes link to them (capped at 200). The search view shows both before a query (`Tags`, `Pages to write`); a missing page is created from `templates/page.md` through `NotesApi.create` (shared with the wiki-link toast) and opened.
  - **`templates/project.md`:** `projectPage` in `Wiki.#applyOp` starts every new item page from it when it exists (`fillTemplate` with `{{title}}` and `{{date}}`; the card's frontmatter is merged into the template's; the chosen steps go under its `## Workflow`, added at the end when missing). Without a template a page is `# Title` plus the Workflow list, as before.
  - **Not done:** tags in a note's body are plain text (the strip and the search find them, clicking one in the text does nothing); tags are flat (no `tag:` page; the search is the page); yaml rewrites a template's flow list with spaces (`[ project ]`) when it adds the card's keys; the Claude setup page stays until the user decides (see milestone 3).

### Part 12: workspaces (done)

The user showed a reference: a *Chats* window with topic tabs beside a *Workspace* window whose left nav lists a game's chapters (01 Intro screen, 02 Character…), each a rich page with concept art, and a right rail with Files, Skills, MCP and Settings. The ask: a simple wiki that gives chats accurate context, skills tied to tasks, a place for references and assets; Git and Claude setup per drawer; skills pinned to parts of the wiki and to chats.

- **Decisions (2026-10-23):**

  | Question | Answer |
  | --- | --- |
  | What is a workspace | A drawer with chapter pages: the drawer is the workspace (its `folder:`, its repository, its skills); its nav lists the chapter pages in order; items with folders stay for repos inside it |
  | Where Git, Claude setup and Files live | A right rail per drawer: Files, Git, Skills, MCP, Settings on the right edge, acting on the drawer's folder, on every page of the drawer. They leave the project tab rows; the sidebar's Claude setup page and button go; the profile's MCP defaults move to the drawer |
  | Pinning skills | `skills:` in frontmatter, inherited: index.md → drawer page → chapter or project page. A chat started from a page gets the page's skills plus its parents'. The rail's Skills view shows what applies here. Agent profiles keep their own list |
  | Chats | A chats dock beside the page: a collapsible panel with tabs for every chat in the profile (pinned first, History, New chat from any page). A chat remembers the page it started from and gets that page's text and skills as context. Project chat tabs go |

- **Milestones:** (1) the drawer rail; (2) pinned skills; (3) the chats dock; (4) polish and docs. The plan (layout, behaviour, files, verification) is in the session's plan file and summarized here as each lands.
- **Milestone 1, built (the drawer rail):**
  - `src/components/Rail.tsx`: a column of icon buttons on the right edge for the drawer the nav shows: Files, Git (both once the drawer has a `folder:`), Skills, MCP, Settings. A button opens its tool as the selection `rail:<tool>` (`RAIL_KEY`, `RailTool` in `src/lib/nav.ts`) and stays lit; Ctrl+K lists the tools (`<Drawer> › Git` with several drawers). `RailView` in `MainPane.tsx`: Files = the file browser on the drawer's folder; Git = `GitView` on it (`Git.repo` accepts a drawer's folder as a project of its own, `drawerAsProject`); Skills and MCP = `ClaudeSetupView` with the new `kinds` prop (one kind hides the kind tabs; `drawer` picks whose defaults the switches are); Settings = `DrawerDialog` rendered `inline` (no scrim, no Cancel).
  - The sidebar's Claude setup page and header button are gone, with the For picker; the project tab keeps every kind. `setup:` selections from before resolve to nothing.
  - **MCP defaults per drawer:** `Drawer.mcpOff` from the drawer page's frontmatter; `setMcpOff` takes a `drawer` and writes that page (index.md for a profile without drawers, whose one drawer carries `profile.mcpOff`); the first drawer op moves index.md's key into the first drawer's page; a key left on index.md by hand is read as the first drawer's and reported. `agentFor` applies the chat's drawer's list; `POST /api/claude/mcp` without a path takes `drawer` (and the rev) and switches every project of the drawer plus its own folder; `GET /api/claude/setup` takes `drawer` too (`withDefaults`, `drawerFor`).
  - **Chapters:** pages added in a drawer that has a page (Add entry, a folder link that needs a card) go under `drawers/<Name>/` (`pageDir` in the wiki store); a profile without drawers keeps `projects/`.
  - Tests: `wiki.test.ts` (drawer `mcpOff`, moved key, stray key, `drawers/<Name>/` pages), `drawers-http.test.ts` (git on a drawer folder), `claude-setup-http.test.ts` (defaults per drawer); e2e `setup.spec.ts` moved to the rail and the project tab, new `rail.spec.ts` (Settings gives the folder; Files, Git, Ctrl+K, the selection survives a reload).

- **Milestone 2, built (pinned skills):**
  - **The chain:** `skills:` on index.md (`Profile.skills`), a drawer page (`Drawer.skills`; a profile without drawers reads the profile's as its one drawer's) and an item page (`FolderItem.skills`, through `PAGE_FIELDS`). `pinnedSkills(profile, drawer, item)` in `server/skills.ts` merges them, de-duplicated. The `setSkills` op (`at` = a page, `drawer` = its page, neither = index.md) replaces a list; empty removes the key.
  - **Resolution:** `resolveSkills(names, installedSkills, wikiRoot)`: `<wiki>/skills/<name>/SKILL.md` first (case ignored; the folder's spelling wins), else an installed skill of that name (not overridden), else *missing*. `readSetup({wiki})` lists the wiki's skills with scope `wiki` after the override pass, so they shadow nothing.
  - **Reaching claude:** `agentFor` names the found skills in the prompt (`skillsPrompt`: `/name: description`, `/wiki:name` for the wiki's) and, for wiki skills, adds `--plugin-dir <state>/skills/<sha1 of the set>/wiki` (`SkillBundles`: `skills/<name>` symlinks to the skill folders, a minimal `plugin.json`; bundles are keyed by their set, so chats with the same pins share one, and `prune` on start drops those no saved chat's args name). Checked against the Claude Code docs: `--plugin-dir` loads a plugin for the session, skills as `/<dir>:<name>`; there is no per-session allowlist, so installed skills are only named.
  - **UI:** `GET /api/claude/setup` returns `pinned {profile, drawer, page, missing}` (`setupView`); the setup view shows a **Pinned** strip above the skill rows (× unpins where it may write) and **Pin to <drawer>** / **Unpin** in a skill's details (the rail writes the drawer's list, a project's tab its page's); the card's **Skills** chip (`skillsMenu`) ticks every skill claude loads there plus the wiki's for the page. Scope badge **Wiki**.
  - Tests: `skills.test.ts` (chain, resolution, prompt, bundles, prune), `wiki.test.ts` (`setSkills` at the three levels), `claude-setup.test.ts` (wiki scope), `chats-http.test.ts` (prompt text, `--plugin-dir`, the symlink, nothing for a shell); e2e `skills.spec.ts` (rail Pin, the chip, a chat's args).

- **Milestone 3, built (the chats dock):**
  - `src/components/ChatsDock.tsx`: a column between the page and the rail with every chat of the profile (pinned first, then the newest; a step's or entry's chat under its step's name), the active one's `ChatPane` beneath, New chat ▾ (the agent menu), History and a fold button; folded, a strip with the count and the needs-you dot. Ctrl+J folds and unfolds. `dock` (open) and `dockActive` (the chat per profile) in localStorage. The tab menu (Rename, Colour, Pin, Summarize and continue, Close) and the drop of paths moved here from `ProjectView`, which lost its chat tabs, New chat and History (`showRow` counts steps only; a chat step still shows in its tab). `App.openChat` sends a chat without a slot to the dock; a step's or entry's chat goes to its tab or page as before; New chat from the nav menu also shows the project.
  - **Where New chat starts** (`DockContext`): the item shown (`at` its address; its folder, or for a page without one its drawer's folder, now the server's rule too), else the drawer (`POST /api/chats` with `drawer` and no `at`: host `drawer:<name>`, cwd the drawer's folder or home). History lists the sessions there.
  - **The page as context:** `ChatSpec.page`/`Chat.page` (saved in `chats.json`); `wikiContext` appends the page's text (frontmatter stripped, 16 KB cap) under "The page I am looking at".
  - The fake claude prints a second `FAKE CLAUDE cwd=… resumed=… short=[…]` line after its args (long values shortened), because the page text makes the args line scroll the banner away in a narrow terminal; the e2e specs read flags from it. Tests: `chats-http.test.ts` (page text and `page`, a drawer's chat, a page without a folder); e2e `chats.spec.ts` and `agents.spec.ts` against the dock (needs-you with the dock folded, Ctrl+J).

- **Milestone 4, built (polish and docs):** an image's title shows as a caption under it in notes (`captioned` in `Markdown.tsx`, inline so it sits in a paragraph); the README's Workspaces section; CLAUDE.md and the roadmap. Recent work does not list chats (the dock and Ctrl+K do; dropped from the plan as not worth a new key kind).
- **The page cleanup, built (after milestone 4):** the screenshots showed Git and Claude setup still in the page and a header full of things the user does not need ("useless git information top center", "breadcrumbs are redundant", "status, category and timestamps all have to go"). So: the top bar is gone (the search box moved to the sidebar under the drawer picker, Back is a floating arrow in the pane's corner, the WORKBENCH label is Home); the card keeps only the kicker with its chips, the title, pin, path and description; the git line, servers line, dates (`project-dates.ts` removed), status pill and category chip are gone from the page; `git:` and `setup:` steps get no tab (`tabSteps`; the lines stay in the page and keep their index, so ops on the other steps still work), `legacySteps` is All files + workflow, and the step dialog and the blank item's buttons no longer offer Git or Claude setup; the rail's Skills view carries agents, commands, hooks and plugins behind its kind tabs so nothing is lost. Status stays in the nav (dot; Mark and Archive in the menu); `category`/`categories:` are read but not shown. Next: the user is handing over a design for the look.
- **No more "projects" (after the cleanup):** the user: "Don't call an item 'projects' so it doesn't mix up things. 'Projects' as of now is just a heading in the panel. Keep things generic and modular." New item pages go to `pages/` (`projects/` from older wikis is still read, ranked right after it), the template is `templates/item.md` (`project.md` still read), every UI text says item, entry, tab or folder instead, and `ProjectView` is `ItemView`. Internal keys (`projectRef`, `projectHost`) stayed.
- **Known gaps:** pinning an installed skill only names it in the prompt (claude loads it anyway; there is no per-session allowlist); a wiki skill pinned on a page loads only in chats started from that page or its drawer; the rail acts on the drawer the nav shows (a project inside it keeps its own Git tab through its steps); chapters are pages, so their order is the nav's (no numbering added by the app); one dock per window, its width fixed (`clamp(300px, 28vw, 400px)`); a step's chat shows in its tab and in the dock's list both; History lists the sessions where New chat would start, not every folder's; a page's text in a chat's instructions is capped at 16 KB and taken when the chat starts.

## Reference

The reference is Mr. Mak Workspace (<https://github.com/witnesstodark/mr-mak-workspace>, MIT): a Tauri 2 shell with a React 19 UI and a Node service. The notes above summarize what's relevant, so re-reading it is only needed for specifics. Take ideas, not code wholesale; the user asked for that explicitly.
