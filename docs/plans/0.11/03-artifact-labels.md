# 0.11 Artifact labels

Owner: product-lead. Decided with the operator 2026-10-27. Part of 0.11.0.

## Target

An Artifacts node stays one flat list. Structure comes from two things only:
**labels** for grouping and **`[[ ]]` links** for the graph
(`02-artifact-links.md`). An artifact carries any number of labels, set in
its header or from the CLI, and the sidebar filters by them.

## Decisions (operator, 2026-10-27)

- **No folders and no page nesting.** A hub page is a document that links
  its children; their Linked from points back. One artifact sits in many
  hubs and many labels.
- **Labels, not tags.** `#` already mentions a task or an artifact, so
  labels are never typed in body text. They are set in the artifact header
  and from the CLI only.
- **Collapsing a group is filtering.** Whatever a subtree would give is an
  advanced filter over labels, not a tree.

## Contract

- `ArtifactLabel`: lowercase, 1 to 40 characters of `a-z 0-9 - _ /` and
  space, no leading or trailing `/` or space, no `//`. A `/` reads as a level
  (`project/junto/release`) for filtering only; nothing else treats it as a
  hierarchy. Case is folded on input.
- An artifact holds at most 20, unique, kept sorted.
- One new op beside `retitle` (`src/shared/artifact.ts:369`):
  `{ op: "labels", labels: ReadonlyArray<ArtifactLabel> }`, the whole set,
  so two writers resolve as every other artifact op does. `create` takes an
  optional `labels`. Labels are not versioned body: they never touch
  `baseVersion`.
- A fact `artifact.labelled` crosses machines like `artifact.retitled`
  (`src/main/junto/work/artifact-repository.ts:370`). Expand-only schema
  step for the labels column or table, numbered when it lands.
- The word is "Labels" in the UI. In code, `ArtifactLabel` and `labels`,
  never bare `Label` (that is the canvas label kind).

## UI

- Header: the labels as small chips after the title, an add control that
  completes from labels already used in this Artifacts node, remove per
  chip, keyboard and screen reader as the mention list.
- Sidebar filter: pick one or more labels; an artifact shows when it has all
  of them (AND). Picking `project/junto` also matches `project/junto/...`.
  The filter row shows each label with its count. The picked labels and
  the type filter are kept per node in `junto.db` and survive a restart
  (`04-view-state.md`).
- Cmd+P ranks labels after the title, as metadata.

## CLI

`junto artifact create ... --label <l>` (repeatable), `junto artifact label
<id> --set <l>,<l>` (the whole set) and `--add` / `--remove`, `junto artifact
list --label <l>` (repeatable, AND, prefix as the sidebar), and `show` lists
labels.

## Tracks

| Track | Owner | Reviewer |
|---|---|---|
| T1 contract: `ArtifactLabel`, the op, the fact, the step, the repository | product-shell | product-feed, remote-lead (crossing) |
| T2 header chips and the sidebar filter | product-sheet | product-shell, product-typography, product-accessibility |
| T3 Cmd+P ranks labels | product-modals | product-keyboard |
| T4 CLI | cli-lead | cli-protocol |
| Verify in the real app, dark and bright | product-verify | |

## Colours (operator, 2026-10-28)

The operator asked for labels to be colour coded, with a few colours to pick
from. This replaces "label colours" in Out of scope.

- **A colour belongs to the label in its Artifacts node**, not to one
  artifact: `planning` is the same colour on every artifact that carries it
  in that node. A label with no colour set draws as it does today.
  `project/junto` and `project/junto/release` are separate labels with
  separate colours; nothing inherits.
- **Eight named colours**, `ArtifactLabelColour`: `red`, `orange`,
  `yellow`, `green`, `teal`, `blue`, `purple`, `pink`, plus unset. Names
  are stored, never hex: product-typography maps each name to house tokens,
  legible in dark and bright, and the label's text always stays (colour is
  never the only signal).
- **Contract.** An op `{ op: "labelColour", label, colour | null }` on the
  Artifacts node, a fact `artifact.label.coloured` crossing machines like
  `artifact.labelled`, a typed table for (node, label, colour), expand-only
  step. A colour may be set for a label no artifact carries yet; it stays
  when the last artifact drops the label, so the label comes back the same.
- **UI.** A chip in the header and a label in the sidebar filter row draw in
  their colour. The colour is set from a small swatch menu on the label (in
  the header chip's menu and on the sidebar row), keyboard and screen reader
  as the label picker; the menu names each colour in words.
- **CLI.** Setting a label's colour in a node, and `list` / `show` naming
  colours, in the shape cli-lead picks for the verbs that exist.

| Track | Owner | Reviewer |
|---|---|---|
| C1 contract: `ArtifactLabelColour`, the op, the fact, the table and step | product-shell | product-feed, remote-lead (crossing) |
| C2 colour in chips and the sidebar, the swatch menu | product-sheet | product-typography, product-accessibility |
| C3 the eight colours as tokens, dark and bright | product-typography | product-accessibility (contrast) |
| C4 CLI | cli-lead | cli-protocol |
| Verify, a colour step in `artifact-labels-verify.spec.ts` | product-verify | |

Out of scope: renaming a label across artifacts, labels on tasks or Files.
