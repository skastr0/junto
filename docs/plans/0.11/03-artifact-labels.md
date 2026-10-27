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
  The filter row shows each label with its count. Kept per node in the
  window, like the type filter.
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

Out of scope: label colours, renaming a label across artifacts, labels on
tasks or Files.
