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
| 10 | Assets and media | Done (branch restarted from `main`); see below |

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

## Reference

The reference is Mr. Mak Workspace (<https://github.com/witnesstodark/mr-mak-workspace>, MIT): a Tauri 2 shell with a React 19 UI and a Node service. The notes above summarize what's relevant, so re-reading it is only needed for specifics. Take ideas, not code wholesale; the user asked for that explicitly.
