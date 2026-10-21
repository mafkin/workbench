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

## Configuration

Config lives in `~/.config/workbench/`. Set `WORKBENCH_CONFIG_DIR` to use another location.

| File | Holds |
| --- | --- |
| `settings.yaml` | active profile and profile order |
| `profiles/<id>.yaml` | one file per profile; add a file to add a profile |

You can edit the files by hand or through the app (the pencil at the top of the nav panel). App edits keep your comments, key order and formatting. Hand edits show up live. If a file stops parsing, the app shows the error and line, keeps showing the last good version, and won't write over your file until it is fixed.

```yaml
name: Work
accent: "#7d93ab"
home: ~/Documents/work
notes: ~/Documents/work/notes   # new notes, daily notes, search and [[wiki links]]
workflow:                       # the steps every project (folder entry) starts with
  - { label: assets, type: folder, path: assets }                                  # paths are inside the project
  - { label: modeling, type: launch, command: blender, args: [models/main.blend] }  # runs in the project folder
  - { label: design, type: note, path: docs/design.md }
  - { label: agent, type: chat }                                                   # claude in the project folder
  - { label: shell, type: chat, agent: shell, path: src }                          # your login shell, in src/
categories:                     # optional colours for project categories
  game: "#8fa58a"
sections:
  - title: Projects
    collapsed: false
    items:
      - { label: IFC Checker, type: folder, path: ~/ifc_checker_project }
      - label: Tuohi
        type: folder
        path: ~/Projects/tuohi
        description: Card game about birch-bark crafts   # the project card
        status: paused          # active (the default) | paused | done | archived
        category: game
        pinned: true
        steps:                  # this project's own steps instead of the workflow
          - { label: sprites, type: folder, path: assets/sprites }
          - { label: Godot, type: launch, command: godot, args: [--editor, --path, .] }
          - { label: tests, type: report, path: reports/index.html }   # an HTML page shown in the tab
          - { label: render, type: file, path: renders/latest.png }    # one file shown large
          - { label: board, type: link, url: "https://example.com/b" } # opens in your browser
      - { label: Runbook, type: note, path: ~/deploy-tools/RUNBOOK.md }
      - { label: Today, type: daily }   # optional: folder (default daily), template (default templates/daily.md)
      - { label: Docs, type: link, url: "https://example.com" }
      - { label: Scratch, type: chat, path: "~", args: [--model, opus] }  # a chat outside projects
      - label: Claude here
        type: launch
        command: gnome-terminal
        args: ["--working-directory=~/ifc_checker_project", "--", "claude"]
        cwd: ~                  # optional
      - label: Deploy           # a group: one level of entries inside
        type: group
        items: []
```

Any entry can have an `icon`, which is any name from [lucide.dev/icons](https://lucide.dev/icons). Keys the app doesn't know about are kept.

## Using it

- **Ctrl+1 / Ctrl+2** switch profiles. **Esc** leaves edit mode.
- **Edit mode** (pencil):
  - Drag headings and entries to reorder them, or move entries between headings and groups.
  - **+** adds an entry, the pencil renames or edits, and the bin deletes.
  - Deletes can be undone from the toast that appears.
- **Right-click** any heading or entry for the same actions.
- **Links** open in your browser and **launchers** start their program, both without a shell. Folders and notes open in the main pane.
- **Alt+←** or the back arrow in the top bar goes back to the previous page.
- **Home** shows what you opened last (projects and their steps, notes, folders) and today's note. It doesn't repeat the nav.

### Projects: cards and workflow steps

- A **folder** entry is a project. The top of its page is its card:
  - a **category** chip (pick one or make a new one),
  - a **status** (active, paused, done, archived),
  - a **pin**,
  - a **description** you click to edit.
- **In the nav,** each project shows its status as a dot, pinned projects come first in their heading, and archived ones hide until you click **N archived · Show**. While you edit the nav, the real order shows. Right-click a project to pin it, mark it or archive it.
- Below the card is a row of tabs: **All files** (the project folder), then the project's workflow steps.
  - A **folder** step shows that folder in the browser, with **Create folder** if it doesn't exist yet.
  - A **note** step shows the note in place, with Edit and autosave.
  - A **report** step shows an HTML page (a test or analysis report) with its own styles and scripts. It runs in a sandbox, cut off from Workbench.
  - A **file** step shows one image, PDF, video or text file large.
  - A **launcher** step starts its program in the project folder, and a **link** step opens its address in your browser.
- Steps are yours to name: **+** adds one (paths are inside the project). Right-click a tab to edit or remove it, and drag tabs to reorder them.
- Every project starts with the profile's `workflow:` steps. Changing a project's steps gives it its own `steps:`. From the right-click menu, **Use these steps for every project** makes them the `workflow:`, and **Reset to profile steps** goes back to it.
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

### Notes

- A **note** entry opens formatted (GitHub-flavoured Markdown: tables, task lists, images next to the note). **Edit** or **Ctrl+E** switches to the editor in the same place, and back.
- Edits **save automatically** a second after you stop typing, and when you leave the note. **Ctrl+S** saves at once.
- A note changed on disk (another editor, `git pull`) reloads while it's open. If you have unsaved edits at that moment, autosave pauses and a banner offers **Reload from disk** or **Keep mine**.
- **New note…** in the right-click menu of a heading or group creates `<notes>/<Title>.md` and its entry in one step.
- `[[Name]]` links to the note with that file name in the notes folder (`[[folder/Name]]` and `[[Name|shown text]]` work too). A link to a note that doesn't exist yet looks faint; clicking it offers to create the note. Relative links like `[x](other.md)` open in the app too.
- **Search** (the box in the top bar, **Ctrl+Shift+F**) finds notes containing every word you type, across the notes folder and your note entries. With no words it lists notes by date. **Enter** opens the first result.
- A **daily** entry opens today's note, `<notes>/daily/YYYY-MM-DD.md`, creating it from `<notes>/templates/daily.md` the first time (`{{date}}` and `{{title}}` are filled in). The arrows step to other days.
- Without `notes:` in a profile, the app offers to set it to `<home>/notes` with one click. The folder is created with the first note.

### Files

- A project's **All files** and folder-step tabs show a file browser: a tree with sizes and dates, and a preview of the selected file on the right.
- Click the arrow to expand a folder in place; **double-click** (or **Enter**) to make it the top. The path bar jumps back up, and so does **Backspace** or **Alt+←**.
- **Filter by name** narrows the tree to matching names in the folders you have open. Click a column header to sort.
- Dotfiles are hidden; **Ctrl+H** shows them. In a git repository, files `.gitignore` excludes (`node_modules`, `dist`, logs) are shown dimmed.
- Previews: images, PDF, video and audio, Markdown formatted, and other text as plain text (the first 200 KB). **Open as note** (or Enter) opens Markdown in the notes view, where you can edit it.
- **F2** renames in place, **Delete** moves the selection to the GNOME Trash (`gio trash`; restore it from Trash in Files), and the toolbar makes a new folder or file. Drag files onto a folder or a path-bar step to move them. Rename and move have **Undo**; nothing is ever overwritten.
- Right-click for the rest: open in the default app, open the folder in Files, copy the path.
- The tree follows changes on disk while it is open.

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

The file browser can open the profile's `home:`, its `notes:` folder, its folder entries and their folder steps, and everything inside them; nothing else. It can't rename, move or trash those folders themselves, it never overwrites a file, and it deletes only by moving to the Trash. It won't start `.desktop` files or programs. Previews of media use a random, 10-minute link to one file, because media players can't send the `X-Workbench` header. A report's link covers its own folder, so its styles and scripts load. The report runs in a sandbox without Workbench's origin, so it can't read the app or call the service. These `/raw/` links are the one place the service accepts requests from such a page; the `Host` is still checked.

Paths are checked after resolving symlinks, so `..` or a link can't reach anything else.

A chat is shell access, so its terminal socket (`/pty/`) needs more: browsers can't add the `X-Workbench` header to a WebSocket, so it must come from Workbench's own `Origin`, and it carries a random token that changes every time the service starts, which only the app can read through the API. Chats start from an entry or step in your config, by its position; a request never carries a command or arguments, and **Chat here** only works inside the profile's folders. Claude's transcripts in `~/.claude/projects/` are read for History, never written.

## Development

```sh
npm run dev        # service on 7420 (auto-restart) + Vite with hot reload on 7421
npm test           # Vitest: config ops, store, guard, launch, notes, wiki links, files, chats, HTTP API
npm run e2e        # Playwright against a throwaway config; programs are not started, chats run stand-ins
npm run build      # type check + production build
```

Server code is TypeScript that Node runs directly, so there is no build step for it.

| Path | What it does |
| --- | --- |
| `shared/config-schema.ts` | zod schema and types shared by the UI and the service |
| `server/config-ops.ts` | edits applied to the YAML document |
| `server/config-store.ts` | loading, validation, atomic writes, watching and undo |
| `server/notes.ts` | which files notes may touch; reading, saving (rev checked), listing, search, images, watching |
| `server/files.ts`, `server/paths.ts`, `server/watch.ts` | the file browser's listing, previews and operations; the folders a profile may reach; folder watching |
| `server/chats.ts`, `server/claude-sessions.ts` | chats in pseudo-terminals (node-pty, a headless xterm per chat), the saved chat list; reading claude's transcripts for History |
| `server/guard.ts`, `server/launch.ts`, `server/main.ts` | request checks, opening and launching entries, the HTTP API and the chat socket |
| `src/` | the UI: nav panel, main pane, dialogs, notes (view, editor, search, daily), file browser, project page, chats |

## Roadmap

| Part | What it adds |
| --- | --- |
| 2 | Markdown notes (done) |
| 3 | File browser (done) |
| 4 | Project cards (done) |
| 5 | Agent chats (done) |
| 6 | Skills & MCP panel |
| 7 | Context folders |
| 8 | Polish (Ctrl+K switcher, systemd user service) |
