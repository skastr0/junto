# 05 Artifacts

Proposed owner: product. Reviewers: canvas, cli, remote.

## Target

One Artifacts node: a sidebar list of artifacts and a main pane that edits
the selected one with an editor for its type. Artifacts live long, change
over time, keep their versions, and carry comment threads anchored to a
place inside them. Pad and sheet become artifact types. Seats in reach read,
create and edit artifacts from the CLI; the operator edits in the app.

## Today

- Artifacts: immutable published records `{artifactId, name, parts, task?}`
  (`src/shared/work-model.ts:455-462`), one row each in `work_artifacts`
  (`src/main/junto/work/state-schema.ts:360-440`). Publish once, archive,
  operator delete. No edit, no versions, no comments. CLI has only
  `artifact publish` (`src/cli/commands/work.ts:408-437`).
- Pad: spatial page of images, shapes, edges, ink and pins; `applyPatch` is
  the only mutation (`src/shared/pad.ts`, `docs/pad.md`). Pins are positional
  comment sites with mentions (`pad.ts:112-132`). About 3.5k renderer lines.
- Sheet: text-only grid, operator writes, agents read (`src/shared/sheet.ts`,
  `src/main/junto/model/records.ts:297-311`). Lives on the model plane, not the
  work plane.
- All three are compiled out of ship.

## Contract

```ts
// src/shared/artifact.ts (replaces the artifact part of work-model.ts)
type ArtifactType = "link" | "document" | "pad" | "sheet" | "file";

type Artifact = {
  readonly artifactId: string;
  readonly nodeId: NodeId;
  readonly type: ArtifactType;
  readonly title: string;
  readonly version: number;         // head
  readonly createdBy: Actor;
  readonly updatedAt: number;
  readonly archived: boolean;
};

type ArtifactBody =
  | { readonly type: "link"; readonly url: string } | { readonly type: "link"; readonly content: ContentRef }
  | { readonly type: "document"; readonly markdown: string }
  | { readonly type: "pad"; readonly pad: Pad }                // today's pad model
  | { readonly type: "sheet"; readonly grid: SheetGrid }
  | { readonly type: "file"; readonly content: ContentRef };

type ArtifactEdit =
  | { readonly kind: "replace"; readonly baseVersion: number; readonly body: ArtifactBody }
  | { readonly kind: "patch"; readonly baseVersion: number; readonly patch: PadPatch | SheetPatch | TextPatch };
```

- **Link** is the foundation: a pointer to a URL or a file, with a title and
  threads. Every other type adds a body and an editor.
- **Versions.** Every applied edit is a new immutable version; the head
  moves. Edits name `baseVersion`; a stale base is refused `stale` with the
  head version (02). Pad and sheet use patches so concurrent edits to
  different parts can both apply when the editing machine rebases them;
  document and file replace whole.
- **Comments** are threads with an artifact subject and an anchor (03):
  `whole` for any type, `box` for pads and file images, `cells` for sheet,
  `text` for document. Pad pins and posts move here.
- **Associations.** An artifact can name tasks; a task can name artifacts as
  evidence (existing `completionEvidence`). Both render as chips.
- Universal (02): artifact facts replicate; bytes move on demand.

## CLI (`junto artifact`, seats need no edge)

`list`, `show <id> [--version n]` (text projection per type: markdown,
pad digest from `pad-project.ts`, sheet as table), `create --type`,
`edit` (replace or patch with `--base`), `comment [--anchor]`, `archive`,
`history`.

## UI

Node card: count and the latest changes. Detail: sidebar list (filter by
type, search), main pane editor: markdown editor for documents, the pad
editor for pads, the sheet grid for sheets, a preview for links and files.
Comments in a side rail; selecting a place in the editor starts an anchored
thread with `MentionCombobox`.

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | Pad domain (`pad.ts`, `pad-geom.ts`, `pad-project.ts`) and editor, sheet grid and editor, `ArtifactMarkdown`, content refs |
| Reshaped | `artifacts` node becomes the one node; pad and sheet become bodies; sheet moves to the work plane; agents may edit sheets |
| Deleted | `pad` and `sheet` node kinds, their tables, verbs `reads`, `edits`, `publishes`; pad pins and posts store; `BoardAuthor` dependency (09); `artifact publish` |
| New | `artifact.ts`, version table, `ArtifactEdit`, CLI group, sidebar layout |

## Questions

- **canvas**: Existing pad and sheet nodes on canvases: delete them in the
  migration (proposal, the kinds never shipped) or convert each into an
  artifacts node holding one artifact? (Operator decision 4.)
- **remote**: Pad bodies with images can be large. Version rows with full
  bodies, or patches with periodic snapshots?
- ~~**cli**: projections~~ Answered: pads reuse `padToDigest`
  (`src/shared/pad-project.ts:300`) as is; sheets need a new markdown table
  projection.
