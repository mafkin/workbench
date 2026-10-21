# Workbench: context for Claude sessions

This is a personal Linux workbench for one user. It's a local web app with a React UI and a Fastify service on `127.0.0.1:7420`. The user switches between **Work** and **Personal** profiles, each with its own configurable left nav panel. The app is built **part by part**; parts 1 and 2 are done. Start with the decisions and per-part notes in [docs/roadmap.md](docs/roadmap.md). The [README](README.md) covers usage and the config format.

## How to work with this user

- **Ask before you build.** The user wants to design each part themselves ("I want to build this part by part the way I want"; "look at its features and ask what I want"). At the start of a part:
  1. Ask about the decision points listed for it in `docs/roadmap.md`. Use multiple-choice questions with 2-4 options, put the recommended option first, and add previews for visual choices.
  2. Then write the plan.
- **Plan first.** Any change touching more than two files gets a short plan in Plan Mode, approved before you write code. Part 1's plan used these sections: Context, Where things live, Stack, Files, Behaviour, Verification.
- **Bug fixes are test-first.** Write a minimal failing test that reproduces the bug, then fix it, then run the tests until they pass.
- **Secrets.** Never print or ask for tokens or passwords in chat; the user edits `.env` files themselves.
- **Failures.** When something fails, give the exact command and its output.
- **Trying changes.** The user runs the app on their desktop and pulls changes to try them. At the end of a part, say what to pull and what to click.

## Status

- **Part 1 is done.** It's in commit `2a8811a` on `main` and includes:
  - the app shell, with a Work/Personal switch (Ctrl+1/2) that also swaps the accent colour,
  - the configurable nav panel: headings, entries, one level of groups,
  - edit mode with drag and drop, add/rename/delete, right-click menus and undo,
  - YAML config with live reload, comment-preserving writes and a banner for broken files,
  - opening and launching entries, plus the GNOME launcher.
- **Part 2 (Markdown notes) is done** on branch `claude/inspiring-einstein-vwftq8` (not yet merged to `main`). It includes:
  - note entries open formatted; **Edit** / Ctrl+E swaps in a CodeMirror editor in place,
  - autosave (1 s after typing, and on leaving) against the file's rev; a change on disk reloads the note, or, with unsaved edits, shows a conflict banner (Reload from disk / Keep mine),
  - a `notes:` folder per profile (a hint sets it to `<home>/notes` in one click), **New note…** in heading and group menus, `[[wiki links]]`, search (Ctrl+Shift+F), and `daily` entries made from a template,
  - Back (Alt+← or the top-bar arrow) for hops between notes.
- **Placeholders:** folder and project entries open a page whose placeholder text points to parts 3 and 4.
- **Next:** part 3 is next in the suggested order, but ask the user which part they want next.
- **Known gaps:**
  - The selection is stored by address (`section.index` or `section.group.index`) in localStorage, so it doesn't follow an entry that has moved.
  - There's no UI for profile settings (name, accent, home) or for adding profiles; both are file-only, except `notes:`, which the hint can set.
  - When the YAML file is broken, the pencil button still toggles but does nothing.
  - Notes: search reads the files on every query (no index; capped at 5000 notes). `[[Name#heading]]` opens the note but doesn't scroll to the heading. Task checkboxes can't be ticked in View; edit the text instead. Renaming a note in a file manager breaks links to it. Code blocks have no syntax colours.
  - "Today" is worked out when the daily entry opens; after midnight, open it again.

## Commands

```sh
npm install
npm test           # Vitest: 106 tests (config ops, store, guard, launch, notes, wiki links, HTTP API)
npm run e2e        # Playwright: 21 tests; in a fresh environment run `npx playwright install --with-deps chromium` first
npm run build      # tsc -p . (TypeScript 7) + vite build
npm run dev        # service on 7420 (node --watch) + Vite with hot reload on 7421 (proxies /api)
bin/workbench      # desktop only: start the service if needed, then open the window
```

Run `npm test`, `npm run e2e` and `npm run build` before you call a part done. In a cloud container whose preinstalled Chromium doesn't match Playwright's version, don't download browsers: run e2e with an untracked config that spreads `playwright.config.ts` and sets `use.launchOptions.executablePath: '/opt/pw-browsers/chromium'`. Desktop actions do nothing in a cloud container: `xdg-open`, launchers, "Open in Files", the GNOME launcher. That's expected. The e2e server fakes `spawn` and logs launches to a file, so tests never start real programs. Keep it that way.

## Architecture

| Path | Role |
| --- | --- |
| `shared/config-schema.ts` | zod schemas and types for profiles, items, ops and addresses, used by both the UI and the service. `ItemAddr = {section, group?, index}`. |
| `server/config-ops.ts` | Ops (`addSection`, `moveItem`, …) applied to a `yaml` **Document**, not to plain data, so comments, key order and flow style survive. Every result is validated against the `Profile` schema. |
| `server/config-store.ts` | Files are the source of truth. Each file has a rev (content hash); a stale rev gets 409. Writes are serialized and atomic (temp file + rename). `fs.watch` picks up hand edits. Broken files get 423 and are never written. One level of undo. Emits `change`. |
| `server/main.ts` | Fastify routes: `/api/state` (includes `home`), `/api/profiles/:id/ops`, `/api/profiles/:id/undo`, `/api/active`, `/api/open`, `/api/stat`, `/api/notes/{file,list,search,asset}`, and the SSE stream `/api/events` (events `state` and `note`). Serves `dist/` in production. `buildServer()` is exported for tests. |
| `server/notes.ts` | Notes service. `#resolve` decides which files notes may touch: `.md` in the profile's `notes:` folder, the exact paths of its note entries, and images in those places, all checked after `realpath`. Saves are rev-checked like profiles (`rev: null` = create, never overwrite), atomic, serialized per file, and keep the file mode. Watches the folders of opened notes and emits `note {path, rev}`. |
| `server/fs-util.ts` | `writeAtomic` and `revOf`, shared by the config store and notes. |
| `server/guard.ts` | Every request must have the right Host (blocks DNS rebinding) and Origin, and every `/api/*` request needs `X-Workbench: 1`. Keep this for all new routes. |
| `server/launch.ts` | Links and paths open with `xdg-open`; launchers run as a detached `spawn` with no shell, `~` expanded. `/api/open` takes an entry **address** from the config, never a command. |
| `server/seed.ts` | First-run config built from real folders on the user's machine. |
| `src/App.tsx` | State, profile switching, run-ops-with-undo, menus, shortcuts. The selection is an entry address or `note:<path>`; a back stack; the notes context (`src/lib/notes-ctx.ts`); quick-create and creating notes from wiki links. |
| `src/components/NavPanel.tsx` | dnd-kit: sortable sections and items, cross-list drops, collision priority from innermost to outermost. |
| `src/components/MainPane.tsx` | Top bar (back, crumbs, search box), Home overview and the per-type entry pages. New parts plug in here. |
| `src/components/NoteView.tsx` | One note: load, View/Edit, autosave, live reload, conflict banner, "missing" state. `DailyView`, `SearchView`, `NewNoteDialog` and `NotesFolderHint` sit next to it. |
| `src/components/Markdown.tsx`, `NoteEditor.tsx` | react-markdown + remark-gfm + our wiki-link plugin (`src/lib/wikilinks.ts`); the CodeMirror 6 editor, lazy-loaded as its own chunk. |
| `src/components/ItemDialog.tsx` | The add/edit entry dialog. |
| `src/lib/events.ts` | SSE read through `fetch`, because EventSource can't send the X-Workbench header. Note events (and reconnects) go to `onNoteEvent` listeners. |
| `src/theme.css` | Design tokens on `:root`. Per-profile accent goes in `--accent`; also `--accent-soft` and `--accent-line`. |

## Conventions and gotchas

- **Server TypeScript runs directly on Node 26** (type stripping). Only erasable syntax: no enums, no parameter properties. Imports use `.ts` extensions.
- **Imports:** `moduleResolution: nodenext`, so packages without an `exports` map need full subpaths, e.g. `lucide-react/dynamic.mjs`.
- **YAML quirks:**
  - The parser stores a comment above a list's first item on the list itself; `attachLeadingComments` moves it onto the item.
  - A bare `~` is YAML null, so quote it: `home: "~"`.
- **Style:** dark only, tame colours, using the tokens from `theme.css`. Small uppercase muted headings, a 2px accent bar plus a soft accent background on the selected row. Keep new UI consistent with this.
- **UI state:** per-browser state (nav width, collapsed headings, selection) lives in localStorage, read through `src/lib/local.ts` with try/catch. Anything the user configures belongs in the YAML.
- **Testing drag and drop:** Playwright drags need `mouse.down` followed by moves with `steps`; see `e2e/nav.spec.ts`.
- **File access:** any new route that reads or writes user files goes through a confinement check like `Notes.#resolve` (realpath, then allowed roots). Part 3's file browser should reuse that approach.
- **`fs.watch` on Linux:** a watch on a folder that gets deleted goes quiet without an error; the only sign is an event named after the folder itself (see `Notes.#replaced`).
- **react-markdown components:** a component defined inline is a new type on every render and remounts; keep stateful ones (like images, which fetch) at module level.
- **Images in notes** load through `fetch` + blob URLs, because `<img>` can't send the X-Workbench header.

## The user's machine (not visible from the cloud)

- **System:** CachyOS (Arch), GNOME on Wayland, Node 26, npm. No Rust or cargo, no tmux.
- **Browsers:** Firefox is the default. GNOME Web 51 is installed, but its web-app mode can't be set up from a script, so `bin/workbench` uses a GNOME Web app if one exists for this address and falls back to the default browser.
- **Programs installed:** `gnome-terminal`, `alacritty`, `nautilus`, `godot`, `blender`, `claude`, `gcc`/`make` (so node-pty can build), `python3`.
- **Paths:** the real config is in `~/.config/workbench/`; the launcher is at `~/.local/share/applications/workbench.desktop`; logs go to `~/.local/state/workbench/`.
