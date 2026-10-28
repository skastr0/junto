# Junto 0.11 — plan

Status: in execution, started 2026-10-27. Owner: product-lead. Version: 0.11.0
(minor). Built from the operator's brief of 2026-10-27.

## What 0.11 is

0.10 made Junto's own data (artifacts, tasks, automations) good to work in.
0.11 reaches the data on the operator's machine: a **Files** node that opens a
region's folder as a file tree with a light editor, and the tools around it.

1. **Files node.** A canvas node, scoped to one folder on one machine, that
   shows a file tree and opens a file in the main pane, laid out like the
   Artifacts node. (F1, F2)
2. **Light editor.** Code and text open in an editor that highlights, edits
   and saves; Markdown opens in the editor we already have. No language
   servers, no tree-sitter, no grep. (F3)
3. **Quick open (Cmd+P).** A fuzzy search inside a node's modal, with a button
   too: file names in Files, items in Artifacts, Tasks and Automations. (F4)
4. **Drop files in.** Files from Finder dropped on the node card, on the
   modal, or on a folder row in the tree are copied into that folder. (F5)
5. **Preview.** PDFs and images preview in the main pane. Anything else
   offers Open in its default app and Reveal in Finder. (F6)
6. **Comments anywhere in a file.** A thread anchored to lines of code, to a
   box on an image, or to a box on a PDF page. (F7)
7. **Extract to artifact.** A box drawn on a PDF page (or an image) becomes an
   image artifact in an Artifacts node in reach, with a link back to the
   source. (F8)

## Decisions made in this plan

Recorded so no lead reopens them. A lead who finds one wrong in the code
mails product-lead with the receipt.

- **Kind name `files`.** `file` is taken by the image card
  (`src/shared/model/kinds.ts:166`). The Files node is plural, like
  `artifacts`.
- **The node owns its folder.** On creation the node stamps the innermost
  region's `defaults.paths[host]` (`src/shared/region-defaults.ts:80`) as its
  root, the way terminals and git do; the region default is never read again
  (`src/shared/model/region.ts:112`). The operator can change the root.
- **Host-local, crossing like file, link and git** (`src/shared/canvas-copy.ts:204`).
  The host is the editing machine's real short name at creation, and main
  refuses a node whose host is not this machine. Other machines see a stub
  `{of: "files", geometry, label?}`: never the host, root, folder name or
  file count, and the label only when the operator wrote one (the card
  derives the folder name from the root as it renders). Nothing that leaves
  the node (IPC replies, thread anchors, mention mail, extracted artifact
  descriptions) names an absolute path: node id plus relative path only.
  Same-host seats learn the root in onboard (cli). Files joins
  `COMMENTABLE_KINDS`, not `RESOURCE_KINDS`: seats use the filesystem.
- **Schema.** Step 51 adds the node, expand-only. Step 52 rebuilds `stubs`
  to accept `files` (`state-schema.ts:81`); it is a consolidate step, with the
  operator for approval. Without it Files stays home in 0.11 and other
  machines show nothing.
- **Ship tier.** Experimental while tracks build; on in ship at the cut once
  every track is verified.
- **Tree: `@pierre/trees`** (1.0.0-beta.6). Virtualized, with search,
  drag-and-drop, renaming and git status built in. Bleeding-edge is permitted
  (`AGENTS.md`, Dependencies).
- **Editor: CodeMirror** with `@codemirror/language-data`, the bare
  `EditorView` setup of `LiveMarkdownField.tsx`; Markdown files open in
  `LiveMarkdownField`. Decided on the F3 spike
  (`docs/research/editor-spike/README.md`, 0613f3324): CodeMirror opens a
  5,000-line file in 6 to 8 ms warm and types at 5.7 / 10.4 / 15 ms. Pierre
  with its `highlights` backend is as fast but needs `'wasm-unsafe-eval'` in
  the app window CSP, and on Shiki JS takes 1.2 s per open. The CSP stays as
  it is. `@pierre/diffs` stays at 1.1.21 for the git review.
- **PDF: `pdfjs-dist`** (6.4.299), loaded lazily, with its worker bundled.
  The CSP already allows `worker-src 'self' blob:` (`index.html:7`); the protocol adds `junto-file:` to it.
- **The renderer never names an absolute path.** Every call names the node
  and a path relative to its root; main resolves it, `realpath`s it and
  refuses anything outside the root, symlinks included. Delete moves to the
  Trash (`shell.trashItem`), never `unlink`. A write names the version it
  read (mtime and size) and is refused `stale` when the file changed.
- **Cmd+P is claimed** from the held list (`src/shared/key-table.ts:974`) for
  quick open inside a node modal.
- **Filename search runs in main**, over an index of the root (`git ls-files`
  when the root is a repo, else a walk that skips `.git` and `node_modules`),
  kept fresh by a watcher. The renderer gets the top 50 per keystroke.
  Artifacts, tasks and automations rank in the renderer with
  `src/renderer/lib/fuzzy-match.ts`.
- **Drops copy, never move or overwrite.** A name that exists gets ` 2`,
  ` 3`. Moves inside the tree are renames.
- **Out of scope:** grep across files, language servers, a terminal in the
  node, git actions (the git node has them), editing PDFs.

## Contracts (land first)

| Contract | File | Owner | Consumers |
|---|---|---|---|
| `files` node kind and card | `src/shared/model/kinds.ts` (+ physics, title, kind-icon, rows) | canvas | product, remote |
| Files service: list, index, search, read, write, create, rename, move, trash, import, watch | `src/shared/files.ts`, IPC in `src/shared/ipc.ts` | tech | product |
| File bytes for preview: `junto-file://<nodeId>/<relpath>` | `src/shared/file-url.ts` | tech | product |
| File thread subject and anchors: `lines` with a quote, `box`, new `pageBox {page, x, y, w, h}` normalised 0..1 | `src/shared/wire/thread-subject.ts` | product (product-feed) | canvas, cli |
| Quick open source | `src/renderer/lib/quick-open.ts` | product (product-modals) | product |

```ts
// src/shared/files.ts (sketch; tech owns the final shape)
type FilePath = string & Brand<"FilePath">;          // relative to the node root, no "..", "/" separated
type FileStamp = { readonly mtimeMs: number; readonly size: number };
type FileEntry = { readonly path: FilePath; readonly dir: boolean; readonly stamp: FileStamp };
type FileRead =
  | { readonly kind: "text"; readonly text: string; readonly stamp: FileStamp }
  | { readonly kind: "binary"; readonly mime: string; readonly stamp: FileStamp }
  | { readonly kind: "too-large"; readonly size: number };
type FilesError = "outside-root" | "not-found" | "exists" | "stale" | "too-large" | "denied" | "root-missing";
```

## Tracks

### canvas (canvas-lead)
- **F1 Node kind.** `files` in the closed `Node` union with `{host, root}`;
  physics, title, kind icon, rows and the schema step (expand only); model
  factories, palette and catalog entries; the card (folder name, file count);
  the stub on other machines. Behind a `files` feature, experimental tier,
  on in all-on. Commit 4a42dc78c is the touch list for a new kind.
- **F5 (card half).** Dropping Finder files on the card imports them into
  the root.

### tech (tech-lead), performance-lead reviews the index
- **F2 Files service in main.** `src/main/junto/files/`: the operations in
  the contract, root scoping, stale writes, Trash, a watcher that pushes
  changes, the name index and its ranking, IPC behind `trustedRendererIpc`,
  and the `junto-file:` protocol with byte ranges for PDFs. Text reads cap at
  5 MB. Preload exposes `webUtils.getPathForFile` for drops.
- Doctrine: a "Files node" paragraph in `docs/security-doctrine.md` stating
  the scoping rules above, reviewed by remote-lead.

### product (product-lead)
- **F2 UI, product-shell.** The Files modal: `FocusSurface` and `TwoPane`
  as in `ArtifactsNode.tsx:249`, `@pierre/trees` in the sidebar themed from
  house tokens, the main pane dispatching on file type, the comments rail.
  Unsaved changes marked; Cmd+S saves; a stale save offers reload or keep.
- **F3 Editor, product-documents.** Spike done (CodeMirror). The editor
  component: dirty state, save hook, find, a highlight style per theme from
  house tokens (product-typography), and the gutter control for line
  comments ("Comment on line N", `file-editor-gutter-comment`).
- **F4 Quick open, product-modals with product-keyboard.** The Cmd+P palette
  and its header button in Files, Artifacts, Tasks and Automations; the key
  table entry; list navigation from `src/renderer/lib/list-nav.ts`.
- **F5 Drops, product-sheet.** Drop on the modal and on a folder row, with a
  drop highlight; tree drag to move.
- **F6 Preview, product-pad.** The PDF viewer (pages, zoom, text selection)
  and the image viewer, with box drawing reused from the pad and browser box
  composer.
- **F7 Comments, product-feed.** The file subject and the `pageBox` anchor;
  line comments in the editor gutter, box comments on images and PDFs, the
  rail listing a file's threads, a thread re-finding its lines by its quote
  after edits.
- **F8 Extract, product-pad with product-documents.** "Extract as artifact"
  on a drawn box: render the region at 2x to PNG, put it in the content
  store, create a `file` artifact in an Artifacts node in reach, with the
  source file, page and box in its description.
- Review: product-typography for tokens and shared UI; product-accessibility
  for the tree, palette and viewers; product-automation and product-verify
  verify in the real app before a track is reported done.

### cli (cli-lead)
- No files command: seats use the filesystem. Two consumer changes once F7
  lands the file subject: `msg reply` maps subjects by an exhaustive switch
  with a file case (`src/main/junto/work/control.ts:2071`,
  `operator-threads.ts:226`), and onboard gains a files reach row (node id,
  label, and the absolute root to same-host seats only). Seats starting a
  line comment on a file is out of 0.11.

### remote (remote-lead)
- Confirm the host-local shape and the stub; review the doctrine paragraph.

### releases (product-releases)
- 0.11.0 notes and checklist in this folder, once tracks report done.

## Tracker

| Track | Owner | State |
|---|---|---|
| F1 node kind (step 51) | canvas | landed 9f7573e49 (reland after 7ff0f339e) |
| F1 card, mount, factory, card drop, host refusal in main | canvas | done, verified, operator approved |
| F1 stub (step 52) | canvas | operator asked; ships without it (b) unless they answer a |
| F2 service, protocol, doctrine | tech | done; index passed performance review on 200k files (6343f9d59); fff spiked and rejected |
| git config commands neutralised (security) | tech | landed e9cc0324e |
| shared-index commit guard | tech-ci | dd438c028, needs `core.hooksPath` set by the operator |
| F2 modal | product-shell | done, verified, operator approved |
| F3 editor (CodeMirror, spike 0613f3324) | product-documents | done, verified, operator approved |
| F4 quick open | product-modals, product-keyboard | done, verified 8 of 8, centred (6654b233b), operator approved keys |
| F5 drops | product-sheet, canvas (card) | done, 9 of 9 after the tree move fix c732058f5 |
| F6 preview | product-pad | done, review findings fixed 87d3ca92c, walk passed c5f7568ae |
| F7 comments | product-feed | done, verified; Junto renames carry threads (63d77dc27) |
| F8 extract | product-pad, product-documents | done, walk passed c5f7568ae |
| msg reply file subject, onboard files row | cli | after F7 contract |
| artifact links L1 to L5 | see 02-artifact-links.md | started |
| artifact labels T1 to T4 | product-feed, product-sheet, product-modals, cli-lead | done, reviewed, verified dark and bright on 696e7a292 (4b3379114, two nodes included); T1 70cc43ab1, T2 eed18eb5e to 696e7a292, T3 5d03f65d4 + 158873761, T4 7b2f0d976 + 0da13852c; operator rejected keep-for-the-window: filters persist with 04-view-state; colours added (C1 to C4) |
| label colours C1 to C4 | product-shell, product-sheet, product-typography, cli-lead | started; see 03-artifact-labels.md Colours |
| view state survives a restart V1 to V3 | product-feed, product-modals, product-shell | started; see 04-view-state.md; V2 renderer half a814caf86 + af56e79f0 + 2cbe76098 + 453dba647 on a stand-in, approved by product-shell and product-keyboard; V1 landed (b4759287e, 9d37e490a, 3266787ed, step 55), review product-shell and tech-lead; V2 restart proof passes (be5533c0b, clean HEAD and real tree); V3 Artifacts and Tasks restart proof passes (2b64d7ae0); product-verify walking the whole inventory |
| automations that know what fired them A1 to A4 | product-automations, automation-lead, product-cron, cli-lead | A1 to A3 verified dark and bright at 91b01dd8d (automations-a1-verify.spec.ts); A4 CLI in review; code steps K1 landed 91b01dd8d, K2 to K5 building; S1 landed e03c13b9f; see 05-automations.md |
| fleet state: one authority, with fallbacks | remote-lead, tech-lead, canvas-lead | direction approved by the operator; design in progress, see 06-fleet-state.md |
| remote review | remote-lead | F1 approved; doctrine conditions met (fsmonitor, sandboxed junto-file) |

## Carried to 0.12

- A rename fact for file threads, retiring the `files.thread-carry` seam
  entry (63d77dc27 writes the path in place; a journal rebuild would restore
  the old path).
- Index: long fresh queries p95 35 ms in the worker (budget 30), and the
  per-spawn main cost in `process-epoch.ts:100` (performance-lead).
- Files: an open file renamed outside Junto follows its new name (pair the
  watcher's delete and add by file id); a twin Files node on the same folder
  notices the other's save at once (tech-lead).
