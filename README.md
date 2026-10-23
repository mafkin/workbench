# Workbench

A local workbench for this Linux desktop. You switch between **Work** and **Personal** profiles, and each profile has its own configurable nav panel of headings and entries. The UI is React. A small Node service listens on `127.0.0.1:7420` and serves it.

## Run

```sh
npm install
npm run install-launcher   # adds "Workbench" to the GNOME app grid
bin/workbench              # starts the service if needed, then opens the window
```

`bin/workbench` builds the UI on first use and logs to `~/.local/state/workbench/server.log`. `npm install` also builds `node-pty` for chats, which needs `gcc`, `make` and `python3`.

For a window without browser chrome:

1. Start Workbench once, so the service is running.
2. Open `http://127.0.0.1:7420/` in GNOME Web.
3. Choose **Install as Web App**.

After that, `bin/workbench` opens the web app instead of your default browser.

### Keep it running (systemd)

```sh
bin/workbench --install       # once
```

This writes three user units to `~/.config/systemd/user/` and starts the service:

- `workbench.service` runs the service, starts it at login and restarts it if it crashes.
- `workbench-update.path` notices a `git pull` (or checkout, or commit) in this folder and runs `workbench-update.service`. That runs `npm ci` if `package-lock.json` changed, rebuilds the UI and restarts the service. Its log is `~/.local/state/workbench/update.log`.

`bin/workbench --print-units` shows the units without writing anything, and `bin/workbench --uninstall` removes them. After `--install`, `bin/workbench` only opens the window.

## Configuration

Config lives in `~/.config/workbench/`. Set `WORKBENCH_CONFIG_DIR` to use another location.

| File | Holds |
| --- | --- |
| `settings.yaml` | the active profile and, in order, each profile's wiki folder |
| `backgrounds/`, `logos/` | pictures the app copied for backgrounds and drawer logos |

A profile is a **wiki**: a folder of Markdown pages. The pages are the configuration, and they are notes too, so search, `[[wiki links]]`, Mentions and the editor work on them. Edit them in Workbench or in any editor: hand edits show up live, and app edits touch only the lines they must, so prose around a list stays as you wrote it. A page that will not parse is reported in a banner (with the line) and never written over; a line that cannot be read as an entry shows up as a note that opens the page, so you can fix it.

```yaml
# settings.yaml
activeProfile: work
profiles:
  work: ~/Documents/work/notes
  personal: ~/Documents/notes
```

Inside a wiki:

| Page | Holds |
| --- | --- |
| `index.md` | The profile in its frontmatter (`name`, `accent`, `theme`, `background`, `home`, `categories`, `openWith`, `mcpOff`). Its body is the nav: `##` headings with link lists, one nested list level for groups. With drawers, the body is a `## Drawers` list of drawer pages instead. |
| `drawers/<Name>.md` | A drawer: frontmatter `logo`, `folder`, `uses`; the body is its nav, as in `index.md`. |
| `projects/<Name>.md`, or any page linked as `[[Name]]` from the nav | An item. The frontmatter is its card: `folder`, `status` (paused, done, archived), `category`, `pinned`, `agent`, `icon`, `description`, `servers`, and `id` for an item without a folder. `## Workflow` lists its tabs. The rest of the page is yours: the page itself shows when it has no tabs. |
| `Workflow.md` | The profile steps: the list **Add profile steps** copies into a page and **Save as profile steps** writes here. |
| `agents/<Name>.md` | An agent profile: frontmatter `model`, `effort`, `permission`, `prompt`, `folders`, `allowedTools`, `disallowedTools`, `mcp` (or `agent` for a Claude Code agent); the body is the instructions. |
| `templates/page.md`, `templates/daily.md` | Templates for new notes and daily notes; `{{title}}` and `{{date}}` are filled in. |
| `context/`, `knowledge/`, `processes/`, `inbox/` | The context folders (see Context). |

A list item is a link, and what it opens follows from the target, so there is no type to name:

| Target | Opens as |
| --- | --- |
| `[[Page]]`, `[[Page\|shown as]]`, `[[folder/Page]]` | the page, as an item (its card, its tabs; the page itself without tabs). A page that does not exist yet opens as a note to create. |
| `folder/`, `~/Downloads`, a path without an extension | a folder in the file browser |
| `x.md` | a note; `x.html` a report in its tab; any other file is shown large |
| `https://…` | a link, opened in your browser |
| `run:godot --editor --path .` | a launcher (no shell; `cd <folder> && …` sets its working folder). Spaces put the target in angle brackets: `[Godot](<run:godot --editor>)` |
| `chat:`, `chat:shell`, `chat:Reviewer`, `chat:shell src/`, `chat:claude ~ -- --model opus` | a chat: the agent (`claude`, `shell` or an agent profile; none means the item's default), a folder, and arguments after `--` |
| `daily:` | today's note (`daily:journal templates/j.md` picks the folder and template) |
| `files:`, `git:`, `setup:` | in a `## Workflow` only: the item's folder in the file browser, its Git tab, its Claude setup |
| `note:plan.txt`, `folder:…`, `report:…`, `file:…` | the kind spelled out, when the target's shape would say otherwise |

A link's title is its icon (`[Docs](https://example.com "book")`, any name from [lucide.dev/icons](https://lucide.dev/icons)); a page carries `icon:` in its frontmatter.

```md
---
name: Work
accent: "#7d93ab"
theme: fjord                    # slate (default) | fjord | moss | ember | dusk | graphite
background: theme               # theme (default) | none | a picture in ~/.config/workbench/backgrounds/
home: ~/Documents/work
categories: { game: "#8fa58a" } # optional colours for project categories
openWith:                       # optional: programs files open in (before the built-in Blender and Godot)
  - { ext: [kra], command: krita }
mcpOff: [plugin:toolkit:slack]  # MCP servers off by default (see Claude setup); with drawers, on each drawer's page
skills: [review]                 # skills pinned for every chat (see Claude setup); drawer and item pages take their own
---
## Projects
- [[Tuohi]]
- [[IFC Checker|IFC]]
- [Downloads](~/Downloads)

## Reference
- [Runbook](~/deploy-tools/RUNBOOK.md)
- [Docs](https://example.com "book")
- [Today](daily:)
- [Scratch](<chat:claude ~>)
- Deploy
  - [Claude here](<run:cd ~/ifc_checker_project && gnome-terminal -- claude>)
```

```md
---
folder: ~/Projects/tuohi
status: paused
category: game
pinned: true
agent: Reviewer
servers:
  - { name: web, port: 5173 }
---
# Tuohi

Card game about birch-bark crafts.

## Workflow

- [All files](files:)
- [Git](git:)
- [sprites](assets/sprites/)
- [Godot](<run:godot --editor --path .>)
- [tests](reports/index.html)
- [render](renders/latest.png)
- [design](docs/design.md)
- [agent](chat:)
- [board](https://example.com/b)
```

```md
---
model: opus
permission: plan
prompt: Review the latest changes
folders: [~/Projects/shared-assets]
allowedTools: [Read, Grep]
---
You review code. Don't edit files.
```

**Moving from the YAML profiles** (before part 11): the nav shows a banner with **Move to pages**, and `bin/workbench --migrate` does the same from a terminal. Each `profiles/<id>.yaml` becomes a wiki in its `notes:` folder (else `<home>/notes`, else `~/notes`); projects become pages under `projects/`, with the tabs they showed as their `## Workflow`; the YAML file is kept as `<id>.yaml.bak`. Comments in the YAML are not carried over. Until then the profile is read-only.

## Using it

- **Profiles:** the person icon at the top of the sidebar lists them, with Profile settings… and Add profile…. **Ctrl+1 / Ctrl+2** (and on, in profile order) switch profiles. **Esc** leaves edit mode.
- **Ctrl+K** finds anything: entries, project steps (`Alpha › readme`), notes, context folders, open chats and pages (Home, Servers, the drawer's Files, Git, Skills, MCP servers and Drawer settings), plus actions (New note…, New chat in a project, Theme and background, Agent profiles, Profile settings, Edit navigation, Switch to a profile or a drawer, New drawer…). With several drawers it searches all of them; picking an entry of another drawer shows that drawer. Letters match in order, word starts first; with an empty box, your recent picks come first.
- **Profile settings** (in the profile menu, or Ctrl+K) edits the profile's name, accent, home and notes folder, keeping your YAML comments; Undo works. **Add a profile** makes a blank one or a copy of the current one's headings and workflow. **Remove** asks first and moves the file to the Trash; the last profile stays.
- The selected entry and **Recent work** follow an entry you move or rename, in the app or by hand.
- **Edit mode** (pencil):
  - Drag headings and entries to reorder them, or move entries between headings and groups.
  - **+** adds an entry, the pencil renames or edits, and the bin deletes.
  - Deletes can be undone from the toast that appears.
- **Right-click** any heading or entry for the same actions.
- **Launchers** and **links** start or open from the small button at the end of their row (▶ or ↗), without a shell; their names are just text. Folders and notes open in the main pane when you click them.
- **Alt+←** or the back arrow in the top bar goes back to the previous page.
- **Home** shows what you opened last (projects and their steps, notes, folders) and today's note. It doesn't repeat the nav.

### Drawers

- A **drawer** is a nav of its own inside a profile: its own headings, entries, groups and projects, and a small logo. The button under the header row shows the drawer and switches between them; **New drawer…** and **Drawer settings…** are in its menu. The Context links live in the first drawer's page.
- **The rail** on the right edge is the drawer's toolbox (part 12): **Files** and **Git** for the drawer's folder (once it has one), **Skills** and **MCP** (what claude loads there, and the drawer's MCP defaults), and **Settings** (the same form as Drawer settings…, in the main pane). Pages you add in a drawer go under `drawers/<Name>/` in the wiki, so a drawer is a workspace: its folder, its repository, its chapters.
- The first **New drawer…** turns your headings into the first drawer, named after the profile (rename it in Drawer settings). Until then the file keeps `sections:` as it was.
- The drawer you were in is remembered per profile in this browser. Back, Recent work and Ctrl+K bring an entry's drawer along.
- **Logo:** **Choose picture…** in Drawer settings, or right-click a picture in the file browser and choose **Use as drawer logo**. Its middle is scaled to 64 × 64 and kept in `~/.config/workbench/logos/`. Without one, the drawer's initials on a tinted square.
- **Show in drawers:** right-click an entry and tick **Show in <drawer>**. The same entry shows there too, under a heading of the same name, marked ⇄ with its own drawer; it opens the same page, chats and all. Renaming the original updates it; deleting the original asks first and removes it everywhere (Undo brings it back). Right-click a shared entry for **Go to <drawer>** or **Remove from this drawer**.
- **Shared folder:** a drawer can have a folder of its own (Drawer settings offers `<notes>/drawers/<name>` in one click) and use other drawers' folders. They're listed under a fixed **Shared** heading, open in the file browser, and claude chats started in the drawer can read them (`--add-dir`, with a line in the system prompt). A project's chats get the folders of the drawer it lives in.
- Entries move between headings within their drawer only.

### Themes and backgrounds

- The palette button at the top of the sidebar opens **Theme and background** for the current profile. Work and Personal each have their own; the accent colour stays the profile's.
- Six dark themes: **Slate** (the original), **Fjord**, **Moss**, **Ember**, **Dusk** and **Graphite**. Each has its own background, drawn with soft gradients, behind frosted panels.
- **Background:** the theme's own, **None** (the flat look, panels edge to edge), or your own picture. Add one by path in the panel, or right-click a picture in the file browser and choose **Use as background**. Workbench keeps a copy in `~/.config/workbench/backgrounds/` (jpg, png, webp, avif or gif, up to 25 MB), so it still works if you move the original; the × on a picture in the panel deletes the copy.
- Choices are written to the profile's YAML (`theme:`, `background:`) at once, with Undo in the toast.

### Items: cards and steps

- **Add entry…** makes an **item**: a name, and optionally a folder. It starts blank, with buttons for **File browser**, **Note**, **Git**, **Claude setup** and **More…** (every kind of step). You add what it needs, and each step is a tab.
  - An item with one step shows it on the whole page, without a tab row; **+** by the title adds the next one. From two tabs on (steps or chats) the tab row is back.
  - File browser, Git and Claude setup show the item's folder. An item without one asks for it the first time you add one of these, and keeps it.
  - **Remove tab** (right-click a tab, or Delete on it) takes away only the tab. Its folder or file stays on disk, and the toast has Undo. With no steps left the item is blank again.
  - Entries made before items (folders, notes, launchers, links, chats, daily) keep working as they are. A `type: folder` entry is an item too.
- The top of an item's page is its card:
  - a **category** chip (pick one or make a new one),
  - a **status** (active, paused, done, archived),
  - a **pin**,
  - a **description** you click to edit.
- **Under the description:** when the folder was created and last updated (the last commit in a git repository, else the newest file), and how many servers are running there.
- **Categories** get colours from the category menu (**Colour of …**: a palette or any colour), saved in `categories:`.
- **In the nav,** each project shows its status as a dot, pinned projects come first in their heading, and archived ones hide until you click **N archived · Show**. While you edit the nav, the real order shows. Right-click a project to pin it, mark it or archive it.
- Below the card are its tabs. The first is **Page**: the item's own page (`projects/<Name>.md`), with its properties, its text (a log, links, anything) and the pages that mention it, editable in place. An item with one tab shows that tab on the whole page and no row, so the Page tab appears from two on.
- The steps:
  - **File browser** (`files`), **Git** (`git`) and **Claude setup** (`setup`) show the item's folder, its repository and what claude loads there.
  - A **folder** step shows that folder in the browser, with **Create folder** if it doesn't exist yet.
  - A **note** step shows the note in place, with Edit and autosave.
  - A **report** step shows an HTML page (a test or analysis report) with its own styles and scripts. It runs in a sandbox, cut off from Workbench.
  - A **file** step shows one image, PDF, video or text file large.
  - A **launcher** step starts its program in the item's folder (or home), and a **link** step opens its address in your browser.
- Steps are yours to name: **+** adds one (relative paths are inside the item's folder, else home). Right-click a tab to edit or remove it, and drag tabs to reorder them.
- The profile's `Workflow.md` is a template. From a tab's right-click menu, **Add profile steps** adds those the item doesn't have yet, **Save as profile steps** makes this item's steps the template, and **Open Workflow.md** opens the template as a note.
- A `<notes>/templates/project.md`, when you make one, is the start of every new item's page (`{{title}}` and `{{date}}` filled in; its frontmatter is kept under the card's fields, and the steps you picked go under its `## Workflow`, added at the end when the template has none).
- An older project without `steps:` shows All files, Git (in a repository), Claude setup and the workflow. Its first step change writes those tabs as its own `steps:`.
- Note steps also count as notes, so they show up in search and wiki links.

### Chats

- A chat is the real `claude` CLI (or your login shell) in a terminal inside the app, so everything claude does works as in GNOME Terminal, including `/remote-control` for your phone.
- Start one:
  - **New chat** at the end of a project's tab row (the arrow next to it offers **Shell**), or **New chat** / **New shell** when you right-click a project in the nav.
  - A **chat step** (`type: chat`) is a fixed tab in every project that uses the workflow. It starts the first time you open it. `agent: shell` makes it a shell, `path:` a folder inside the project, `args:` extra arguments for claude.
  - **Chat here** / **Shell here** when you right-click a folder in the file browser.
  - A **chat entry** in the nav (`type: chat`, `path:` defaults to home) has a page of its own, for chats outside projects.
- Chats keep running when you switch tabs or projects, reload or close the window; the screen comes back as you left it. After the service restarts (a pull, a reboot), they show **Stopped** with **Resume** and **New session**. Nothing starts by itself.
- **History** (end of the tab row) lists the Claude sessions in the project folder and below it; pick one to resume it in a new tab. A stopped chat step or entry also offers its folder's earlier sessions.
- A tab's right-click menu: **Rename…**, **Colour…**, **Pin** (pinned tabs come first and have no ×), **Summarize and continue**, **Close**. Closing a running chat asks first; claude's conversation stays in History.
- **Summarize and continue** asks claude (in the background, on a copy of the session) for a handoff summary, then starts a new chat with it. After 40 messages the button says so.
- When a chat goes quiet after working (claude finished or is asking for permission), or rings the bell, while you're not looking at it, its tab gets a dot and the project's spark in the nav turns the accent colour. If the window isn't focused, you also get a desktop notification (the browser asks for permission on your first chat).
- Drag files or folders from the browser, or a step tab, onto a chat or its tab: their paths are typed into the prompt.
- In the terminal, **Ctrl+C** interrupts as usual, **Ctrl+Shift+C** copies the selection and **Ctrl+Shift+V** pastes. Links open in your browser.
- Tab names, colours and pins live with the service's chat list (`~/.local/state/workbench/chats.json`), not in your YAML: they belong to a running session. A chat you want in every project is a chat step.

### Agent profiles

- An agent profile is a way to start claude: model and effort, permission mode, instructions added to its system prompt, a first prompt, extra folders, allowed and blocked tools, and an MCP config file. Prepare them in **New chat ▾ › Agent profiles…**; they're saved under `agents:` in the profile's YAML (comments kept), and you can write them by hand too.
- A profile can name one of your **Claude Code agents** (`~/.claude/agents` or the project's `.claude/agents`), such as an orchestrator. Then its model and effort are left to that agent.
- Pick one when you start a chat: **New chat ▾** lists Claude, your agent profiles and Shell; **Chat here as…** in the file browser and **New chat as…** in the nav menu do the same for a folder or a project.
- **New chat** itself starts the project's default: click the agent chip next to the category in the project header to set it (`agent:` on the folder entry). Chat steps and chat entries name theirs in `agent:` (`claude`, `shell` or a profile's name).
- The chat's bar shows the profile it started with (`Reviewer · opus · plan`). **Bypass permissions** shows a warning in the editor and a shield on its chats' tabs and bar.
- A chat keeps the settings it started with: **Resume** uses them, **New session** uses the profile as it is now (and sends its first prompt again), and Summarize and continue keeps the flags but not the first prompt.
- Renaming a profile updates everything that names it. A profile still in use can't be deleted; the message says where it's used.

### Context

- **Context** is claude's standing memory for a profile: who you are, how you like things done, what you're aiming for, what you've learned, the workflows you repeat, and an inbox. It lives in the profile's notes folder:
  - `context/`: `identity.md`, `preferences.md`, `goals.md`, and `README.md`, the routing note ("Remember how I want reports written" → `context/preferences.md`).
  - `knowledge/`: facts and how-tos, one topic per note.
  - `processes/`: workflows you repeat.
  - `inbox/`: handoffs and files to look at later.
- **Setting it up:**
  - The **Context** heading at the top of the sidebar starts with **Set up context in ~/notes**. It creates the folders and starter notes, never overwriting a file, and writes a `## Context` heading at the top of `index.md` (or of the first drawer's page) with links to the four folders, unless an entry already opens `context/`.
  - After that, **Context**, **Knowledge**, **Processes** and **Inbox** are ordinary nav entries: move, rename or delete them like any other; the fixed heading is gone. The Inbox entry shows the count.
- **Context** opens with tabs for its notes (Identity, Preferences, Goals, **Where things go**), editable in place, beside All files. The other three open their folder in the file browser. They're ordinary notes, so search and `[[wiki links]]` find them.
- **Every claude chat** (not shells) starts with the context:
  - `--add-dir` for the four folders and for the wiki itself, so claude can read and update them.
  - Appended to its system prompt: where the folders are, the routing note, the text of identity, preferences and goals (up to 16 KB), and what the wiki's pages are. In a project, claude is told its page (`projects/<Name>.md`) and asked to add to its `## Log` when it finishes something, leaving the frontmatter and `## Workflow` alone.
  - Agent profiles keep their own instructions and folders, and the context is added after them.
  - The chat bar shows **context · wiki**.
  - A chat keeps what it started with; a new chat picks up your edits.
- **Inbox:**
  - The nav shows how many things are in it.
  - **Summarize and continue** also saves its summary there as `YYYY-MM-DD HH.MM <chat>.md`.
  - **Send to inbox** in the file browser's right-click menu copies a file there. A name that's taken gets a number, and nothing is overwritten.

### Claude setup

- **Claude setup** shows what claude loads: **skills**, **MCP servers**, **agents**, **commands**, **hooks** and **plugins**. Only MCP servers can be changed here (switched on or off); the rest is read-only. Each item has a badge for where it comes from:
  - **Yours** (`~/.claude`, `~/.claude.json`),
  - **Project** (the folder's `.claude/`, `.mcp.json`),
  - **Local** (only you, in that folder),
  - **Managed** (`/etc/claude-code`),
  - or the **plugin** that brings it.
- Two places show it:
  - **The rail** on the right edge (part 12) has **Skills** and **MCP** for the drawer you're in: what claude loads in the drawer's folder (everywhere, when the drawer has no folder). The rail also has **Files** and **Git** for that folder and the drawer's **Settings**.
  - **The tab:** an item's **Claude setup** step (an older project has one after All files) shows every kind, for its folder: skills, MCP servers, agents, commands, hooks and plugins.
- **Overridden** items are dimmed and say what claude uses instead: a skill of the same name in a nearer scope, or a local MCP server over a project or user one. A skill also wins over a command of the same name.
- **MCP servers** show their state:
  - **On**,
  - **Off** (in settings or `/mcp`),
  - **Not approved** (a project server claude will ask about),
  - **Blocked** (managed policy),
  - **Broken**.
- **Switches** turn MCP servers on and off, the way `/mcp` does: the folder's `disabledMcpServers` list in `~/.claude.json`, so the app and `/mcp` always agree.
  - In a folder (a project's tab, or the rail of a drawer with a folder), a switch acts in that folder. A folder inside a repository shares the repository's list, as in claude.
  - In the rail of a drawer **without a folder**, a switch is the drawer's default (`mcpOff:` on the drawer's page; on `index.md` for a profile without drawers): off turns it off now in every project of the drawer, and the first chat the app starts in any other folder of the drawer turns it off there too. Switch it back on in one project and it stays on there. On again takes it out of `mcpOff:` and turns it on in every project.
  - A plugin's details have **Turn all off** / **Turn all on** for its servers.
  - Servers that are off fold behind **N off · Show**. The filter still finds them.
  - New chats use the change. Running chats keep their servers until they restart (or use `/mcp` in them). Undo is in the toast.
- **Check** on a server tests it: Workbench starts it (or connects), asks for its tools, and stops it again. The tools and their descriptions are listed, or the error with the end of the server's log. **Check all** checks every server that is on.
  - A server that wants a sign-in says so; signing in is done in claude (`/mcp`).
  - A project server that claude hasn't approved asks before it runs.
- **Plugins** show their marketplace, version, where they're turned on, and what they bring; click a count to see those items.
- **Pinned skills** (part 12): `skills:` in the frontmatter of `index.md` (every chat), a drawer's page (its chats) or an item's page (chats started there) names the skills to use. A chat gets the three lists merged, and its instructions name each one with its description, so claude reaches for them.
  - Skills of your own for this wiki go in `<wiki>/skills/<name>/SKILL.md`. They show in Skills with a **Wiki** badge and load **only** in chats where they are pinned (claude gets them as a session plugin, `--plugin-dir`, so they are `/wiki:<name>` there).
  - Pinning: in the rail's **Skills**, pick a skill and **Pin to <drawer>** (the strip at the top shows the profile's, the drawer's and, on a project's tab, the page's lists; × unpins). On an item's card, the **Skills** chip ticks skills on or off for that page. A name nothing resolves is marked *not found*.
- **Secret values are hidden everywhere:** env values, headers, passwords and keys in URLs, values after flags like `--token`, and known token shapes. `${VAR}` references stay readable.
- To change anything, use claude (`claude mcp`, `/plugin`, `/mcp`) or edit its files, then **Refresh**.

### Servers

The **Servers** page (the stacked-boxes button in the nav header, or Ctrl+K) shows what's running in the profile's projects, checked every 3 s while it's open:

- **Found by itself:** any of your programs listening on a TCP port whose working folder is inside a project (the deepest project wins), read from `/proc`. Each row shows the port, the program, its folder, how long it has been up, and a quick HTTP check: `200 OK`, another status, or `listening` if it doesn't speak HTTP. Workbench itself and other users' programs are left out.
- **Declared:** a project's `servers:` list. A declared server with a `port` merges with what runs there; one that isn't running shows red (**down**), and a `url` is what gets checked.
- **Actions:** **Open** (in your browser), **Copy URL**, and **Stop**, which asks first and then sends SIGTERM, as Ctrl+C would.
- **In the nav,** a project with a server up gets a small green mark (with a count past one), checked every 15 s; red when a declared one is down. The project card says "2 servers running" and links to the page.

### Git

An item's **Git** step shows its folder's repository, with its count of changed files. An older project in a git repository (or in a folder of one) has one after All files.

- **Changes:** staged files and changes (new files included), each with Stage, Unstage and Discard. Space stages the selected file; **Stage all**, **Unstage all** and **Discard all** do the whole list.
- **The diff** of the selected file is on the right. Each hunk has **Stage hunk**, **Unstage hunk** or **Discard hunk**, so you can commit part of a file.
- **Discard** asks first. Undo in the toast that follows puts your edits back. New files go to the Trash.
- **Commit:**
  - Write the message (Ctrl+Enter commits), or click **Draft** and claude writes one from the staged diff, in the style of your recent commits. You edit it before committing; Draft never commits.
  - **Amend** changes the last commit, until it is pushed.
- **Branch bar:**
  - The branch name opens a menu: switch (remote branches get a local one that tracks them), **New branch…**, **Rename…** and **Delete…**. Deleting a branch with unmerged commits names them and asks again.
  - Switching with uncommitted changes asks whether to stash them first or bring them along.
  - ↑↓ show how far you are ahead of and behind the upstream.
  - **Fetch**, **Pull** and **Push** (**Publish** for a branch that isn't on the remote yet). Pull only fast-forwards; when both sides have new commits, it offers to merge. There is no force push.
- **Fetching:** each repository of the active profile is fetched quietly every 10 minutes, and when you open its tab. Git uses your own SSH keys and credential helper and never waits for a password prompt; a failed fetch shows in the tab.
- **Conflicts** (after a merge or a stash pop): a banner lists the files.
  - **Open** opens a Markdown file as a note, and anything else in its default app.
  - **Ask claude** starts a chat in the project that's asked to resolve them.
  - **Mark resolved** stages the file, and asks first if conflict markers are still in it.
  - **Abort merge** goes back to how things were.
- **Stashes:** **Stash…** in Changes. Each stash has **Pop**, and right-click for Apply and Drop.
- **History:** the branch's last 200 commits, with **Load more**. Click a commit for its message, files and diffs; right-click it to copy its hash.
- **In the nav,** a project shows a small dot for uncommitted changes, ↑ for commits to push and ↓ for commits to pull, in red when there are conflicts. The card shows the branch and the same counts; click it to open the Git tab. **Ctrl+K** has "<project> › Git".

### Notes

- A **note** entry opens formatted (GitHub-flavoured Markdown: tables, task lists, images next to the note). **Edit** or **Ctrl+E** switches to the editor in the same place, and back.
- Edits **save automatically** a second after you stop typing, and when you leave the note. **Ctrl+S** saves at once.
- A note changed on disk (another editor, `git pull`) reloads while it's open. If you have unsaved edits at that moment, autosave pauses and a banner offers **Reload from disk** or **Keep mine**.
- **New note…** in the right-click menu of a heading or group creates `<notes>/<Title>.md` and its entry in one step.
- `[[Name]]` links to the note with that file name in the notes folder (`[[folder/Name]]`, `[[Name|shown text]]` and `[[Name#Heading]]`, which scrolls to the heading, work too). A link to a note that doesn't exist yet looks faint; clicking it offers to create the note. Relative links like `[x](other.md)` open in the app too.
- **Search** (the box in the top bar, **Ctrl+Shift+F**) finds notes containing every word you type, across the notes folder and your note entries. With no words it lists notes by date. **Enter** opens the first result.
- A **daily** entry opens today's note, `<notes>/daily/YYYY-MM-DD.md`, creating it from `<notes>/templates/daily.md` the first time (`{{date}}` and `{{title}}` are filled in). The arrows step to other days. Left open past midnight, it moves to the new day.
- **Task boxes** (`- [ ]`) tick in the formatted view too; the change saves like an edit.
- **Code blocks** are coloured for JavaScript and TypeScript (with JSX), JSON, CSS, HTML and Markdown; other languages stay plain.
- Without `notes:` in a profile, the app offers to set it to `<home>/notes` with one click. The folder is created with the first note.
- **Properties:** YAML frontmatter at the top of a note (`---` … `---`) shows as a row of properties above it instead of as text. Broken frontmatter says so there; the note still opens.
- **Mentions:** under every note, the notes that link to it, with the lines that do. Click one to open it.
- **Rename** (or **F2**) renames a note in the notes folder and rewrites the links to it in your other notes: `[[Old]]`, `[[folder/Old]]`, with headings and aliases kept, and relative links like `[x](Old.md)`. Renaming a `.md` in the file browser does the same. Notes outside the notes folder are named by your config, so they are renamed there.
- `[[Project/docs/design.md]]` links to a file inside a project (a folder entry) by the project's name: Markdown opens as a note, anything else opens its folder.
- A `<notes>/templates/page.md` is used for new notes (New note…, or created from a wiki link), with `{{title}}` and `{{date}}` filled in.
- **Tags:** `tags: [game, art]` in a note's frontmatter, or `#game` in its text (outside code; a heading's `#` and a URL's `#anchor` don't count). The properties strip shows them as links, and a `#tag` word in the search box finds the notes carrying the tag (`#game sprites` combines a tag with words).
- **Before you type a query,** the search page lists the wiki's **Tags** with counts, and **Pages to write**: the `[[names]]` your notes link to that have no note yet, with who links to them. Click one to create it from the page template and open it.

### Files

- An item's **File browser** (All files) and folder steps show a file browser: a tree with sizes and dates, and a preview of the selected file on the right.
- Click the arrow to expand a folder in place; **double-click** (or **Enter**) to make it the top. The path bar jumps back up, and so does **Backspace** or **Alt+←**.
- **Filter by name** narrows the tree to matching names in the folders you have open; **Search all folders** looks through the closed ones too. Click a column header to sort.
- Dotfiles are hidden; **Ctrl+H** shows them. In a git repository, files `.gitignore` excludes (`node_modules`, `dist`, logs) are shown dimmed.
- Previews: images, PDF, video and audio, Markdown formatted, and other text as plain text (the first 200 KB). **Open as note** (or Enter) opens Markdown in the notes view, where you can edit it.
- **F2** renames in place, **Delete** moves the selection to the GNOME Trash (`gio trash`), and the toolbar makes a new folder or file. Drag files onto a folder or a path-bar step to move them; hold **Ctrl** to copy instead. **Ctrl+C / Ctrl+V** copy and paste, and **Duplicate** makes `name copy.txt`. Rename, move and Trash have **Undo** (Trash puts the item back unless something has taken its place); nothing is ever overwritten.
- Files dragged in from Files or the desktop are copied into the folder under the pointer (up to 2 GB each).
- **Compute size** (a folder's menu, or the toolbar for every folder shown) adds up a folder; very big ones stop after 10 s and show "≥".
- Very large folders draw only the rows in view.
- Right-click for the rest: open in the default app, open the folder in Files, copy the path.
- The tree follows changes on disk while it is open.

### Assets and media

- **List / Gallery:** the two buttons in every file browser's toolbar. The choice is remembered per folder, and a subfolder takes its parent's until you pick one for it.
- **Tiles:** each tile has a thumbnail. Folders are tiles too, and a Godot project shows its icon.
  - Click, Ctrl/Shift-click, the arrow keys, Enter, F2, Delete, right-click and drag work as in the list.
  - The chips filter by type (Images, 3D, Video, Audio, Other); the slider sets the tile size.
- **Thumbnails** are kept in `~/.cache/workbench/thumbs` and made once per version of a file.
  - The browser makes them for images, video (a frame a tenth of the way in), audio (its waveform) and 3D models (a render).
  - A `.blend` shows the preview Blender saves inside the file (Blender's default when saving).
  - Formats a browser can't decode (TGA, EXR, PSD, DDS, many MKV/H.265 videos, Draco-compressed glTF) show an icon.
  - The cache prunes itself past 300 MB.
- **Previews:**
  - **3D files** (glTF/GLB, OBJ with its .mtl, FBX, STL) open in a viewer: drag to turn, scroll to zoom, right-drag to pan. It has Wireframe and Grid toggles and Reset view, and shows vertex, triangle, mesh and material counts and the model's size.
  - **Images** show their size in pixels and format. Select two images (Ctrl-click) to compare them, with a slider or side by side.
  - **Audio** shows its waveform; click it to seek.
- **Open in Blender / Godot:**
  - A `.blend` opens in Blender, and a Godot project's files (or the project folder) open in the Godot editor, when those programs are installed.
  - Use the button in the preview, double-click or Enter (or the right-click menu, for a project folder).
  - `openWith:` in the profile adds your own programs, or overrides these.

## Security

The service binds to loopback only. It accepts a request only if:

- the `Host` is its own address,
- the `Origin` (if any) is its own address, and
- an `X-Workbench: 1` header is present.

Other websites therefore cannot call it. Launch requests name an entry's (or a step's) position in your config, never a command.

Notes can only touch:

- Markdown files inside the profile's `notes:` folder,
- the files of that profile's note entries,
- images inside those places, read-only.

The file browser can open the profile's `home:`, its `notes:` folder, its folder entries and their folder steps, and everything inside them; nothing else. It can't rename, move or trash those folders themselves, it never overwrites a file (copies, uploads and restores from the Trash take a free name or refuse), and it deletes only by moving to the Trash. It won't start `.desktop` files or programs. Previews of media use a random, 10-minute link to one file, because media players can't send the `X-Workbench` header. A report's link covers its own folder, so its styles and scripts load. The report runs in a sandbox without Workbench's origin, so it can't read the app or call the service. These `/raw/` links are the one place the service accepts requests from such a page; the `Host` is still checked.

Paths are checked after resolving symlinks, so `..` or a link can't reach anything else. Background pictures are copied only from the profile's folders, only raster types (no SVG, which can carry scripts), and served only by plain name from the backgrounds folder.

Agent profiles only choose flags for claude (`--model`, `--permission-mode` and the rest), from your YAML; a request names a profile, never flags. A chat is shell access, so its terminal socket (`/pty/`) needs more: browsers can't add the `X-Workbench` header to a WebSocket, so it must come from Workbench's own `Origin`, and it carries a random token that changes every time the service starts, which only the app can read through the API. Chats start from an entry or step in your config, by its position; a request never carries a command or arguments, and **Chat here** only works inside the profile's folders. Claude's transcripts in `~/.claude/projects/` are read for History, never written.

**Servers** lists only your own processes whose folder is inside one of the profile's projects. **Stop** names a process and port; the service checks again that this process is yours, still listens on that port and runs in a project before it sends SIGTERM, and refuses anything else.

**Thumbnails** are read and stored only for files of the profile's folders. An uploaded one must be a WebP or PNG under 512 KB, and is stored under the file as it is at that moment. A 3D model's preview loads through a link that serves only its own folder. **Open with** names only the file: the program and its arguments come from `openWith:` or the built-in rules, each `{file}`/`{dir}`/`{godot}` becomes one argument, and nothing runs through a shell.

**Git** works only on the repositories of the profile's projects. A request names the project; files, branches, stashes and commits must be ones git lists. A hunk is found again by its hash before it is applied, so the page never sends a patch. Git runs with no shell and never prompts. It also runs with `core.fsmonitor` off: a repository's config could otherwise name a program to run on a plain `git status`, so looking at a cloned repository never runs anything from it. Committing, merging and switching branches run the repository's hooks, as git in a terminal does. Error messages have credentials in URLs masked. **Draft** runs `claude -p` with no tools and no saved session; only the staged diff (up to 60 KB) and your recent commit subjects are sent.

Each claude chat starts with a `SessionStart` hook (passed with `--settings`, merged with your own hooks) that runs `server/session-hook.mjs`. It only writes the chat's new session id to `~/.local/state/workbench/sessions/`, so a chat's tab follows `/clear` and `/resume`.

**Context** is set up only when you ask, and only inside the profile's notes folder; it never overwrites a file. **Send to inbox** copies only files from the profile's folders (checked after resolving symlinks), under a free name.

**Claude setup** reads claude's files and writes only one thing: the `disabledMcpServers` list of a folder's entry in `~/.claude.json`, for the MCP switches. That list is the same one `/mcp` writes. The file is read again just before each write and written atomically, with its mode kept. A switch takes only servers the setup lists for that folder. Secret values are masked in the service, so they never reach the browser, and only the MCP servers' keys and the open folder's entry are read from `~/.claude.json`. A check names a server by its id; the command or URL comes from claude's files, read again at that moment, never from the request. It runs only servers claude would start. One that claude hasn't approved yet runs only after you confirm. Folders are limited to the profile's own.

## Development

```sh
npm run dev        # service on 7420 (auto-restart) + Vite with hot reload on 7421
npm test           # Vitest: config ops, store, guard, launch, notes, wiki links, files, chats, context, Claude setup, MCP checks, servers, git, thumbnails, .blend previews, open with, profiles, HTTP API
npm run e2e        # Playwright against a throwaway config; programs are not started, chats and MCP checks run stand-ins
npm run build      # type check + production build
```

Server code is TypeScript that Node runs directly, so there is no build step for it.

| Path | What it does |
| --- | --- |
| `shared/config-schema.ts` | zod schema and types shared by the UI and the service |
| `server/config-ops.ts` | edits applied to the YAML document |
| `server/config-store.ts` | loading, validation, atomic writes, watching and undo |
| `server/notes.ts` | which files notes may touch; reading, saving (rev checked), listing, search, images, watching |
| `server/files.ts`, `server/trash.ts`, `server/paths.ts`, `server/watch.ts` | the file browser's listing, previews and operations; putting things back from the Trash; the folders a profile may reach; folder watching |
| `server/servers.ts`, `server/procfs.ts` | servers running in projects: listening sockets and their processes from `/proc`, declared servers, health checks, Stop |
| `server/thumbs.ts`, `server/open-with.ts` | gallery thumbnails (the cache, .blend previews, a Godot project's icon); the program a file opens in |
| `server/git.ts`, `shared/git.ts` | git per project: status, diffs and hunks, stage, discard with Undo, commit, Draft, branches, stash, fetch, pull, push, conflicts, history, the nav's marks |
| `server/project-dates.ts` | a project's created and updated dates |
| `server/backgrounds.ts` | background pictures: copies in the config folder, listed, served and deleted by name |
| `server/chats.ts`, `server/session-hook.mjs`, `server/claude-sessions.ts`, `server/agents.ts` | chats in pseudo-terminals (node-pty, a headless xterm per chat), the saved chat list, following `/clear`; reading claude's transcripts for History; agent profiles as claude flags |
| `server/context.ts` | context folders: status, setup, what a chat is told, handoffs and files into the inbox |
| `server/claude-setup.ts`, `server/mcp-check.ts`, `server/mask.ts` | reading claude's skills, MCP servers, agents, commands, hooks and plugins; checking an MCP server; masking secrets |
| `server/guard.ts`, `server/launch.ts`, `server/main.ts` | request checks, opening and launching entries, the HTTP API and the chat socket |
| `bin/workbench` | opens the window; installs, removes and prints the systemd units; the update step after a pull |
| `src/` | the UI: nav panel, main pane, dialogs, Ctrl+K, profile settings, notes (view, editor, search, daily), file browser and gallery, 3D viewer, project page, Git tab, chats, context, Claude setup, servers |

## Roadmap

| Part | What it adds |
| --- | --- |
| 2 | Markdown notes (done) |
| 3 | File browser (done) |
| 4 | Project cards (done) |
| 5 | Agent chats (done) |
| 6 | Claude setup: skills, MCP servers and more (done) |
| 7 | Context folders (done) |
| 8 | Polish: Ctrl+K, profile settings, systemd service, the known gaps, Servers (done) |
| 9 | Git per project: changes, hunks, commit with Draft, branches, stash, pull and push, conflicts, history (done) |
| 10 | Assets and media: gallery view, thumbnails (.blend included), 3D viewer, audio waveforms, image compare, Open in Blender / Godot (done) |
| after | Drawers; MCP switches; items: blank entries built from removable steps (done) |
| 11 | The wiki: pages as configuration (done) |
| 12 | Workspaces: the drawer rail, pinned skills, the chats dock (in progress) |
| later | A Tauri window, if wanted |
