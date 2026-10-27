import { countRender } from "../../lib/performance/surface-commits";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { NodeKind, NodeOf } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import type { FlowNode } from "../../lib/convert";
import { useSeatAwarenessOn } from "../../lib/experimental-features";
import { editText } from "../../lib/mutations";
import { NoteMarkdown } from "../../lib/note-markdown";
import { state$ } from "../../lib/state";
import { accentColor, INK } from "../../lib/theme";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { productNodeKindEnabled, TASKS_ENABLED } from "@shared/features";
import { consumeWorkDetailOpen, filesDetailOpening, workDetailOpen$ } from "../../lib/work-detail-open";
import {
  markNoteSurfaceSaved,
  noteSurfaceId,
  openNoteSurface,
  updateNoteSurfaceDraft,
} from "../../lib/dock-state";
import { SeatAwarenessHoverForNode } from "../terminal/SeatAwarenessHoverForNode";
import { SeatCollaborationBlock } from "../terminal/SeatCollaborationBlock";
import { TerminalCard } from "../terminal/TerminalCard";
import {
  closeSeatCollaboration,
  openSeatCollaboration,
  seatCollaborationUi$,
} from "../../lib/seat-collaboration";
import { TerminalToolbarActions } from "../terminal/TerminalToolbarActions";
import { SeatMessageToolbarAction } from "./SeatMessage";
import { SeatOffboardToolbarAction } from "./SeatOffboard";
import { CustomizeAgentToolbarAction } from "../agent-editor/AgentEditor";
import { StartParamsToolbarAction } from "../customize/ParamsSection";
import { claimFocus } from "../../lib/focus-ownership";
import { nodeAt, useNodeValue, useNodeOf } from "../../lib/use-model";
import { SeatCard } from "./SeatCard";
import { PeerCard, StubCard } from "./RemoteNodeCards";
import { AutomationsCard } from "../automations/AutomationsCard";
import {
  ArtifactsCard,
  ArtifactsDetail,
  AutomationsDetail,
  TasksCard,
  TasksDetail,
} from "../work/WorkSurfaces";
import { GitCard } from "../git/GitCard";
import { holdsSeatRing } from "../../lib/node-geometry";
import { GitDetail } from "../git/GitDetail";
import { FilesCard } from "../files/FilesCard";
import { FilesDetail } from "../files/FilesDetail";
import { TaskToolbarActions } from "../work/TaskToolbarActions";

import { NodeShell } from "./NodeShell";
import { keyIs } from "../../lib/key-match";

// Freeform note body: instrument mono for body; condensed display for heads
// (CSS). Markdown is structure only — no wiki/chips/shorthand leak.

/**
 * Kinds drawn in the Spines language (docs/node-card-language.md): the shell
 * paints nothing and the body is a SpineCard. Kind seats (task, artifacts,
 * automations, terminal, git) take the card shell, which kind-seat.css draws
 * in the seat's recipe.
 */
const SPINE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "peer",
  "stub",
  "note",
  "label",
]);

/** A body follows its own model row, so a card does not subscribe to it. */
function WithNode<K extends NodeKind>({
  canvas, id, kind, children,
}: {
  readonly canvas: string;
  readonly id: string;
  readonly kind: K;
  readonly children: (node: NodeOf<K>) => ReactNode;
}): ReactNode {
  const node = useNodeOf(canvas, id, kind);
  return node === undefined ? null : children(node);
}

export function TextNode({ id, data, selected }: NodeProps<FlowNode>) {
  countRender("text-card", id);
  const canvasName = use$(state$.canvasName);
  // What the card is and what it says, from the node store, one field each.
  const kind = useNodeValue(canvasName, id, (node) => node?.kind);
  const text = useNodeValue(canvasName, id, (node) =>
    node?.kind === "note" || node?.kind === "label" ? node.text : "",
  );
  // The inner surface takes keyboard focus after the card, so it says what
  // pressing it does and to what, as the card's own name does.
  const surfaceName = useNodeValue(canvasName, id, (node) =>
    node?.kind === "note" || node?.kind === "label" ? `Edit ${node.kind}, ${titleOf(node)}` : "",
  );
  const color = useNodeValue(canvasName, id, (node) => node?.color);
  // Each body follows its own row; gestures read it at the moment of the act.
  const isLabel = kind === "label";
  const isFreeNote = kind === "note";
  const isTerminal = kind === "terminal";
  const isAgent = kind === "agent";
  // A seat and a terminal in the model always hold a session binding.
  const managedTerminal = isTerminal || isAgent;
  // Boolean selector: only this node re-renders when edit intent targets it.
  const isEditTarget = use$(() => state$.editNodeId.get() === id);

  // Opening keeps the current note draft in the workbench.
  const openNote = (shown: string = text): void => {
    const node = nodeAt(canvasName, id);
    if (node?.kind === "note") openNoteSurface({ ...node, text: shown });
  };
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [workDetail, setWorkDetail] = useState(false);
  const [workDetailItemId, setWorkDetailItemId] = useState<string | undefined>();
  const [workDetailPage, setWorkDetailPage] = useState<number | undefined>();
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const entityKind = kind;
  const isWorkSurface =
    entityKind === "task" ||
    entityKind === "artifacts" ||
    entityKind === "automations" ||
    entityKind === "git" ||
    entityKind === "files";
  // A feature-gated sink keeps its historical card and rename behavior but
  // cannot open a work detail surface in a build whose gate is off.
  const workDetailAllowed =
    isWorkSurface && productNodeKindEnabled(entityKind);

  useEffect(() => {
    if (editing) {
      setDraft(text);
      claimFocus(ref.current, "open", { select: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (!isEditTarget) return;
    setDraft(text);
    // Artifacts shelf has no authorial name — node.text mirrors artifact
    // names — so it consumes the edit intent without opening rename/edit.
    if (entityKind === "artifacts") {
      state$.editNodeId.set("");
      return;
    }
    if (isLabel) setEditing(true);
    else if (isFreeNote) openNote();
    // Seat/shell/sink cards: rename first line (not full note textarea).
    else if (
      isTerminal ||
      isAgent ||
      managedTerminal ||
      isWorkSurface
    )
      setRenaming(true);
    else setEditing(true);
    state$.editNodeId.set("");
  }, [
    isEditTarget,
    id,
    isFreeNote,
    isTerminal,
    isAgent,
    managedTerminal,
    isWorkSurface,
    isLabel,
    entityKind,
    text,
  ]);

  // Cross-surface open trigger (RTS bars / jump-to-cause): mirrors editNodeId —
  // consume the target (+ optional item id), open the work-plane detail, clear.
  const isWorkDetailTarget = use$(
    () => workDetailOpen$.nodeId.get() === id,
  );
  useEffect(() => {
    if (!isWorkDetailTarget) return;
    const consumed = consumeWorkDetailOpen(id);
    if (!workDetailAllowed || !consumed) return;
    const opening = filesDetailOpening(consumed);
    setWorkDetailItemId(opening.initialItemId);
    setWorkDetailPage(opening.initialPage);
    setWorkDetail(true);
  }, [isWorkDetailTarget, workDetailAllowed, id]);


  const commit = () => {
    setEditing(false);
    if (draft !== text) editText(id, draft);
  };

  const discard = () => {
    setEditing(false);
    setDraft(text);
  };

  const openInline = () => {
    setDraft(text);
    setEditing(true);
  };

  // Expand takes the press without blurring the in-place field, so nothing
  // else commits what was typed there: save it, and open the editor on it.
  const openMaximized = () => {
    const typed = editing ? draft : text;
    setEditing(false);
    if (typed === text) {
      openNote();
      return;
    }
    editText(id, typed);
    openNote(typed);
    const surfaceId = noteSurfaceId(id);
    updateNoteSurfaceDraft(surfaceId, typed);
    markNoteSurfaceSaved(surfaceId, typed);
  };

  const labelHue = color ? accentColor(color) : INK;

  // Both node kinds hold a seat, and the awareness plane observes both, so both
  // get the advisory hover. Collaboration is an agent seat's own surface: a
  // peer is another agent seat on this canvas. Everything renders through the
  // shell's overlay slot, which sits outside the clipped card body.
  const seatAwarenessOn = useSeatAwarenessOn();
  const seatNode = seatAwarenessOn && (managedTerminal || isAgent);
  const collaborationOpen = use$(seatCollaborationUi$.openNodeId) === id;
  // Visibility is the store, not `group-hover`: the slot is opened by the
  // same hover that sets it, so the two can never disagree, and a capture of
  // the page cannot show one state while the other is true.
  const collaborationOverlay = seatNode ? (
    <div
      className={collaborationOpen ? "absolute left-0 top-full z-50 pt-1" : "hidden"}
      data-collaboration-overlay={collaborationOpen ? "open" : undefined}
    >
      {collaborationOpen ? (
        <>
          {/* The advisory hover first: it is the status echo, collaboration is
              the action. Both live outside the clipped card body. */}
          <SeatAwarenessHoverForNode canvas={canvasName} id={id} graphBlocked={data.blocked} />
          {isAgent ? (
            <SeatCollaborationBlock nodeId={id} className="mt-1" />
          ) : null}
        </>
      ) : null}
    </div>
  ) : undefined;
  const closeOnLeave = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A rebuilt card can deliver a leave for a pointer that never moved (the
    // node is replaced under the cursor and the browser reports no related
    // target). That leave is not the operator leaving the card.
    const next: unknown = event.relatedTarget;
    if (next === null || next === undefined) return;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    closeSeatCollaboration(id);
  };

  return (
    <NodeShell
      canvas={canvasName}
      id={id}
      selected={selected}
      blocked={data.blocked}
      onMaximize={isFreeNote && !isLabel ? openMaximized : undefined}
      resizable={!holdsSeatRing(kind)}
      showHandles={!isLabel && kind !== "git" && kind !== "files"}
      bare={isLabel}
      toolbar={isLabel ? "minimal" : "full"}
      look={kind !== undefined && SPINE_KINDS.has(kind) ? "spine" : "card"}
      overlay={collaborationOverlay}
      onHoverEnter={seatNode ? () => openSeatCollaboration(id) : undefined}
      onHoverLeave={seatNode ? closeOnLeave : undefined}
      toolbarExtras={
        managedTerminal ? (
          <>
            {isAgent ? <CustomizeAgentToolbarAction seatId={id} /> : null}
            {isAgent ? <StartParamsToolbarAction seatId={id} /> : null}
            {isAgent ? <SeatMessageToolbarAction id={id} /> : null}
            {isAgent ? <SeatOffboardToolbarAction canvas={canvasName} id={id} /> : null}
            <WithNode canvas={canvasName} id={id} kind={isAgent ? "agent" : "terminal"}>{(node) => <TerminalToolbarActions node={node} />}</WithNode>
          </>
        ) : isAgent ? (
          <CustomizeAgentToolbarAction seatId={id} />
        ) : entityKind === "task" && TASKS_ENABLED ? (
          <TaskToolbarActions nodeId={id} />
        ) : undefined
      }

    >
      {workDetail && workDetailAllowed && entityKind === "task" ? (
        <TasksDetail
          nodeId={id}
          initialItemId={workDetailItemId}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {workDetail && entityKind === "git" ? (
        <WithNode canvas={canvasName} id={id} kind="git">
          {(node) => (
            <GitDetail node={node} onClose={() => setWorkDetail(false)} />
          )}
        </WithNode>
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "artifacts" ? (
        <ArtifactsDetail
          nodeId={id}
          initialItemId={workDetailItemId}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "files" ? (
        <FilesDetail
          nodeId={id}
          initialItemId={workDetailItemId}
          {...(workDetailPage === undefined ? {} : { initialPage: workDetailPage })}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
            setWorkDetailPage(undefined);
          }}
        />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "automations" ? (
        <AutomationsDetail nodeId={id} onClose={() => setWorkDetail(false)} />
      ) : null}
      {isLabel ? (
        editing ? (
          <textarea
            ref={ref}
            data-focus-owner="canvas-draft"
            aria-label="Edit label"
            className="label-edit-inline nodrag nowheel h-full w-full resize-none bg-transparent font-display outline-none"
            style={{ color: labelHue }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                discard();
              }
            }}
          />
        ) : (
          <div
            role="button"
            tabIndex={0}
            aria-label={surfaceName}
            className="label-surface nopan flex h-full w-full cursor-text items-center overflow-hidden border-0 bg-transparent p-0 text-left font-display"
            style={{ color: labelHue }}
            onClick={(event) => {
              if (event.shiftKey) return;
              if (!selected) return;
              event.stopPropagation();
              openInline();
            }}
            onDoubleClick={(event) => {
              if (event.shiftKey) return;
              event.preventDefault();
              event.stopPropagation();
              openInline();
            }}
            onKeyDown={(event) => {
              if (event.shiftKey) return;
              if (!selected) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                openInline();
              }
            }}
          >
            <span className="block w-full truncate" title={text}>
              {text || "Label"}
            </span>
          </div>
        )
      ) : editing &&
        !managedTerminal &&
        !isWorkSurface ? (

        <textarea
          ref={ref}
          data-focus-owner="canvas-draft"
          aria-label="Edit note"
          className="note-edit-inline nodrag nowheel h-full w-full resize-none bg-transparent font-mono outline-none"
          style={{ color: INK }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (keyIs(e, "message.send")) {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              discard();
            }
          }}
        />
      ) : kind !== undefined && kind !== "note" ? (
        <div
          className="nopan h-full w-full"
          onDoubleClick={(event) => {
            if (event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            // Actors / terminals / sinks: open the live surface (same as
            // command-group re-tap activate).
            if (managedTerminal || isAgent || isWorkSurface) {
              const node = nodeAt(canvasName, id);
              if (!node) return;
              const result = activateNodeSurface(node.id);
              if (result.opened) return;
              // Work surfaces also open via local state when the trigger path
              // is unavailable (tests / no work-detail bus).
              if (workDetailAllowed) {
                setWorkDetail(true);
                return;
              }
              return;
            }
            openInline();
          }}
        >
          {entityKind === "terminal" ? (
            <TerminalCard
              canvas={canvasName}
              id={id}
              graphBlocked={data.blocked}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "agent" ? (
            <SeatCard
              canvas={canvasName}
              id={id}
              graphBlocked={data.blocked}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "task" ? (
            <TasksCard nodeId={id} renaming={renaming} onRenameDone={() => setRenaming(false)} />
          ) : entityKind === "artifacts" ? (
            <ArtifactsCard nodeId={id} />
          ) : entityKind === "automations" ? (
            <AutomationsCard nodeId={id} renaming={renaming} onRenameDone={() => setRenaming(false)} />
          ) : entityKind === "peer" ? (
            <WithNode canvas={canvasName} id={id} kind="peer">
              {(node) => <PeerCard node={node} />}
            </WithNode>
          ) : entityKind === "stub" ? (
            <WithNode canvas={canvasName} id={id} kind="stub">
              {(node) => <StubCard node={node} />}
            </WithNode>
          ) : entityKind === "git" ? (
            <WithNode canvas={canvasName} id={id} kind="git">
              {(node) => <GitCard node={node} renaming={renaming} onRenameDone={() => setRenaming(false)} />}
            </WithNode>
          ) : entityKind === "files" ? (
            <WithNode canvas={canvasName} id={id} kind="files">
              {(node) => <FilesCard node={node} renaming={renaming} onRenameDone={() => setRenaming(false)} />}
            </WithNode>
          ) : (
            <NoteMarkdown source={text} />
          )}

        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label={surfaceName}
          className="note-surface nopan h-full w-full cursor-text overflow-hidden border-0 bg-transparent p-0 text-left font-mono items-stretch justify-start"

          onClick={(event) => {
            if (event.shiftKey) return;
            if (!selected) return;
            event.stopPropagation();
            openInline();
          }}
          onDoubleClick={(event) => {
            if (event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            openInline();
          }}
          onKeyDown={(event) => {
            if (event.shiftKey) return;

            if (!selected) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              openInline();
            }
          }}
        >
          <NoteMarkdown source={text} />
        </div>
      )}
    </NodeShell>
  );
}
