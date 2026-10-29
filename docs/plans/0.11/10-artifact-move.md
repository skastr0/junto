# 0.11.1 Move an artifact to another Artifacts node

Owner: product-lead. Asked for by the operator on 2026-10-29, for 0.11.1.
Quick capture (`11-quick-capture.md`) routes its drafts with it.

## Target

The operator moves one or more artifacts from one Artifacts node to another
on the canvas, from the node's window or with an overseer command. The
artifact keeps who it is: its id, versions, history, comments, labels,
tasks, and every link to it and from it. Only its node changes.

## Decisions

- **A move changes the node, nothing else.** History gets one entry: "moved
  from Specs to Release by the operator" (or by the overseer seat).
- **A link finds its artifact by id.** A link is stored as
  `junto://canvas/<c>?node=<node>&item=<artifact>` (`artifact-links.ts:43`).
  The artifact id resolves it, and the node is only a hint, so links in
  bodies, comments, mail, briefings and region instructions all hold after a
  move with nothing rewritten. Reach and the chip's title come from the
  artifact's current node, never the hint. A link whose id resolves nowhere
  stays missing. New links write the current node. (product-documents found
  this, 2026-10-29.)
- **Where.**
  - In the window, "Move to…" sits in the artifact's header and on a sidebar
    row's menu. With several rows selected, it moves them all.
  - The picker lists the canvas's Artifacts nodes by name and region, with
    the current node left out.
  - There is a key: M on a focused sidebar row opens the picker.
- **Reach changes are said, not hidden.** When the target sits in another
  region, the picker's confirm line names it: "Seats in Product will no
  longer reach this; seats in Release will." No dialog beyond that line.
- **Automations.** A watch on the old node stops seeing the artifact, and a
  watch on the new node sees it from then on. A move is not an edit and
  fires nothing in 0.11.1.
- **Archived artifacts** move too and stay archived.
- **Label colours belong to the node.** A moved artifact keeps its labels
  and shows them in the new node's colours, or plain where that node has
  none.
- **Sync.** A move is ruled where the canvas is ruled and reaches other
  machines as a rename does.
- **CLI.** `junto overseer artifact move {artifactIds, to}` takes one to
  100 ids. It answers one row per artifact, `moved` or refused with a
  reason, like `agent offboard`. Ordinary seats get no move.

## Steps

| Step | Who | What | Review |
|---|---|---|---|
| M1 | product-documents | contract and runtime in main: the move ruling, history entry, sync, automations watch by node at fire time; tests that links, backlinks, labels, comments and tasks survive | tech-lead, product-feed |
| M2 | product-sheet | window: "Move to…" in the header and the row menu, several rows, M key, the reach line | product-modals, product-accessibility, product-typography, product-keyboard |
| M3 | cli-lead | `overseer artifact move`, schema, examples, skill text | cli-protocol |
| M4 | product-verify | walk, dark and bright: move a document with a backlink and a label across regions; the link chip, backlink, label and history all hold, and a seat in the old region no longer lists it | |
