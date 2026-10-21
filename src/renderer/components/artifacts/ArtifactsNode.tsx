import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, History, Plus, Search } from "lucide-react";
import {
  ARTIFACT_TYPES,
  emptyBody,
  type ArtifactBody,
  type ArtifactEdit,
  type ArtifactOp,
  type ArtifactType,
  type ArtifactVersion,
  padOf,
} from "@shared/artifact";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { NodeId } from "@shared/physics/schema";
import { type ItemId, mintItemId } from "@shared/resource-command";
import { textAnchorOf, type Anchor } from "@shared/thread-subject";
import { titleOf } from "@shared/model/title";
import { nodeAt } from "../../lib/use-model";
import {
  applyArtifactOp,
  type ArtifactRuling,
  artifactsSource,
  refusalLine,
  useHeadBody,
  useNodePendingWrites,
  type ArtifactPendingWrite,
  useArtifactHistory,
  useArtifactThreads,
  useNodeArtifacts,
} from "../../lib/artifacts-source";
import { FocusSurface } from "../FocusSurface";
import { Button, IconButton, Input, ListRow, PaneEmpty, PaneHeader, ResourceGlyphMark, TwoPane } from "../ui";
import { ArtifactComments } from "./ArtifactComments";
import { ArtifactHistory } from "./ArtifactHistory";
import { ArtifactTasks } from "./ArtifactTasks";
import { ArtifactPendingWrites } from "./ArtifactPendingWrites";
import { useCanvasTasks } from "../../lib/tasks-source";
import { openWorkDetail } from "../../lib/work-detail-open";
import { ArtifactPadEditor } from "./ArtifactPadEditor";
import { FilePreview, LinkPreview } from "./ArtifactPreview";
import { ArtifactSheetEditor } from "./ArtifactSheetEditor";
import { ageLabel, isLinkUrl, pendingWriteLine, TYPE_NOUN, type TypeFilter, visibleArtifacts } from "./artifacts-pane-model";
import { DocumentEditor } from "./DocumentEditor";
import "./artifacts.css";
import { claimFocusOnMount, releaseFocus } from "../../lib/focus-ownership";

/** Ages in the list move on without a write; a minute is fine enough. */
const CLOCK_MS = 60_000;

/** Types the operator makes from nothing here. A file arrives by drop or from the CLI. */
const CREATABLE: ReadonlyArray<Exclude<ArtifactType, "file">> = ["document", "sheet", "pad", "link"];

/**
 * The Artifacts node (05): the node's artifacts in a sidebar, the selected
 * one in the main pane with the editor for its type, and its comment
 * threads in the rail. Every write is one artifact op, ruled as the editing
 * machine rules it; a refusal is said in place and the work is kept.
 */
export function ArtifactsNode({
  canvasName,
  nodeId,
  initialArtifactId,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  readonly initialArtifactId?: string;
  readonly onClose: () => void;
}) {
  const entries = useNodeArtifacts(canvasName, nodeId);
  const pending = useNodePendingWrites(canvasName, nodeId);
  /** Creates still queued: the artifact has no head here yet. */
  const pendingCreates = pending.filter(
    (write) => write.op.op === "create" && !entries.some((entry) => entry.artifact.artifactId === write.artifactId),
  );
  const [selectedId, setSelectedId] = useState<string | null>(initialArtifactId ?? null);
  const [type, setType] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState<"menu" | "link" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A write is queued until the editing machine rules it; the next listing says it has. */
  const [queued, setQueued] = useState(false);
  useEffect(() => setQueued(false), [entries]);
  const now = useClock();

  const visible = useMemo(
    () => visibleArtifacts(entries, { type, query, archived }),
    [entries, type, query, archived],
  );
  const selected = entries.find((entry) => entry.artifact.artifactId === selectedId) ?? visible[0] ?? null;
  const archivedCount = entries.filter((entry) => entry.artifact.archived).length;

  /** Rule one op. An edit's refusal is the editor's to show; any other op's shows on the node. */
  const apply = async (itemId: ItemId, op: ArtifactOp): Promise<ArtifactRuling> => {
    const ruling = await applyArtifactOp(canvasName, nodeId, itemId, op);
    if (op.op !== "edit") setError(refusalLine(ruling));
    if (ruling.kind === "queued") setQueued(true);
    return ruling;
  };

  const create = async (title: string, body: ArtifactBody): Promise<void> => {
    const itemId = mintItemId();
    const ruling = await apply(itemId, { op: "create", title, body });
    if (ruling.kind === "applied") {
      setSelectedId(itemId);
      setArchived(false);
      setCreating(null);
    }
  };

  const sidebar = (
    <>
      <PaneHeader
        eyebrow={`Artifacts, ${entries.length - archivedCount}`}
        actions={
          <IconButton
            aria-label="New artifact"
            title="New artifact"
            size="sm"
            aria-expanded={creating !== null}
            onClick={() => setCreating(creating === null ? "menu" : null)}
          >
            <Plus size={14} />
          </IconButton>
        }
      />
      {creating === "menu" ? (
        <div className="artifacts-new" role="group" aria-label="New artifact">
          {CREATABLE.map((kind) => (
            <ListRow
              key={kind}
              leading={<ResourceGlyphMark kind="artifact" artifactType={kind} size={12} />}
              title={TYPE_NOUN[kind]}
              onClick={() =>
                kind === "link" ? setCreating("link") : void create(`Untitled ${TYPE_NOUN[kind].toLowerCase()}`, emptyBody(kind))
              }
            />
          ))}
        </div>
      ) : null}
      {creating === "link" ? (
        <NewLinkForm onCancel={() => setCreating(null)} onCreate={(title, url) => void create(title, { type: "link", target: { kind: "url", url } })} />
      ) : null}
      <div className="artifacts-filter">
        <label className="artifacts-filter__search">
          <Search size={12} aria-hidden />
          <Input dense aria-label="Search artifacts" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="artifacts-filter__types" role="radiogroup" aria-label="Type">
          {(["all", ...ARTIFACT_TYPES] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={type === option}
              className="artifacts-filter__type"
              onClick={() => setType(option)}
            >
              {option === "all" ? "All" : TYPE_NOUN[option]}
            </button>
          ))}
        </div>
      </div>
      <div className="artifacts-list" role="list" aria-label="Artifacts">
        {archived
          ? null
          : pendingCreates.map((write) => (
              <ListRow
                key={write.opId}
                leading={write.op.op === "create" ? <ResourceGlyphMark kind="artifact" artifactType={write.op.body.type} size={12} /> : null}
                title={write.op.op === "create" ? write.op.title : write.artifactId}
                meta={pendingWriteLine(write).tone === "risk" ? "At risk" : undefined}
                pending
              />
            ))}
        {visible.map(({ artifact }) => (
          <ListRow
            key={artifact.artifactId}
            leading={<ResourceGlyphMark kind="artifact" artifactType={artifact.type} size={12} />}
            title={artifact.title}
            meta={ageLabel(artifact.updatedAt, now)}
            selected={artifact.artifactId === selected?.artifact.artifactId}
            pending={pending.some((write) => write.artifactId === artifact.artifactId)}
            onClick={() => {
              setSelectedId(artifact.artifactId);
              setError(null);
            }}
          />
        ))}
        {visible.length === 0 && entries.length > 0 ? <p className="artifacts-list__none">No artifact matches.</p> : null}
      </div>
      {archivedCount > 0 || archived ? (
        <Button size="xs" variant="subtle" className="artifacts-archived-toggle" aria-pressed={archived} onClick={() => setArchived(!archived)}>
          {archived ? "Back to live artifacts" : `Archived ${archivedCount}`}
        </Button>
      ) : null}
    </>
  );

  return (
    <FocusSurface measure="workspace" height="immersive" label="Artifacts" onClose={onClose}>
      {selected === null ? (
        <TwoPane sidebar={sidebar} sidebarLabel="Artifacts" mainLabel="Artifact">
          <PaneEmpty
            glyph={<ResourceGlyphMark kind="artifact" artifactType="document" size={20} />}
            title={entries.length === 0 ? "No artifacts yet" : "Pick an artifact"}
            hint={entries.length === 0 ? "A document, sheet, pad or link that lives here and keeps its versions." : undefined}
            action={
              entries.length === 0 ? (
                <Button size="sm" variant="primary" onClick={() => void create("Untitled document", emptyBody("document"))}>
                  New document
                </Button>
              ) : undefined
            }
          />
        </TwoPane>
      ) : (
        <SelectedArtifact
          key={selected.artifact.artifactId}
          canvasName={canvasName}
          entry={selected}
          sidebar={sidebar}
          now={now}
          error={error}
          queued={queued}
          pending={pending.filter((write) => write.artifactId === selected.artifact.artifactId)}
          apply={(op) => apply(selected.artifact.artifactId, op)}
          onClose={onClose}
        />
      )}
    </FocusSurface>
  );
}

function SelectedArtifact({
  canvasName,
  entry,
  sidebar,
  now,
  error,
  queued,
  pending,
  apply,
  onClose,
}: {
  readonly onClose: () => void;
  readonly canvasName: string;
  readonly entry: ArtifactHead;
  readonly queued: boolean;
  readonly pending: ReadonlyArray<ArtifactPendingWrite>;
  readonly sidebar: React.ReactNode;
  readonly now: number;
  readonly error: string | null;
  readonly apply: (op: ArtifactOp) => Promise<ArtifactRuling>;
}) {
  const { artifact } = entry;
  const body = useHeadBody(canvasName, entry);
  const [mode, setMode] = useState<"edit" | "history">("edit");
  const [draftAnchor, setDraftAnchor] = useState<Anchor | undefined>(undefined);
  const [title, setTitle] = useState(artifact.title);
  const history = useArtifactHistory(canvasName, mode === "history" ? artifact.artifactId : null);
  const threads = useArtifactThreads(canvasName, artifact.artifactId);
  const tasks = useCanvasTasks(canvasName);
  const readOnly = artifact.archived;

  useEffect(() => setTitle(artifact.title), [artifact.title]);

  /**
   * The head an edit is written against, read when the write starts, not
   * when it was queued: a landed edit moves it before the next queued write
   * runs, even ahead of the re-render.
   */
  const headRef = useRef(artifact.version);
  if (artifact.version > headRef.current) headRef.current = artifact.version;
  const edit = async (make: (base: ArtifactVersion) => ArtifactEdit): Promise<string | null> => {
    const ruling = await apply({ op: "edit", edit: make(headRef.current) });
    if (ruling.kind === "applied") {
      for (const fact of ruling.facts) {
        if (fact.fact === "artifact.edited" && fact.version > headRef.current) headRef.current = fact.version;
      }
    }
    return refusalLine(ruling);
  };
  const comment = (text: string, anchor: Anchor | undefined, threadId?: string): void => {
    void artifactsSource().comment(canvasName, artifact.artifactId, {
      text,
      version: artifact.version,
      ...(anchor === undefined ? {} : { anchor }),
      ...(threadId === undefined ? {} : { threadId }),
    });
    setDraftAnchor(undefined);
  };

  const retitle = (): void => {
    const next = title.trim();
    if (next.length === 0 || next === artifact.title) {
      setTitle(artifact.title);
      return;
    }
    void apply({ op: "retitle", title: next });
  };

  const base = artifact.version as ArtifactVersion;
  const editor = (() => {
    if (body === null) return <PaneEmpty title="Loading this version" hint="Its body is on its way from the editing machine." />;
    switch (body.type) {
      case "document":
        return (
          <DocumentEditor
            body={body}
            version={base}
            readOnly={readOnly}
            onPatch={(baseVersion, patches) => edit(() => ({ kind: "patch", type: "document", baseVersion, patches: [...patches] }))}
            onCommentText={(quote, offset) => setDraftAnchor(textAnchorOf(quote, offset))}
          />
        );
      case "sheet":
        return (
          <ArtifactSheetEditor
            grid={body.grid}
            readOnly={readOnly}
            onPatch={(patches) => edit((baseVersion) => ({ kind: "patch", type: "sheet", baseVersion, patches: [...patches] }))}
            onCommentCells={(range) => setDraftAnchor({ kind: "cells", range })}
          />
        );
      case "pad":
        return (
          <ArtifactPadEditor
            pad={padOf(body)}
            readOnly={readOnly}
            onPatch={(patches) => edit((baseVersion) => ({ kind: "patch", type: "pad", baseVersion, patches: [...patches] }))}
            onCommentBox={(box) => setDraftAnchor({ kind: "box", ...box })}
          />
        );
      case "link":
        return <LinkPreview body={body} />;
      case "file":
        return <FilePreview body={body} />;
    }
  })();

  const rail = (
    <ArtifactComments
      threads={threads}
      seatName={(id) => {
        const node = nodeAt(canvasName, id);
        return node === undefined ? undefined : titleOf(node);
      }}
      draftAnchor={draftAnchor}
      now={now}
      onStart={(text, anchor) => comment(text, anchor)}
      onReply={(threadId, text) => comment(text, undefined, threadId)}
      onResolve={(threadId, resolved) => void artifactsSource().resolve(canvasName, threadId, resolved)}
      onClearAnchor={() => setDraftAnchor(undefined)}
    />
  );

  return (
    <TwoPane sidebar={sidebar} sidebarLabel="Artifacts" mainLabel={artifact.title} rail={rail} railLabel="Comments">
      <header className="artifact-head">
        <ResourceGlyphMark kind="artifact" artifactType={artifact.type} size={14} />
        <input
          className="artifact-head__title"
          aria-label="Title"
          value={title}
          readOnly={readOnly}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={retitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") releaseFocus(event.currentTarget, "gesture");
            if (event.key === "Escape") setTitle(artifact.title);
          }}
        />
        <span className="artifact-head__meta">
          {TYPE_NOUN[artifact.type]}, version {artifact.version}
        </span>
        <IconButton
          aria-label={mode === "history" ? "Back to editing" : "History"}
          title={mode === "history" ? "Back to editing" : "History"}
          size="sm"
          aria-pressed={mode === "history"}
          onClick={() => setMode(mode === "history" ? "edit" : "history")}
        >
          <History size={14} />
        </IconButton>
        <IconButton
          aria-label={artifact.archived ? "Restore" : "Archive"}
          title={artifact.archived ? "Restore" : "Archive"}
          size="sm"
          onClick={() => void apply({ op: artifact.archived ? "restore" : "archive" })}
        >
          {artifact.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </IconButton>
      </header>
      {artifact.taskIds.length > 0 || !readOnly ? (
        <ArtifactTasks
          taskIds={artifact.taskIds}
          tasks={tasks}
          readOnly={readOnly}
          onChange={(taskIds) => void apply({ op: "tasks", taskIds: [...taskIds] })}
          onOpen={(task) => {
            onClose();
            openWorkDetail(task.current.node, { itemId: task.taskId });
          }}
        />
      ) : null}
      {error ? (
        <p className="artifact-error" role="alert">
          {error}
        </p>
      ) : null}
      <ArtifactPendingWrites writes={pending} />
      {queued && pending.length === 0 ? (
        <p className="artifact-archived" role="status">
          Queued. It applies when the editing machine rules it.
        </p>
      ) : null}
      {artifact.archived ? <p className="artifact-archived">Archived. Restore it to change it.</p> : null}
      <div className="artifact-main">
        {mode === "history" ? (
          <ArtifactHistory
            versions={history}
            head={artifact.version}
            now={now}
            onClose={() => setMode("edit")}
            onRestore={(record) => {
              void edit((baseVersion) => ({ kind: "replace", baseVersion, body: record.body })).then((refused) => {
                if (refused === null) setMode("edit");
              });
            }}
          />
        ) : (
          editor
        )}
      </div>
    </TwoPane>
  );
}

function NewLinkForm({
  onCreate,
  onCancel,
}: {
  readonly onCreate: (title: string, url: string) => void;
  readonly onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const valid = isLinkUrl(url);
  const submit = (): void => {
    if (!valid) return;
    const trimmed = url.trim();
    onCreate(title.trim() || new URL(trimmed).host, trimmed);
  };
  return (
    <form
      className="artifacts-link-form"
      aria-label="New link"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input dense ref={claimFocusOnMount} aria-label="URL" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} />
      <Input dense aria-label="Title" placeholder="Title (optional)" value={title} onChange={(event) => setTitle(event.target.value)} />
      <div className="artifacts-link-form__actions">
        <Button size="xs" variant="subtle" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" type="submit" disabled={!valid}>
          Add link
        </Button>
      </div>
    </form>
  );
}

const useClock = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
};
