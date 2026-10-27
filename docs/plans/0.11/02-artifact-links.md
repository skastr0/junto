# 0.11 Artifact links: backlinks from bodies and [[ ]] links

Owner: product-lead. Started 2026-10-27, the operator's ask. Part of 0.11.0.

## Target

Artifacts link to each other the way notes do. Typing `[[` in a document
picks an artifact by title, and a title that matches nothing creates a new
document. Every artifact shows what links to it, from other artifacts'
bodies as well as from comments and mail. Seats write the same links from the
CLI.

## Today

- Mentions are links in the text, by id:
  `[#42 fix tabs](junto://canvas/factory?node=...&item=...)`
  (`src/shared/mention.ts:15`, `mentionLink` :133, `mentionLinksOf` :150).
  A document's `#` picker writes them (`artifacts/mention-picker.tsx`).
- Backlinks are a projection of mail rows only: `work_mentions`, keyed to
  `work_messages` by a cascading foreign key
  (`src/main/junto/work/mention-state-schema.ts:12`), written with each row
  (`repository.ts:2711`). The Artifacts and Tasks panes show them
  (`threads/MentionedIn.tsx`). A link written inside an artifact's body counts
  for nothing.

## Decisions

- **A `[[ ]]` link is stored as a mention link, by id.** `[[` is how it is
  typed and how it is drawn (a chip with the title, the current title, so
  a rename never breaks a link). The text keeps the existing link form, so
  every reader of mentions already understands it.
- **Unresolved `[[New title]]` offers "Create document New title"** in the
  same Artifacts node, then writes the link to it. Nothing creates an
  artifact without that press.
- **Body backlinks are their own projection,** `work_artifact_links`, one
  row per (source artifact, target mention key), rebuilt from the head
  version of each artifact on every applied edit and rebuildable from the
  bodies. Expand-only schema step, numbered when it lands (canvas
  coordinates numbers with step 52).
- **What counts:** document markdown, pad text, sheet cells; a file
  artifact's body holds no text. The archived source drops out of the list.
- **"Linked from"** on an artifact lists both kinds: bodies that link it
  (with the line around the link) and mail and comments (as today).
- **CLI:** `junto artifact create|edit` accept `[[Title]]` and resolve it,
  within the seat's reach, to the id link before the edit applies. Zero
  matches or more than one is refused, naming the candidates. `junto artifact
  show` lists "linked from".
- **Out of scope:** links to a heading or a block, unlinked mentions,
  a graph view, links from Files.

## Tracks

| Track | Owner | Reviewer |
|---|---|---|
| L1 contract: body link extraction (pure, all three body types), `work_artifact_links`, the step, the projection on edit, "linked from" read API | product-feed | product-shell |
| L2 `[[` in documents: picker limited to artifacts in reach, create-from-unresolved, chip drawing, keyboard and screen reader | product-documents | product-accessibility, product-typography |
| L3 pad text and sheet cells: `[[` and links in their text, through L1's extractor | product-pad, product-sheet | product-documents |
| L4 "Linked from" panel in the Artifacts node, both sources | product-shell | product-feed |
| L5 CLI `[[Title]]` resolution and `show` backlinks | cli-lead | cli-protocol |
| Verify in the real app, dark and bright | product-verify | |

## Open: structure (operator)

Tags, nesting, or both: with the operator. Nothing in L1 to L5 depends on
the answer.
