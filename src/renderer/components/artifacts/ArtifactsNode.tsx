import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, FolderInput, History, Plus, Search } from "lucide-react";
import {
  ARTIFACT_TYPES,
  emptyBody,
  type ArtifactBody,
  type ArtifactEdit,
  type ArtifactOp,
  type ArtifactType,
  type ArtifactVersion,
  type FileSource,
  padOf,
} from "@shared/artifact";
import type { ArtifactLabel } from "@shared/artifact-labels";
import type { MentionOf, MentionRef } from "@shared/mention";
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
  useArtifactMoves,
  useNodeArtifacts,
} from "../../lib/artifacts-source";
import { FocusSurface } from "../FocusSurface";
import { Button, IconButton, Input, ListRow, PaneEmpty, PaneHeader, ResourceGlyphMark, TwoPane } from "../ui";
import { ArtifactComments, ArtifactCommentsEdge } from "./ArtifactComments";
import { LinkedFromList, linkedFromCount, useLinkedFrom } from "./LinkedFrom";
import { ArtifactHistory } from "./ArtifactHistory";
import { ArtifactKeys } from "./ArtifactKeys";
import { ArtifactMoveDialog, ArtifactRowMenu, type MovingArtifact } from "./ArtifactMove";
import { moveEntryTitle, movedLine, moveSetOf, rangeOf } from "./artifact-move-model";
import { ArtifactLabelChips, ArtifactLabelFilter } from "./ArtifactLabelChips";
import { ArtifactTasks } from "./ArtifactTasks";
import { ArtifactPendingWrites } from "./ArtifactPendingWrites";
import { useCanvasTasks } from "../../lib/tasks-source";
import { openWorkDetail, useFollowOpen } from "../../lib/work-detail-open";
import { useResourcesInReach, useSeatsInReach } from "../../lib/mention-sources";
import { useArtifactsInReach } from "../../lib/artifacts-in-reach";
import { makePostOps } from "../../lib/post-op";
import { useArtifactsNodeView } from "../../lib/artifacts-node-view";
import { type LabelColours, useLabelColours } from "../../lib/artifact-label-colours";
import { subjectThreadsSource, useSubjectThreads } from "../../lib/subject-threads-source";
import { openMention } from "../tasks/TaskThread";
import { ArtifactPadEditor } from "./ArtifactPadEditor";
import { FilePreview, LinkPreview } from "./ArtifactPreview";
import { ArtifactSheetEditor, type SheetCellLinks } from "./ArtifactSheetEditor";
import {
  ageLabel,
  artifactQuickOpen,
  isLinkUrl,
  labelChoices,
  labelsInNode,
  pendingWriteLine,
  postAfterSave,
  TYPE_NOUN,
  visibleArtifacts,
} from "./artifacts-pane-model";
import type { DocumentMentions } from "./DocumentEditor";
import { DocumentEditor } from "./lazy-editors";
import "./artifacts.css";
import { claimFocus, claimFocusOnMount, releaseFocus } from "../../lib/focus-ownership";
import { commentsRailRef, setCommentsRailOpen, useCommentsRailOpen } from "../../lib/artifact-comments-rail";
import { paneEntryOf } from "../../lib/pane-focus";
import { LIST_ROW_ATTRIBUTE, useListNav } from "../../lib/list-nav";
import { keyIs } from "../../lib/key-match";
import { topModal } from "../../lib/modal-stack";
import { useQuickOpen } from "../quick-open/use-quick-open";

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
  openKey,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  readonly initialArtifactId?: string;
  /** Which open this is: a new one selects `initialArtifactId` again, though the operator moved on. */
  readonly openKey?: number;
  readonly onClose: () => void;
}) {
  const entries = useNodeArtifacts(canvasName, nodeId);
  const pending = useNodePendingWrites(canvasName, nodeId);
  /** Creates still queued: the artifact has no head here yet. */
  const pendingCreates = pending.filter(
    (write) => write.op.op === "create" && !entries.some((entry) => entry.artifact.artifactId === write.artifactId),
  );
  // The type, the picked labels, the archived toggle and the open artifact outlive the modal and a quit, per node.
  const { type, setType, labels, setLabels, archived, setArchived, open, setOpen } = useArtifactsNodeView(canvasName, nodeId, entries);
  const [selectedId, setSelected] = useState<string | null>(initialArtifactId ?? open);
  const setSelectedId = (id: string | null): void => {
    setSelected(id);
    setOpen(id);
  };
  // An open asked for while the modal is up, a link followed from inside it, picks that artifact,
  // the same one included after the operator picked another.
  useFollowOpen(initialArtifactId, openKey, setSelectedId);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<"menu" | "link" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A write is queued until the editing machine rules it; the next listing says it has. */
  const [queued, setQueued] = useState(false);
  useEffect(() => setQueued(false), [entries]);
  const now = useClock();

  const filter = useMemo(() => ({ type, query, archived, labels }), [type, query, archived, labels]);
  const visible = useMemo(() => visibleArtifacts(entries, filter), [entries, filter]);
  const choices = useMemo(() => labelChoices(entries, filter), [entries, filter]);
  const used = useMemo(() => labelsInNode(entries), [entries]);
  // A colour is one op on the node: its refusal or its queue is said as any other op's.
  const colours = useLabelColours(canvasName, nodeId, (outcome) => {
    setError(outcome.kind === "refused" ? outcome.error.message : null);
    if (outcome.kind === "queued") setQueued(true);
  });
  const selected = entries.find((entry) => entry.artifact.artifactId === selectedId) ?? visible[0] ?? null;
  const archivedCount = entries.filter((entry) => entry.artifact.archived).length;

  /**
   * More rows picked beside the open one, to move together (0.11.1, 10 M2):
   * Cmd or Ctrl and a press adds or drops one, Shift and a press or Shift and
   * an arrow picks the run from the open row. A plain pick clears them.
   */
  const [picks, setPicks] = useState<ReadonlySet<string>>(() => new Set());
  const order: ReadonlyArray<string> = visible.map(({ artifact }) => artifact.artifactId);
  const openId = selected?.artifact.artifactId ?? null;
  const selection = new Set(order.filter((id) => id === openId || picks.has(id)));
  /** The picker, open on these rows; and the row menu, at its row. */
  const [moving, setMoving] = useState<ReadonlyArray<MovingArtifact> | null>(null);
  const [rowMenu, setRowMenu] = useState<{ readonly row: string; readonly anchor: HTMLElement } | null>(null);
  /** What the last move did, said once its rows have gone from the list. */
  const [moved, setMoved] = useState<string | null>(null);
  /**
   * The keyboard after a move: on the first row left once the moved rows have
   * gone from the list, or, with every row gone, in the pane that says so. A
   * queued move's rows stay until it is ruled, so it lands past them at once.
   */
  const [landing, setLanding] = useState<{ readonly gone: ReadonlyArray<string>; readonly waits: boolean } | null>(null);
  useEffect(() => {
    if (landing === null) return;
    const listed = (id: string): boolean => entries.some((entry) => entry.artifact.artifactId === id);
    if (!landing.waits && landing.gone.some(listed)) return;
    setLanding(null);
    requestAnimationFrame(() => {
      const container = topModal()?.container();
      const first = [...(container?.querySelectorAll<HTMLElement>(`.artifacts-list [${LIST_ROW_ATTRIBUTE}]`) ?? [])].find(
        (row) => !landing.gone.includes(row.getAttribute(LIST_ROW_ATTRIBUTE) ?? ""),
      );
      const main = container?.querySelector<HTMLElement>(".two-pane > .two-pane__main");
      claimFocus(first ?? (main ? paneEntryOf(main) : null), "gesture");
    });
  }, [entries, landing]);
  const openMove = (row: string | null): void => {
    const ids = moveSetOf(order, selection, row);
    const rows = ids.flatMap((id) => entries.filter((entry) => entry.artifact.artifactId === id));
    if (rows.length > 0) setMoving(rows.map(({ artifact }) => ({ artifactId: artifact.artifactId, title: artifact.title })));
  };
  const pickRow = (id: string, how: { readonly add: boolean; readonly run: boolean }): void => {
    setMoved(null);
    if (how.run) {
      setPicks(new Set(rangeOf(order, openId, id)));
      return;
    }
    if (how.add && id !== openId) {
      setPicks((held) => {
        const next = new Set(held);
        if (!next.delete(id)) next.add(id);
        return next;
      });
      return;
    }
    setPicks(new Set());
    setSelectedId(id);
    setError(null);
  };
  /** A row's own keys: M moves, Shift and an arrow picks one more, Shift+F10 or Menu opens its menu. */
  const rowKeys = (event: React.KeyboardEvent<HTMLElement>): void => {
    const row = (event.target as Element).closest?.(`[${LIST_ROW_ATTRIBUTE}]`);
    const id = row?.getAttribute(LIST_ROW_ATTRIBUTE);
    if (row == null || id == null || !order.includes(id) || event.nativeEvent.isComposing) return;
    if (keyIs(event.nativeEvent, "inArtifacts.move")) {
      event.preventDefault();
      openMove(id);
    } else if (keyIs(event.nativeEvent, "inArtifacts.menu")) {
      event.preventDefault();
      setRowMenu({ row: id, anchor: row as HTMLElement });
    } else if (keyIs(event.nativeEvent, "inArtifacts.extend")) {
      const at = order.indexOf(id);
      const next = order[event.key === "ArrowUp" ? at - 1 : at + 1];
      // Claimed at the ends too: the list's own moves must not take it as a plain step and drop the picks.
      event.preventDefault();
      if (next === undefined) return;
      pickRow(next, { add: false, run: true });
      requestAnimationFrame(() => {
        const scope = topModal()?.container() ?? document.body;
        claimFocus(scope.querySelector<HTMLElement>(`[${LIST_ROW_ATTRIBUTE}="${CSS.escape(next)}"]`), "gesture", { preventScroll: false });
      });
    }
  };

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
   * A `[[` title that names nothing becomes an empty document in this node,
   * and the one being written stays open; a queued create links all the same.
   */
  const createLinked = async (title: string): Promise<MentionOf<"artifact"> | null> => {
    const itemId = mintItemId();
    const ruling = await apply(itemId, { op: "create", title, body: { type: "document", markdown: "" } });
    return ruling.kind === "applied" || ruling.kind === "queued" ? { kind: "artifact", nodeId, artifactId: itemId } : null;
  };

  /** The list's keys (lib/list-nav): a move picks the row, Enter opens it into the content. */
  const listNav = useListNav({
    ids: visible.map(({ artifact }) => artifact.artifactId),
    selected: selected?.artifact.artifactId ?? null,
    onSelect: (id) => pickRow(id, { add: false, run: false }),
    onOpen: (id) => {
      setPicks(new Set());
      setSelectedId(id);
      setError(null);
      // A new pick mounts a new pane: find its content once it shows.
      requestAnimationFrame(() => {
        const main = topModal()?.container()?.querySelector<HTMLElement>(".two-pane > .two-pane__main");
        claimFocus(main ? paneEntryOf(main) : null, "gesture");
      });
    },
  });

  /** A pick in the palette opens that artifact, wherever the list filter sat. */
  const quickOpen = useQuickOpen({
    nodeId,
    enabled: entries.length > 0,
    // The title names a row; the type and the labels help it be found.
    source: useMemo(() => artifactQuickOpen(entries), [entries]),
    onOpen: (item) => {
      setSelectedId(item.id);
      setError(null);
    },
  });

  const sidebar = (
    <>
      <PaneHeader
        eyebrow={
          // In the narrow sidebar the word gives way before the count does.
          <span className="artifacts-eyebrow">
            <span className="artifacts-eyebrow__word">Artifacts,</span>
            <span className="artifacts-eyebrow__count">{"\u00a0"}{entries.length - archivedCount}</span>
          </span>
        }
        actions={
          <>
            {quickOpen.trigger}
            <IconButton
              aria-label="New artifact"
              title="New artifact"
              size="sm"
              aria-expanded={creating !== null}
              onClick={() => setCreating(creating === null ? "menu" : null)}
            >
              <Plus size={14} />
            </IconButton>
          </>
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
        <ArtifactLabelFilter
          choices={choices}
          onToggle={(label) =>
            setLabels((picked) => (picked.includes(label) ? picked.filter((one) => one !== label) : [...picked, label].sort()))
          }
          onClear={() => setLabels(() => [])}
          colours={colours}
        />
      </div>
      {/* A list holds list items only: each row sits in one, and the empty line sits outside it, where the rows would be. */}
      {visible.length === 0 && entries.length > 0 ? <p className="artifacts-list__none">No artifact matches.</p> : null}
      <div
        className="artifacts-list"
        role="list"
        aria-label="Artifacts"
        onKeyDown={(event) => {
          rowKeys(event);
          listNav.onKeyDown(event);
        }}
      >
        {archived
          ? null
          : pendingCreates.map((write) => (
              <div role="listitem" key={write.opId}>
                <ListRow
                  leading={write.op.op === "create" ? <ResourceGlyphMark kind="artifact" artifactType={write.op.body.type} size={12} /> : null}
                  title={write.op.op === "create" ? write.op.title : write.artifactId}
                  meta={pendingWriteLine(write).tone === "risk" ? "At risk" : undefined}
                  pending
                />
              </div>
            ))}
        {visible.map(({ artifact }) => {
          // Picked with others to move together: marked, and said after the title.
          const picked = selection.size > 1 && selection.has(artifact.artifactId);
          return (
            <div role="listitem" key={artifact.artifactId} className="artifacts-list__item" data-picked={picked ? "true" : undefined}>
              <ListRow
                leading={<ResourceGlyphMark kind="artifact" artifactType={artifact.type} size={12} />}
                title={
                  <>
                    {artifact.title}
                    {picked ? <span className="sr-only">, picked</span> : null}
                  </>
                }
                meta={ageLabel(artifact.updatedAt, now)}
                selected={artifact.artifactId === selected?.artifact.artifactId}
                pending={pending.some((write) => write.artifactId === artifact.artifactId)}
                aria-haspopup="menu"
                aria-expanded={rowMenu?.row === artifact.artifactId}
                {...listNav.rowProps(artifact.artifactId)}
                onClick={(event) => pickRow(artifact.artifactId, { add: event.metaKey || event.ctrlKey, run: event.shiftKey })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setRowMenu({ row: artifact.artifactId, anchor: event.currentTarget });
                }}
              />
            </div>
          );
        })}
      </div>
      {/* Mounted empty, so the change that fills them is the one announced. */}
      <p className="artifacts-picked" role="status">
        {selection.size > 1 ? `${String(selection.size)} picked. M or Move to moves them together.` : ""}
      </p>
      <p className="artifacts-moved" role="status">
        {moved ?? ""}
      </p>
      {archivedCount > 0 || archived ? (
        <Button size="xs" variant="subtle" className="artifacts-archived-toggle" aria-pressed={archived} onClick={() => setArchived(!archived)}>
          {archived ? "Back to live artifacts" : `Archived ${archivedCount}`}
        </Button>
      ) : null}
    </>
  );

  return (
    <FocusSurface measure="workspace" height="immersive" label="Artifacts" onClose={onClose}>
      {quickOpen.palette}
      {rowMenu === null ? null : (
        <ArtifactRowMenu
          anchor={rowMenu.anchor}
          count={moveSetOf(order, selection, rowMenu.row).length}
          onMove={() => openMove(rowMenu.row)}
          onClose={(refocus) => {
            if (refocus && rowMenu.anchor.isConnected) claimFocus(rowMenu.anchor, "gesture");
            setRowMenu(null);
          }}
        />
      )}
      {moving === null ? null : (
        <ArtifactMoveDialog
          canvasName={canvasName}
          from={nodeId}
          artifacts={moving}
          onCancel={() => setMoving(null)}
          onDone={(done) => {
            setMoving(null);
            setPicks(new Set());
            setMoved(movedLine(done.titles, done.queued, done.to.title));
            setLanding({ gone: moving.map((one) => one.artifactId), waits: done.queued > 0 });
          }}
        />
      )}
      {selected === null ? (
        <TwoPane keptBy={{ canvas: canvasName, node: nodeId }} sidebar={sidebar} sidebarLabel="Artifacts" sidebarWidth="narrow" mainLabel="Artifact">
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
          nodeId={nodeId}
          entry={selected}
          sidebar={sidebar}
          now={now}
          error={error}
          queued={queued}
          pending={pending.filter((write) => write.artifactId === selected.artifact.artifactId)}
          usedLabels={used}
          labelColours={colours}
          apply={(op) => apply(selected.artifact.artifactId, op)}
          moveCount={moveSetOf(order, selection, null).length || 1}
          onMove={() => (order.includes(selected.artifact.artifactId) ? openMove(null) : openMove(selected.artifact.artifactId))}
          createLinked={createLinked}
          onClose={onClose}
        />
      )}
    </FocusSurface>
  );
}

function SelectedArtifact({
  canvasName,
  nodeId,
  entry,
  sidebar,
  now,
  error,
  queued,
  pending,
  usedLabels,
  labelColours,
  apply,
  moveCount,
  onMove,
  createLinked,
  onClose,
}: {
  readonly onClose: () => void;
  /** How many artifacts the header's Move to takes: this one, or every one picked with it. */
  readonly moveCount: number;
  readonly onMove: () => void;
  /** Make a document by a `[[` title in this node: its mention, or null when it was refused. */
  readonly createLinked: (title: string) => Promise<MentionOf<"artifact"> | null>;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly entry: ArtifactHead;
  readonly queued: boolean;
  readonly pending: ReadonlyArray<ArtifactPendingWrite>;
  /** Every label this node uses, for the header's add to complete from. */
  readonly usedLabels: ReadonlyArray<ArtifactLabel>;
  /** This node's label colours, drawn on the chips and set from their menu. */
  readonly labelColours: LabelColours;
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
  const moves = useArtifactMoves(canvasName, mode === "history" ? artifact.artifactId : null);
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
  // What [[ links to: every artifact in reach but this one; an archived artifact writes no new documents.
  const inReach = useArtifactsInReach(canvasName, artifact.nodeId);
  const linkable = useMemo(() => inReach.filter((other) => other.ref.artifactId !== artifact.artifactId), [inReach, artifact.artifactId]);
  // One create for the field's life: the node's own changes each render, and the list should not redraw for it.
  const createRef = useRef(createLinked);
  createRef.current = createLinked;
  const create = useCallback((title: string) => createRef.current(title), []);
  const documentMentions = useMemo<DocumentMentions>(
    () => ({
      canvasName,
      candidates: [...mentionable, ...resources],
      nodeKindOf: (id) => nodeAt(canvasName, id)?.kind,
      links: { artifacts: linkable, ...(readOnly ? {} : { create }) },
    }),
    [canvasName, mentionable, resources, linkable, readOnly, create],
  );
  // A sheet's cells take the same [[ as the document.
  const sheetLinks = useMemo<SheetCellLinks | undefined>(
    () =>
      documentMentions.links === undefined
        ? undefined
        : { canvasName, links: documentMentions.links, nodeKindOf: documentMentions.nodeKindOf },
    [canvasName, documentMentions],
  );

  useEffect(() => setTitle(artifact.title), [artifact.title]);

  /** The rail: an edge by default, open or closed as one choice for every artifact. */
  const railOpen = useCommentsRailOpen();
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
    // Closed by its key from the composer: the composer is gone and the
    // keyboard with it, so the edge takes it rather than the page.
    const dropped = document.activeElement === null || document.activeElement === document.body;
    if (!railToggled.current && !dropped) return;
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
  /** A resend after a lost answer is the same post: it keeps its op id, so it posts once. */
  const postOps = useRef(makePostOps()).current;
  const comment = (text: string, anchor: Anchor | undefined, threadId?: string): Promise<string | null> =>
    postAfterSave(threadId === undefined ? anchor : undefined, saveDocument.current, async () => {
      const outcome = await subjectThreadsSource().post(canvasName, subject, {
        text,
        opId: postOps.opFor({ text, anchor, ...(threadId === undefined ? {} : { threadId }) }),
        ...(anchor === undefined ? {} : { anchor }),
        ...(threadId === undefined ? {} : { threadId }),
      });
      postOps.settle();
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
            title={artifact.title}
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
            title={artifact.title}
            grid={body.grid}
            readOnly={readOnly}
            onPatch={(patches) => edit((baseVersion) => ({ kind: "patch", type: "sheet", baseVersion, patches: [...patches] }))}
            onCommentCells={(range) => setDraftAnchor({ kind: "cells", range })}
            cellLinks={sheetLinks}
          />
        );
      case "pad":
        return (
          <ArtifactPadEditor
            canvasName={canvasName}
            pad={padOf(body)}
            readOnly={readOnly}
            onPatch={(patches) => edit((baseVersion) => ({ kind: "patch", type: "pad", baseVersion, patches: [...patches] }))}
            onCommentBox={(box) => setDraftAnchor({ kind: "box", ...box })}
            mentions={documentMentions}
          />
        );
      case "link":
        return <LinkPreview body={body} />;
      case "file":
        return (
          <FilePreview
            body={body}
            // The Files node it came from opens on that file, while it is on the canvas.
            {...(body.source !== undefined && nodeAt(canvasName, body.source.nodeId)?.kind === "files"
              ? {
                  onOpenSource: (source: FileSource) => {
                    onClose();
                    openWorkDetail(source.nodeId, { itemId: source.path, ...(source.page === undefined ? {} : { page: source.page }) });
                  },
                }
              : {})}
          />
        );
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
  // One read of what links here, for the rail's list and its collapsed edge.
  const linked = useLinkedFrom(canvasName, { nodeId: artifact.nodeId, artifactId: artifact.artifactId }, now);
  /** An artifact place in reach, by its title and type; a task's title; else nothing, and the chip names its node. */
  const artifactAt = (place: MentionRef) =>
    place.kind !== "artifact"
      ? undefined
      : (inReach.find((other) => other.ref.nodeId === place.nodeId && other.ref.artifactId === place.artifactId) ??
        siblings
          .filter((sibling) => sibling.artifact.artifactId === place.artifactId)
          .map((sibling) => ({ title: sibling.artifact.title, type: sibling.artifact.type }))[0]);
  const rail = (
    <div className="artifact-rail" ref={railRef}>
      {railOpen ? (
        <>
          {comments}
          <LinkedFromList
            read={linked}
            canvasName={canvasName}
            now={now}
            nameOf={(place) => (place.kind === "task" ? tasks.find((task) => task.taskId === place.taskId)?.title : artifactAt(place)?.title)}
            artifactTypeOf={(place) => artifactAt(place)?.type}
            artifactTitleOf={(target) => artifactAt({ kind: "artifact", ...target })?.title}
            beforeOpen={onClose}
          />
        </>
      ) : (
        <ArtifactCommentsEdge
          threads={threads}
          seatName={seatName}
          {...(linkedFromCount(linked) === undefined ? {} : { linkedFrom: linkedFromCount(linked) })}
          onOpen={() => toggleRail(true)}
        />
      )}
    </div>
  );

  return (
    <TwoPane keptBy={{ canvas: canvasName, node: nodeId }} sidebar={sidebar} sidebarLabel="Artifacts" sidebarWidth="narrow" mainLabel={artifact.title} rail={rail} railLabel="Comments" railCollapsed={!railOpen}>
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
        <ArtifactLabelChips
          labels={artifact.labels}
          used={usedLabels}
          colours={labelColours}
          readOnly={readOnly}
          waiting={pending.some((write) => write.op.op === "labels")}
          onChange={(next) => apply({ op: "labels", labels: [...next] }).then((ruling) => ruling.kind)}
          readRuled={async () => {
            // Pending first: once it shows nothing waiting, the ruling landed before the list is read.
            const writes = await artifactsSource().pending(canvasName, artifact.nodeId);
            const heads = await artifactsSource().list(canvasName, artifact.nodeId);
            const head = heads.find((one) => one.artifact.artifactId === artifact.artifactId);
            return head === undefined
              ? undefined
              : {
                  waiting: writes.some((write) => write.artifactId === artifact.artifactId && write.op.op === "labels"),
                  labels: head.artifact.labels,
                };
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
        <IconButton
          aria-label={moveCount > 1 ? `Move ${String(moveCount)} artifacts to\u2026` : "Move to\u2026"}
          title={moveCount > 1 ? `Move ${String(moveCount)} artifacts to\u2026` : "Move to\u2026"}
          aria-haspopup="dialog"
          size="sm"
          onClick={onMove}
        >
          <FolderInput size={14} />
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
            moves={moves}
            moveTitle={(move) => moveEntryTitle((id) => nodeAt(canvasName, id), move.from, move.to)}
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
