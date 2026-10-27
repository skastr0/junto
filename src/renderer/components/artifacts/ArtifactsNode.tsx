import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
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
import { textAnchorOf, type Anchor, type TextAnchor } from "@shared/thread-subject";
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
  useNodeArtifacts,
} from "../../lib/artifacts-source";
import { FocusSurface } from "../FocusSurface";
import { Button, IconButton, Input, ListRow, PaneEmpty, PaneHeader, ResourceGlyphMark, TwoPane } from "../ui";
import { ArtifactComments, ArtifactCommentsEdge } from "./ArtifactComments";
import { ArtifactHistory } from "./ArtifactHistory";
import { ArtifactKeys } from "./ArtifactKeys";
import { ArtifactTasks } from "./ArtifactTasks";
import { ArtifactPendingWrites } from "./ArtifactPendingWrites";
import { useCanvasTasks } from "../../lib/tasks-source";
import { openWorkDetail } from "../../lib/work-detail-open";
import { useResourcesInReach, useSeatsInReach } from "../../lib/mention-sources";
import { MentionedIn } from "../threads/MentionedIn";
import { newPostOpId, subjectThreadsSource, useSubjectThreads } from "../../lib/subject-threads-source";
import { openMention } from "../tasks/TaskThread";
import { ArtifactPadEditor } from "./ArtifactPadEditor";
import { FilePreview, LinkPreview } from "./ArtifactPreview";
import { ArtifactSheetEditor } from "./ArtifactSheetEditor";
import {
  ageLabel,
  isLinkUrl,
  pendingWriteLine,
  postAfterSave,
  TYPE_NOUN,
  type TypeFilter,
  visibleArtifacts,
} from "./artifacts-pane-model";
import { DocumentEditor, type DocumentMentions } from "./DocumentEditor";
import "./artifacts.css";
import { claimFocus, claimFocusOnMount, releaseFocus } from "../../lib/focus-ownership";
import { commentsRailOpen, commentsRailRef, setCommentsRailOpen } from "../../lib/artifact-comments-rail";
import { sidebarSections$ } from "../../lib/sidebar-sections";
import { paneEntryOf } from "../../lib/pane-focus";

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

  /**
   * The list's keys: Up and Down move the pick and the keyboard with it,
   * Enter opens the picked artifact and puts the keyboard in its content.
   */
  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // The row with the keyboard, else the picked one. Rows still being created are not buttons.
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(":scope > button")];
    const focused = rows.findIndex((row) => row.contains(event.target as Node));
    const at = focused >= 0 ? focused : visible.findIndex(({ artifact }) => artifact.artifactId === selected?.artifact.artifactId);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = visible[Math.min(visible.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next === undefined) return;
      event.preventDefault();
      setSelectedId(next.artifact.artifactId);
      setError(null);
      const list = event.currentTarget;
      requestAnimationFrame(() => claimFocus(list.querySelector<HTMLElement>("[data-selected='true']"), "gesture"));
      return;
    }
    if (event.key === "Enter" && visible[at] !== undefined) {
      event.preventDefault();
      setSelectedId(visible[at].artifact.artifactId);
      setError(null);
      const main = event.currentTarget.closest(".two-pane")?.querySelector<HTMLElement>(":scope > .two-pane__main");
      requestAnimationFrame(() => claimFocus(main ? paneEntryOf(main) : null, "gesture"));
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
      <div className="artifacts-list" role="list" aria-label="Artifacts" onKeyDown={onListKey}>
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
        <TwoPane sidebar={sidebar} sidebarLabel="Artifacts" sidebarWidth="narrow" mainLabel="Artifact">
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
  const subject = useMemo(
    () => ({ kind: "artifact" as const, nodeId: artifact.nodeId, artifactId: artifact.artifactId }),
    [artifact.nodeId, artifact.artifactId],
  );
  const threads = useSubjectThreads(canvasName, subject);
  const mentionable = useSeatsInReach(canvasName, artifact.nodeId);
  const tasks = useCanvasTasks(canvasName);
  const readOnly = artifact.archived;
  const siblings = useNodeArtifacts(canvasName, artifact.nodeId);
  // What a document may mention: seats in reach, and the tasks and this node's other artifacts on @ and #.
  const tasksOf = useMemo(
    () => (nodeId: NodeId) =>
      tasks
        .filter((view) => view.current.node === nodeId)
        .map((view) => ({ id: view.taskId, title: view.title, ...(view.number === undefined ? {} : { number: view.number }) })),
    [tasks],
  );
  const artifactsOf = useMemo(
    () => (nodeId: NodeId) =>
      nodeId !== artifact.nodeId
        ? []
        : siblings
            .filter((sibling) => !sibling.artifact.archived && sibling.artifact.artifactId !== artifact.artifactId)
            .map((sibling) => ({ id: sibling.artifact.artifactId, title: sibling.artifact.title })),
    [siblings, artifact.nodeId, artifact.artifactId],
  );
  const resources = useResourcesInReach(canvasName, artifact.nodeId, { tasksOf, artifactsOf });
  const documentMentions = useMemo<DocumentMentions>(
    () => ({ canvasName, candidates: [...mentionable, ...resources], nodeKindOf: (id) => nodeAt(canvasName, id)?.kind }),
    [canvasName, mentionable, resources],
  );

  useEffect(() => setTitle(artifact.title), [artifact.title]);

  /** The rail: an edge by default, open or closed as one choice for every artifact. */
  const railOpen = commentsRailOpen(use$(sidebarSections$.open));
  const [reveal, setReveal] = useState<{ readonly threadId: string; readonly nonce: number } | undefined>(undefined);
  const railElement = useRef<HTMLDivElement | null>(null);
  const railRef = useCallback((element: HTMLDivElement | null) => {
    railElement.current = element;
    return commentsRailRef(element);
  }, []);
  /** The toggle pressed was just hidden: the keyboard follows to the one showing now. */
  const railToggled = useRef(false);
  const toggleRail = (open: boolean): void => {
    railToggled.current = true;
    setCommentsRailOpen(open);
  };
  useEffect(() => {
    if (!railToggled.current) return;
    railToggled.current = false;
    claimFocus(railElement.current?.querySelector<HTMLElement>("[data-comments-toggle]"), "gesture", { preventScroll: true });
  }, [railOpen]);
  // A place picked to comment on needs the composer: the rail opens for it.
  useEffect(() => {
    if (draftAnchor !== undefined) setCommentsRailOpen(true);
  }, [draftAnchor]);
  /** A marker in the artifact was pressed: open the rail on its thread. */
  const revealThread = (threadId: string): void => {
    setCommentsRailOpen(true);
    setReveal((last) => ({ threadId, nonce: (last?.nonce ?? 0) + 1 }));
  };
  /** Text-anchored threads, marked in the document so they stay findable with the rail collapsed. */
  const textAnchors = useMemo(
    () =>
      threads.flatMap((thread) =>
        thread.anchor?.kind === "text" ? [{ threadId: thread.threadId, anchor: thread.anchor, count: thread.posts.length }] : [],
      ),
    [threads],
  );
  /** A thread's anchor pressed in the rail: the document brings its quote into view. */
  const [revealAnchor, setRevealAnchor] = useState<{ readonly anchor: TextAnchor; readonly nonce: number } | undefined>(undefined);
  const seatName = (id: string): string | undefined => {
    const node = nodeAt(canvasName, id);
    return node === undefined ? undefined : titleOf(node);
  };

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
  /** The document's save, run before a text-anchored comment posts. */
  const saveDocument = useRef<(() => Promise<string | null>) | null>(null);
  /** Post through the one comment path (03); the refusal in words, or null. */
  const comment = (text: string, anchor: Anchor | undefined, threadId?: string): Promise<string | null> =>
    postAfterSave(threadId === undefined ? anchor : undefined, saveDocument.current, async () => {
      const outcome = await subjectThreadsSource().post(canvasName, subject, {
        text,
        opId: newPostOpId(),
        ...(anchor === undefined ? {} : { anchor }),
        ...(threadId === undefined ? {} : { threadId }),
      });
      if (!outcome.ok) return outcome.message;
      if (threadId === undefined) setDraftAnchor(undefined);
      return null;
    });

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
            onCommentText={(quote, offset, save) => {
              saveDocument.current = save;
              setDraftAnchor(textAnchorOf(quote, offset));
            }}
            anchors={textAnchors}
            onAnchor={revealThread}
            revealAnchor={revealAnchor}
            mentions={documentMentions}
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

  const comments = (
    <ArtifactComments
      canvasName={canvasName}
      mentionable={mentionable}
      threads={threads}
      nodeKindOf={(id) => nodeAt(canvasName, id)?.kind}
      onOpenMention={(ref) => {
        onClose();
        openMention(ref);
      }}
      seatName={seatName}
      draftAnchor={draftAnchor}
      now={now}
      onStart={(text, anchor) => comment(text, anchor)}
      onReply={(threadId, text) => comment(text, undefined, threadId)}
      onClearAnchor={() => setDraftAnchor(undefined)}
      onCollapse={() => toggleRail(false)}
      reveal={reveal}
      onFocusAnchor={(anchor) => {
        if (anchor?.kind === "text") setRevealAnchor((last) => ({ anchor, nonce: (last?.nonce ?? 0) + 1 }));
      }}
    />
  );
  const rail = (
    <div className="artifact-rail" ref={railRef}>
      {railOpen ? (
        <>
          {comments}
          <MentionedIn
            canvasName={canvasName}
            target={{ kind: "artifact", nodeId: artifact.nodeId, artifactId: artifact.artifactId }}
            now={now}
            nameOf={(place) => (place.kind === "task" ? tasks.find((task) => task.taskId === place.taskId)?.title : undefined)}
            beforeOpen={onClose}
          />
        </>
      ) : (
        <ArtifactCommentsEdge threads={threads} seatName={seatName} onOpen={() => toggleRail(true)} />
      )}
    </div>
  );

  return (
    <TwoPane sidebar={sidebar} sidebarLabel="Artifacts" sidebarWidth="narrow" mainLabel={artifact.title} rail={rail} railLabel="Comments" railCollapsed={!railOpen}>
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
        <ArtifactKeys type={artifact.type} />
        <IconButton
          aria-label={mode === "history" ? "Back to editing" : "History"}
          title={mode === "history" ? "Back to editing" : "History"}
          size="sm"
          aria-pressed={mode === "history"}
          onClick={() => setMode(mode === "history" ? "edit" : "history")}
        >
          <History size={14} />
        </IconButton>
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
        <IconButton
          aria-label={artifact.archived ? "Restore" : "Archive"}
          title={artifact.archived ? "Restore" : "Archive"}
          size="sm"
          onClick={() => void apply({ op: artifact.archived ? "restore" : "archive" })}
        >
          {artifact.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </IconButton>
      </header>
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
