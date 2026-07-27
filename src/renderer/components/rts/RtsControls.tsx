import { useEffect, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  Inbox,
  ListChecks,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
  SquareX,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import type { CanvasEdge, CanvasNode } from "@shared/canvas";
import { regionsContaining, type PauseScope } from "@shared/pause";
import { HUE } from "../../lib/theme";
import { state$ } from "../../lib/state";
import { kernel$, pulseRegion } from "../../lib/kernel-view";
import {
  ensurePauseState,
  nodePausedIn,
  pause$,
  refreshPauseState,
  regionPausedIn,
  setScopePaused,
} from "../../lib/pause-state";
import { openWorkDetail } from "../../lib/work-detail-open";
import { ACP_CHAT_SURFACE_HIDDEN } from "@shared/legacy-surfaces";
import { openAgentChatSurface } from "../../lib/dock-state";
import { openTerminal } from "../../lib/terminal-actions";
import {
  herdr$,
  markHerdrPaneSeenLocal,
  markHerdrPaneSeenRemote,
  openHerdrTerminal,
} from "../../lib/herdr-state";
import { killHerdrPane } from "../../lib/herdr-actions";
import { deleteEdges, toggleEdgeArrow } from "../../lib/edge-mutations";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { getVellumApi } from "../../lib/vellum-api";
import { nodeTitle } from "../../lib/presentation";
import { OpenHerdrMark } from "../herdr/OpenHerdrMark";
import { EdgeCriteriaEditor } from "../InspectorFields";
import "./rts-controls.css";

const ICON = 12;

/** Same 26px square key as the command card (shared .rts-key chrome). */
export function KindKey({
  label,
  title,
  active,
  danger,
  disabled,
  style,
  testId,
  data,
  onClick,
  children,
}: {
  readonly label: string;
  readonly title?: string;
  readonly active?: boolean;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly style?: React.CSSProperties;
  readonly testId?: string;
  readonly data?: Readonly<Record<string, string>>;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rts-key${active ? " is-active" : ""}${danger ? " is-danger" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={title ?? label}
      disabled={disabled}
      style={style}
      data-testid={testId}
      {...data}
      onClick={onClick}
    >
      <span className="rts-key__icon">{children}</span>
    </button>
  );
}

// --- pause key (left panel base action; node + region scope) -----------------

/**
 * Scope pause toggle for the command card. Reflects only its own scope
 * (node/region membership) — canvas play/pause stays on the top-bar switch.
 */
export function PauseScopeKey({ scope }: { readonly scope: PauseScope }) {
  const canvasName = use$(state$.canvasName);
  const paused = use$(() => {
    const state = pause$.state.get();
    if (scope.kind === "node") return nodePausedIn(state, scope.id);
    if (scope.kind === "region") return regionPausedIn(state, scope.id);
    return !state.playing;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const scopeId = scope.kind === "canvas" ? "" : scope.id;
  useEffect(() => {
    setError("");
    // Fresh read per selection — no push channel exists for the pause plane.
    if (canvasName) void refreshPauseState(canvasName);
  }, [canvasName, scopeId]);

  const toggle = () => {
    if (busy) return;
    setBusy(true);
    void setScopePaused(scope, !paused)
      .then((refusal) => setError(refusal))
      .finally(() => setBusy(false));
  };

  const noun = scope.kind;
  return (
    <KindKey
      label={paused ? `Resume ${noun}` : `Pause ${noun}`}
      title={
        error
          ? `pause switch: ${error}`
          : paused
            ? `${noun} paused — click to resume`
            : `pause ${noun} — its seats stop acting`
      }
      active={paused}
      disabled={busy}
      style={{ color: paused ? HUE.amber : error ? HUE.crimson : undefined }}
      testId={`rts-pause-${scope.kind}`}
      data={{ "data-paused": paused ? "true" : "false" }}
      onClick={toggle}
    >
      {paused ? <Play size={ICON} /> : <Pause size={ICON} />}
    </KindKey>
  );
}

// --- left panel: general relation (edge) controls ----------------------------

/**
 * Left command card for a selected relation: live phase readout plus the
 * general edge controls (arrowheads, delete). Pair-specific criteria live in
 * the middle bar (EdgePairStrip).
 */
export function EdgeCommandCard({ edgeId }: { readonly edgeId: string }) {
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return null;

  const fromNode = doc.nodes.find((n) => n.id === edge.fromNode);
  const toNode = doc.nodes.find((n) => n.id === edge.toNode);
  const livePhase = execution?.phaseByEdgeId[edgeId];
  const liveDetail = execution?.detailByEdgeId[edgeId];
  const criteria = edge.ether?.criteria;
  const phase = livePhase ?? (criteria ? `criteria · ${criteria.mode}` : "soft relates");
  const phaseHue = livePhase === "blocks" ? HUE.crimson : undefined;

  return (
    <div className="rts-panel rts-panel--cmd">
      <div className="rts-panel__label">
        command · relation
        <span className="rts-signal" style={{ color: phaseHue }} title={liveDetail ?? phase}>
          {phase}
        </span>
      </div>
      <div className="rts-panel__body rts-cmd-shell">
        <div className="rts-cmd-head">
          <div className="rts-cmd__meta">
            {liveDetail ?? (criteria ? "stops flow while unmet" : "no stoppage")}
          </div>
          <div className="rts-cmd__title">
            {fromNode ? nodeTitle(fromNode) : edge.fromNode} → {toNode ? nodeTitle(toNode) : edge.toNode}
          </div>
        </div>
        <div className="rts-cmd-keys" role="toolbar" aria-label="Relation actions">
          <KindKey
            label="Toggle arrow at source"
            title="arrowhead on the from end"
            active={edge.fromEnd === "arrow"}
            onClick={() => toggleEdgeArrow(edgeId, "from")}
          >
            <ArrowLeft size={ICON} />
          </KindKey>
          <KindKey
            label="Toggle arrow at target"
            title="arrowhead on the to end"
            active={edge.toEnd === "arrow"}
            onClick={() => toggleEdgeArrow(edgeId, "to")}
          >
            <ArrowRight size={ICON} />
          </KindKey>
          <span className="rts-cmd-keys__rule" aria-hidden />
          <KindKey label="Delete relation" danger onClick={() => deleteEdges([edgeId])}>
            <Trash2 size={ICON} />
          </KindKey>
        </div>
      </div>
    </div>
  );
}

// --- middle panel: kind strip ------------------------------------------------

/** Work-service task create, inside the same admission boundary as the board. */
const createWorkTask = async (nodeId: string, brief: string): Promise<string> => {
  const api = getVellumApi();
  const canvas = state$.canvasName.peek();
  if (!api?.workTaskCreate || !canvas) return "no canvas is open";
  try {
    const result = await runCanvasAuthoringOperation(async () => {
      const r = await api.workTaskCreate(canvas, nodeId, brief, { title: brief });
      if (r.ok) applyWorkCanvasWrite(canvas, r.doc, r.revision);
      return r;
    });
    if (result === undefined) return "";
    return result.ok ? "" : result.message;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
};

const KILL_ARM_MS = 3000;

function HerdrKindKeys({ node }: { readonly node: CanvasNode }) {
  const herdrMeta = use$(herdr$.metaByNodeId[node.id]);
  const [killArmed, setKillArmed] = useState(false);
  const killTimer = useRef<number | null>(null);
  const herdr = node.ether?.herdr;

  useEffect(() => {
    setKillArmed(false);
    if (killTimer.current !== null) {
      window.clearTimeout(killTimer.current);
      killTimer.current = null;
    }
  }, [node.id]);
  useEffect(() => {
    return () => {
      if (killTimer.current !== null) window.clearTimeout(killTimer.current);
    };
  }, []);

  if (!herdr) return null;
  const agentStatus = herdrMeta?.meta?.agentStatus;
  const canMarkSeen = Boolean(herdr.paneId) && agentStatus === "done";
  const canKill = Boolean(herdr.paneId);

  const fireKill = () => {
    if (!killArmed) {
      setKillArmed(true);
      if (killTimer.current !== null) window.clearTimeout(killTimer.current);
      killTimer.current = window.setTimeout(() => {
        killTimer.current = null;
        setKillArmed(false);
      }, KILL_ARM_MS);
      return;
    }
    if (killTimer.current !== null) {
      window.clearTimeout(killTimer.current);
      killTimer.current = null;
    }
    setKillArmed(false);
    void killHerdrPane(node.id, herdr);
  };

  return (
    <>
      <KindKey
        label="Open work surface"
        title={`open · ${herdr.host}`}
        style={{ color: HUE.cyan }}
        onClick={() => openHerdrTerminal(node.id, herdr, nodeTitle(node))}
      >
        <OpenHerdrMark size={ICON} />
      </KindKey>
      {canMarkSeen ? (
        <KindKey
          label="Mark seen"
          title="mark pane seen (done → idle)"
          style={{ color: HUE.amber }}
          onClick={() => {
            markHerdrPaneSeenLocal(node.id, herdr);
            void markHerdrPaneSeenRemote(herdr, node.id);
          }}
        >
          <CheckCheck size={ICON} />
        </KindKey>
      ) : null}
      {canKill ? (
        <KindKey
          label={killArmed ? "Confirm kill pane" : "Kill pane"}
          title={killArmed ? "click again to kill pane" : "arm kill pane (3s)"}
          danger
          active={killArmed}
          style={killArmed ? { color: HUE.crimson } : undefined}
          onClick={fireKill}
        >
          <SquareX size={ICON} />
        </KindKey>
      ) : null}
    </>
  );
}

function TaskKindKeys({ node }: { readonly node: CanvasNode }) {
  const [adding, setAdding] = useState(false);
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAdding(false);
    setBrief("");
    setError("");
  }, [node.id]);

  const submit = () => {
    const trimmed = brief.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    void createWorkTask(node.id, trimmed)
      .then((refusal) => {
        setError(refusal);
        if (!refusal) {
          setBrief("");
          setAdding(false);
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <KindKey
        label="Open task board"
        title="open the full task board"
        style={{ color: HUE.cyan }}
        onClick={() => openWorkDetail(node.id)}
      >
        <ListChecks size={ICON} />
      </KindKey>
      <KindKey
        label={adding ? "Close add task" : "Add task"}
        title="submit a task to this sink"
        active={adding}
        onClick={() => setAdding((open) => !open)}
      >
        <Plus size={ICON} />
      </KindKey>
      {adding ? (
        <div className="rts-kind-pop">
          <label className="rts-kind-pop__field">
            <span>new task · enter submits</span>
            <input
              autoFocus
              aria-label="New task brief"
              placeholder="what needs doing?"
              value={brief}
              disabled={busy}
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
                if (event.key === "Escape") setAdding(false);
              }}
            />
          </label>
          {error ? <div className="rts-kind-pop__error">{error}</div> : null}
        </div>
      ) : null}
    </>
  );
}

function SchedulerKindKeys({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const regionId = regionsContaining(doc, node.id)[0];
  return (
    <KindKey
      label="Pulse now"
      title={
        regionId
          ? "manual pulse of the containing region"
          : "place inside a region to pulse"
      }
      disabled={!regionId}
      onClick={() => {
        if (!regionId) return;
        void pulseRegion(regionId, {
          summary: `manual pulse · ${nodeTitle(node)}`,
        }).catch(() => undefined);
      }}
    >
      <Zap size={ICON} />
    </KindKey>
  );
}

/** Kind-specific action keys (agent/herdr/terminal/task/…). */
export function KindActions({ node }: { readonly node: CanvasNode }) {
  const kind = node.ether?.entity?.kind;
  switch (kind) {
    case "agent":
      // Managed terminal is the only agent surface; ACP chat is hard-hidden.
      if (ACP_CHAT_SURFACE_HIDDEN) return null;
      return (
        <KindKey
          label="Open chat"
          title="open the agent chat surface"
          style={{ color: HUE.cyan }}
          onClick={() => openAgentChatSurface(node)}
        >
          <MessageSquareText size={ICON} />
        </KindKey>
      );
    case "herdr":
      return <HerdrKindKeys node={node} />;
    case "terminal":
      return (
        <KindKey
          label="Open terminal"
          title="open the terminal surface"
          style={{ color: HUE.cyan }}
          onClick={() => void openTerminal(node)}
        >
          <Terminal size={ICON} />
        </KindKey>
      );
    case "task":
      return <TaskKindKeys node={node} />;
    case "requests":
      return (
        <KindKey
          label="Open request inbox"
          title="open the request inbox"
          style={{ color: HUE.cyan }}
          onClick={() => openWorkDetail(node.id)}
        >
          <Inbox size={ICON} />
        </KindKey>
      );
    case "watcher":
    case "timer":
      return <SchedulerKindKeys node={node} />;
    default:
      // Unknown / geography kinds: silence is semantic.
      return null;
  }
}

export function EdgePairStrip({ edge }: { readonly edge: CanvasEdge }) {
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => setEditorOpen(false), [edge.id]);

  const fromNode = doc.nodes.find((n) => n.id === edge.fromNode);
  const toNode = doc.nodes.find((n) => n.id === edge.toNode);
  const criteria = edge.ether?.criteria;
  const summary = !criteria
    ? "soft relates"
    : criteria.mode === "tasks"
      ? "tasks · needs input blocks"
      : `trust plane · ${criteria.mode}`;

  return (
    <div className="rts-kind-strip" role="toolbar" aria-label="Relation pair actions">
      <span className="rts-kind-strip__label" title={summary}>
        {fromNode ? nodeTitle(fromNode) : "?"} → {toNode ? nodeTitle(toNode) : "?"}
      </span>
      <span className="rts-kind-strip__meta">{summary}</span>
      <KindKey
        label={editorOpen ? "Close criteria editor" : "Edit stop criteria"}
        title="edit when this relation stops flow"
        active={editorOpen}
        onClick={() => setEditorOpen((open) => !open)}
      >
        <SlidersHorizontal size={ICON} />
      </KindKey>
      {editorOpen ? (
        <div className="rts-kind-pop rts-kind-pop--editor">
          <EdgeCriteriaEditor
            edgeId={edge.id}
            fromNode={fromNode}
            livePhase={execution?.phaseByEdgeId[edge.id]}
            liveDetail={execution?.detailByEdgeId[edge.id]}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Middle-bar kind surface: selected node's kind-specific actions (agent /
 * herdr / terminal / tasks / requests / watcher / timer), or the selected
 * relation's pair controls. Empty selection and geography get a quiet cue —
 * never invent controls for a kind that has none.
 */
export function KindStrip() {
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const selectedEdgeId = use$(state$.selectedEdgeId);

  if (selectedNodeIds.length > 1) {
    return (
      <div className="rts-quiet rts-quiet--compact">
        Multi-select · kind actions need a single node
      </div>
    );
  }

  if (selectedEdgeId) {
    const edge = doc.edges.find((candidate) => candidate.id === selectedEdgeId);
    return edge ? (
      <EdgePairStrip edge={edge} />
    ) : (
      <div className="rts-quiet rts-quiet--compact">Select a node · or tap 1–9</div>
    );
  }

  if (!selectedNodeId) {
    return (
      <div className="rts-quiet rts-quiet--compact">Select a node · or tap 1–9</div>
    );
  }

  const node = doc.nodes.find((candidate) => candidate.id === selectedNodeId);
  if (!node) {
    return (
      <div className="rts-quiet rts-quiet--compact">Select a node · or tap 1–9</div>
    );
  }

  if (node.type === "group") {
    return (
      <div className="rts-quiet rts-quiet--compact">
        Region · arm · pulse · rollcall live on the left
      </div>
    );
  }

  const kind = node.ether?.entity?.kind;
  if (!kind) {
    return (
      <div className="rts-quiet rts-quiet--compact">No kind actions for this node</div>
    );
  }
  if (!["agent", "herdr", "terminal", "task", "requests", "watcher", "timer"].includes(kind)) {
    return (
      <div className="rts-quiet rts-quiet--compact">No kind actions for this node</div>
    );
  }

  return (
    <div className="rts-kind-strip" role="toolbar" aria-label={`${kind} actions`}>
      <span className="rts-kind-strip__label">{kind}</span>
      <KindActions node={node} />
    </div>
  );
}

// --- region hotbar pause dot -------------------------------------------------

/**
 * Tiny pause toggle on a region chip. Not a <button> — chips are buttons and
 * buttons cannot nest; span[role=button] with stopped propagation instead.
 */
export function RegionPauseDot({ regionId }: { readonly regionId: string }) {
  const canvasName = use$(state$.canvasName);
  const paused = use$(() => regionPausedIn(pause$.state.get(), regionId));

  useEffect(() => {
    if (canvasName) ensurePauseState(canvasName);
  }, [canvasName]);

  const toggle = () => {
    void setScopePaused({ kind: "region", id: regionId }, !paused);
  };

  return (
    <span
      role="button"
      tabIndex={0}
      className={`rts-chip__pause${paused ? " is-paused" : ""}`}
      aria-label={paused ? "Resume region" : "Pause region"}
      title={paused ? "region paused — click to resume" : "pause region"}
      data-paused={paused ? "true" : "false"}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          toggle();
        }
      }}
    >
      {paused ? <Play size={7} aria-hidden /> : <Pause size={7} aria-hidden />}
    </span>
  );
}
