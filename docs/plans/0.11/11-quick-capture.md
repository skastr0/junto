# Quick capture: Cmd+T writes anywhere

Owner: product-lead. Asked for by the operator on 2026-10-29. It ships in
0.11.1 if verified by that cut, otherwise in 0.11.2 right after; it does not
hold 0.11.1. The operator calls it critical: it is what makes Junto a second
brain.

## Target

Whatever the operator is doing, Cmd+T (or a button beside the needs-you feed
button) opens a capture surface with the cursor already in a new Markdown
document. They write at once. The same surface searches every artifact with
large previews, so they can open or edit an existing one in place. A new
capture is saved as they type, never lost, and later routed to the right
Artifacts node.

## Decisions

- **Cmd+T opens straight into writing.** There is no list to pick from first.
  The surface opens on a new, empty document in the live Markdown editor
  the artifacts already use (`LiveMarkdownField`), with the caret in its
  first line. The first line becomes the title unless one is typed.
  Ctrl+T on other systems. Cmd+T is free in `src/shared/key-table.ts`, and
  it works over the canvas, terminals and dialogs, as Cmd+K and Cmd+I do.
  Pressed again, or with Escape, the surface closes, and what was written
  stays saved.
- **One surface, two halves.**
  - Left: a search field and a list. With no query, it shows the Inbox
    first, then recent artifacts. With a query, it ranks every artifact on
    the canvas with the search index Cmd+K uses (title, labels, body).
  - Right: the editor, or a large preview of the focused row (a document
    rendered, a pad drawn, a sheet as a table).
  - Keys: arrows move through the list and preview; Enter edits that
    artifact in place; Cmd+Enter opens it in its own node; Cmd+N starts
    another capture; Cmd+L moves to the search field.
- **The type can change after.** A capture starts as a document. The header
  switches it to a pad or a sheet. While it is empty, it simply changes;
  after text, a pad keeps the text as a text box and a sheet keeps each
  line as a row. Undo puts it back.
- **Captures land in an Inbox.** Every capture is a real artifact from its
  first keystroke, in the canvas's Inbox: an Artifacts node the operator
  picks in Settings. With none set, the first Cmd+T asks once: pick an
  Artifacts node, or "Make an Inbox" places a new one at the canvas's edge.
- **Routing.** The capture header shows "Move to…" with up to three
  suggested nodes first. They are ranked by where the artifact's `[[links]]`,
  mentions and labels point, and by the node holding the artifacts most like
  it. A route is the move from `10-artifact-move.md`. The Inbox list is the
  triage queue: arrow down it, press M, and pick a node. Nothing routes on
  its own.
- **Reach.** The operator's own surface reaches every Artifacts node on the
  canvas. Seats are unchanged.
- **Motion law holds.** The surface opens with the modal motion Cmd+K uses.

## Steps

| Step | Who | What | Review |
|---|---|---|---|
| Q1 | product-modals | the surface: Cmd+T and its button beside the feed button (with product-shell), the two halves, open and close, the editor focused on open | product-keyboard, product-accessibility, product-typography |
| Q2 | product-documents | captures: a new document in the Inbox on the first keystroke, title from the first line, type switch with its conversions, Enter editing in place | product-feed |
| Q3 | product-keyboard | the key table entries, list and preview keys, M to route | product-accessibility |
| Q4 | product-settings | the Inbox setting and the one-time ask, "Make an Inbox" | product-modals |
| Q5 | product-documents | routing suggestions from links, mentions, labels and similar artifacts, on M1's move | tech-lead |
| Q6 | product-verify | walk, dark and bright: Cmd+T from a terminal, write three lines, close, find it in the Inbox, change it to a sheet and back, route it with a suggestion, search an old artifact and edit it in place | |
