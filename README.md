# Workbench

A local workbench for this Linux desktop. You switch between **Work** and **Personal** profiles, and each profile has its own configurable nav panel of headings and entries. The UI is React. A small Node service listens on `127.0.0.1:7420` and serves it.

## Run

```sh
npm install
npm run install-launcher   # adds "Workbench" to the GNOME app grid
bin/workbench              # starts the service if needed, then opens the window
```

`bin/workbench` builds the UI on first use and logs to `~/.local/state/workbench/server.log`.

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
sections:
  - title: Projects
    collapsed: false
    items:
      - { label: IFC Checker, type: folder, path: ~/ifc_checker_project }
      - { label: Runbook, type: note, path: ~/deploy-tools/RUNBOOK.md }
      - { label: Today, type: daily }   # optional: folder (default daily), template (default templates/daily.md)
      - { label: Docs, type: link, url: "https://example.com" }
      - { label: Card, type: project, project: card-id }
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

### Notes

- A **note** entry opens formatted (GitHub-flavoured Markdown: tables, task lists, images next to the note). **Edit** or **Ctrl+E** switches to the editor in the same place, and back.
- Edits **save automatically** a second after you stop typing, and when you leave the note. **Ctrl+S** saves at once.
- A note changed on disk (another editor, `git pull`) reloads while it's open. If you have unsaved edits at that moment, autosave pauses and a banner offers **Reload from disk** or **Keep mine**.
- **New note…** in the right-click menu of a heading or group creates `<notes>/<Title>.md` and its entry in one step.
- `[[Name]]` links to the note with that file name in the notes folder (`[[folder/Name]]` and `[[Name|shown text]]` work too). A link to a note that doesn't exist yet looks faint; clicking it offers to create the note. Relative links like `[x](other.md)` open in the app too.
- **Search** (the box in the top bar, **Ctrl+Shift+F**) finds notes containing every word you type, across the notes folder and your note entries. With no words it lists notes by date. **Enter** opens the first result.
- A **daily** entry opens today's note, `<notes>/daily/YYYY-MM-DD.md`, creating it from `<notes>/templates/daily.md` the first time (`{{date}}` and `{{title}}` are filled in). The arrows step to other days.
- Without `notes:` in a profile, the app offers to set it to `<home>/notes` with one click. The folder is created with the first note.

## Security

The service binds to loopback only. It accepts a request only if:

- the `Host` is its own address,
- the `Origin` (if any) is its own address, and
- an `X-Workbench: 1` header is present.

Other websites therefore cannot call it. Launch requests name an entry's position in your config, never a command.

Notes can only touch:

- Markdown files inside the profile's `notes:` folder,
- the files of that profile's note entries,
- images inside those places, read-only.

Paths are checked after resolving symlinks, so `..` or a link can't reach anything else.

## Development

```sh
npm run dev        # service on 7420 (auto-restart) + Vite with hot reload on 7421
npm test           # Vitest: config ops, store, guard, launch, notes, wiki links, HTTP API
npm run e2e        # Playwright against a throwaway config; programs are not started
npm run build      # type check + production build
```

Server code is TypeScript that Node runs directly, so there is no build step for it.

| Path | What it does |
| --- | --- |
| `shared/config-schema.ts` | zod schema and types shared by the UI and the service |
| `server/config-ops.ts` | edits applied to the YAML document |
| `server/config-store.ts` | loading, validation, atomic writes, watching and undo |
| `server/notes.ts` | which files notes may touch; reading, saving (rev checked), listing, search, images, watching |
| `server/guard.ts`, `server/launch.ts`, `server/main.ts` | request checks, opening and launching entries, the HTTP API |
| `src/` | the UI: nav panel, main pane, dialogs, notes (view, editor, search, daily) |

## Roadmap

| Part | What it adds |
| --- | --- |
| 2 | Markdown notes (done) |
| 3 | File browser |
| 4 | Project cards |
| 5 | Agent chats (real `claude` CLI in xterm.js, so `/remote-control` keeps working) |
| 6 | Skills & MCP panel |
| 7 | Context folders |
| 8 | Polish (Ctrl+K switcher, systemd user service) |
