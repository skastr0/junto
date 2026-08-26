import { useEffect, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  Flame,
  Gauge,
  Globe,
  Inbox,
  Link2,
  ListChecks,
  MessageSquareText,
  Package,
  Pause,
  Pencil,
  PenLine,
  Play,
  Plus,
  Radio,
  Server,
  SlidersHorizontal,
  SquareX,
  Terminal,
  Timer,
  Trash2,
} from "lucide-react";
import type { CanvasEdge, CanvasNode } from "@shared/canvas";
import type { SinkAdmission, TasksSinkContract } from "@shared/work-model";
import { resolveSinkAdmission } from "@shared/work-model";
import {
  BROWSER_ENABLED,
  CRON_ENABLED,
  FLEET_UI_ENABLED,
  RELAY_ENABLED,
  productNodeKindEnabled,
} from "@shared/features";
import { type PauseScope } from "@shared/pause";
import {
  ADMISSION_ORDER,
  admissionLabel,
} from "../../lib/admission-labels";
import { HUE } from "../../lib/theme";
import { isCommandCenterAuthoring } from "../../lib/canvas-boot";
import { state$ } from "../../lib/state";
import { kernel$ } from "../../lib/kernel-view";
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
import { resolveTerminalBinding } from "@shared/terminal";
import { openAgentChatSurface, openDockBrowser, openTaskCreateSurface } from "../../lib/dock-state";
import { openTerminal } from "../../lib/terminal-actions";
import { deleteEdges, toggleEdgeArrow } from "../../lib/edge-mutations";
import { hostOf, nodeTitle } from "../../lib/presentation";
import { browser$ } from "../../lib/browser-state";
import { formatNodeRef } from "@shared/node-ref";
import {
  PageBindingControl,
  PageUrlControl,
  RelayEditor,
  TaskQueueHomeControl,
  TimerEditor,
  WatcherEditor,
} from "../InspectorFields";
import { formatBakeTime, normalizeSinkContract } from "../claims";
import { setSinkContract } from "../../lib/mutations";
import { Button } from "../ui";
import { edgeSheetSentence, edgeSheetTitle } from "../edges/WireSheet";
import { CronScheduleSurface } from "../nodes/CronScheduleSurface";
import { AgentReseatControl } from "./AgentReseatControl";
import "./rts-controls.css";
import "../node-palette/node-palette-mode-deck.css";

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
          ? error
          : paused
            ? `Resume ${noun}`
            : `Pause ${noun}`
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
  const phase =
    livePhase ??
    edgeSheetSentence(edge, fromNode, toNode) ??
    edgeSheetTitle(edge, fromNode, toNode);
  const phaseHue = livePhase === "blocks" ? HUE.crimson : undefined;

  return (
    <div className="rts-panel rts-panel--cmd">
      <div className="rts-panel__body rts-cmd-shell">
        <div className="rts-cmd-main">
          <div className="rts-cmd-head">
            <div className="rts-cmd__title">
              {fromNode ? nodeTitle(fromNode) : edge.fromNode} → {toNode ? nodeTitle(toNode) : edge.toNode}
            </div>
            <div className="rts-cmd__live" style={{ color: phaseHue }} title={liveDetail ?? phase}>
              {liveDetail ?? phase}
            </div>
          </div>
        </div>
        <div className="rts-cmd-keys rts-cmd-keys--col" role="toolbar" aria-label="Relation actions">
          <KindKey
            label="Toggle arrow at source"
            title="Arrowhead at the source"
            active={edge.fromEnd === "arrow"}
            onClick={() => toggleEdgeArrow(edgeId, "from")}
          >
            <ArrowLeft size={ICON} />
          </KindKey>
          <KindKey
            label="Toggle arrow at target"
            title="Arrowhead at the target"
            active={edge.toEnd === "arrow"}
            onClick={() => toggleEdgeArrow(edgeId, "to")}
          >
            <ArrowRight size={ICON} />
          </KindKey>
          <KindKey label="Delete relation" danger onClick={() => deleteEdges([edgeId])}>
            <Trash2 size={ICON} />
          </KindKey>
        </div>
      </div>
    </div>
  );
}

// --- middle panel: kind strip ------------------------------------------------

/** Kind-specific action keys (agent/terminal/task/…). */
export function KindActions({ node }: { readonly node: CanvasNode }) {
  const kind = node.ether?.entity?.kind;
  switch (kind) {
    case "agent": {
      // Managed terminal is the product surface; ACP chat stays hard-hidden.
      const terminalBound = resolveTerminalBinding(node)?.kind === "native";
      const rename = (
        <KindKey
          label="Rename"
          title="Rename"
          onClick={() => state$.editNodeId.set(node.id)}
        >
          <Pencil size={ICON} />
        </KindKey>
      );
      if (terminalBound) {
        return (
          <>
            <KindKey
              label="Open terminal"
              title="Open agent terminal (double-click node or re-tap slot)"
              onClick={() => void openTerminal(node)}
            >
              <Terminal size={ICON} />
            </KindKey>
            <AgentReseatControl node={node} />
            {rename}
          </>
        );
      }
      if (ACP_CHAT_SURFACE_HIDDEN) return rename;
      return (
        <>
          <KindKey
            label="Open chat"
            title="Open chat"
            onClick={() => openAgentChatSurface(node)}
          >
            <MessageSquareText size={ICON} />
          </KindKey>
          {rename}
        </>
      );
    }
    case "terminal":
      return (
        <KindKey
          label="Open terminal"
          title="Open terminal"
          onClick={() => void openTerminal(node)}
        >
          <Terminal size={ICON} />
        </KindKey>
      );
    case "page":
      return BROWSER_ENABLED ? <PageKindKeys node={node} /> : null;
    case "task":
      return <TaskKindKeys node={node} />;
    case "requests":
      return (
        <>
          <KindKey
            label="Open request inbox"
            title="Open requests"
            onClick={() => openWorkDetail(node.id)}
          >
            <Inbox size={ICON} />
          </KindKey>
          <KindKey
            label="Rename"
            title="Rename"
            onClick={() => state$.editNodeId.set(node.id)}
          >
            <Pencil size={ICON} />
          </KindKey>
        </>
      );
    case "artifacts":
      return (
        <>
          <KindKey
            label="Open artifacts"
            title="Open artifacts"
            onClick={() => openWorkDetail(node.id)}
          >
            <Package size={ICON} />
          </KindKey>
          <KindKey
            label="Rename"
            title="Rename"
            onClick={() => state$.editNodeId.set(node.id)}
          >
            <Pencil size={ICON} />
          </KindKey>
        </>
      );
    case "board":
      return (
        <>
          <KindKey
            label="Open board"
            title="Open the board"
            onClick={() => openWorkDetail(node.id)}
          >
            <MessageSquareText size={ICON} />
          </KindKey>
          <KindKey
            label="Rename"
            title="Rename"
            onClick={() => state$.editNodeId.set(node.id)}
          >
            <Pencil size={ICON} />
          </KindKey>
        </>
      );
    case "pad":
      return (
        <>
          <KindKey
            label="Open pad"
            title="Open the pad"
            onClick={() => openWorkDetail(node.id)}
          >
            <PenLine size={ICON} />
          </KindKey>
          <KindKey
            label="Rename"
            title="Rename"
            onClick={() => state$.editNodeId.set(node.id)}
          >
            <Pencil size={ICON} />
          </KindKey>
        </>
      );
    case "watcher":
    case "timer":
    case "cron":
    case "relay":
      return productNodeKindEnabled(kind) ? <SchedulerKindKeys node={node} /> : null;
    default:
      // Unknown / geography kinds: silence is semantic.
      return null;
  }
}

/** Cron / gauge / relay: rename + sensor body pop (no fields sheet). */
function SchedulerKindKeys({ node }: { readonly node: CanvasNode }) {
  const kind = node.ether?.entity?.kind;
  const [configOpen, setConfigOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [fireBusy, setFireBusy] = useState(false);
  const isCron = kind === "cron" || kind === "timer";
  if ((isCron && !CRON_ENABLED) || (!isCron && !RELAY_ENABLED)) return null;
  const canFire =
    isCron || kind === "relay" || kind === "watcher" || kind === "gauge";
  const fireTitle = isCron
    ? "Run this cron's linked actions now"
    : kind === "relay"
      ? "Run this relay's linked actions now"
      : "Run this scheduler's linked actions now";

  useEffect(() => {
    setConfigOpen(false);
    setScheduleOpen(false);
    setFireBusy(false);
  }, [node.id]);

  const fireNow = async () => {
    const api = window.vellumCommand;
    const canvas = state$.canvasName.peek();
    if (!api?.schedulerFire || !canvas || fireBusy) return;
    setFireBusy(true);
    try {
      await api.schedulerFire(canvas, node.id);
    } finally {
      setFireBusy(false);
    }
  };

  const config =
    isCron
      ? {
          label: configOpen ? "Close expression" : "Expression",
          title: "Cron expression",
          Icon: Timer,
          body: <TimerEditor node={node} />,
        }
      : kind === "watcher"
        ? {
            label: configOpen ? "Close threshold" : "Threshold",
            title: "Hermes stat threshold",
            Icon: Gauge,
            body: <WatcherEditor node={node} />,
          }
        : kind === "relay"
          ? {
              label: configOpen ? "Close links" : "Links",
              title: "Watch inputs and effect outputs",
              Icon: Radio,
              body: <RelayEditor node={node} />,
            }
          : null;

  if (!config) return null;

  return (
    <>
      <KindKey
        label="Rename"
        title="Rename"
        onClick={() => state$.editNodeId.set(node.id)}
      >
        <Pencil size={ICON} />
      </KindKey>
      {isCron ? (
        <KindKey
          label="Settings"
          title="Schedule settings"
          active={scheduleOpen}
          onClick={() => {
            setConfigOpen(false);
            setScheduleOpen(true);
          }}
        >
          <SlidersHorizontal size={ICON} />
        </KindKey>
      ) : null}
      {canFire ? (
        <KindKey
          label={fireBusy ? "Firing…" : "Fire now"}
          title={fireTitle}
          disabled={fireBusy}
          testId="scheduler-fire-now"
          onClick={() => void fireNow()}
        >
          <Flame size={ICON} />
        </KindKey>
      ) : null}
      <KindKey
        label={config.label}
        title={config.title}
        active={configOpen}
        onClick={() => {
          setScheduleOpen(false);
          setConfigOpen((open) => !open);
        }}
      >
        <config.Icon size={ICON} />
      </KindKey>
      {configOpen ? (
        <div className="rts-kind-pop rts-kind-pop--editor">{config.body}</div>
      ) : null}
      {scheduleOpen && isCron ? (
        <CronScheduleSurface
          node={node}
          onClose={() => setScheduleOpen(false)}
        />
      ) : null}
    </>
  );
}

export function EdgePairStrip({ edge }: { readonly edge: CanvasEdge }) {
  const doc = use$(state$.doc);
  const fromNode = doc.nodes.find((n) => n.id === edge.fromNode);
  const toNode = doc.nodes.find((n) => n.id === edge.toNode);
  const summary =
    edgeSheetSentence(edge, fromNode, toNode) ?? edgeSheetTitle(edge, fromNode, toNode);

  return (
    <div className="rts-kind-strip" role="toolbar" aria-label="Relation pair actions">
      <span className="rts-kind-strip__label" title={summary}>
        {fromNode ? nodeTitle(fromNode) : "?"} → {toNode ? nodeTitle(toNode) : "?"}
      </span>
      <span className="rts-kind-strip__meta">{summary}</span>
    </div>
  );
}

/**
 * Middle-bar kind surface: selected node's kind-specific actions (agent /
 * terminal / tasks / requests / watcher / timer), or the selected
 * relation's pair controls. Empty selection and geography get a quiet cue —
 * never invent controls for a kind that has none.
 */
export function KindStrip() {
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const selectedEdgeId = use$(state$.selectedEdgeId);

  if (selectedNodeIds.length > 1) {
    // KindSurface owns multi-select kind chrome (incl. multi-prompt).
    return null;
  }

  if (selectedEdgeId) {
    const edge = doc.edges.find((candidate) => candidate.id === selectedEdgeId);
    return edge ? (
      <EdgePairStrip edge={edge} />
    ) : (
      <div className="rts-quiet rts-quiet--compact"></div>
    );
  }

  if (!selectedNodeId) {
    return (
      <div className="rts-quiet rts-quiet--compact"></div>
    );
  }

  const node = doc.nodes.find((candidate) => candidate.id === selectedNodeId);
  if (!node) {
    return (
      <div className="rts-quiet rts-quiet--compact"></div>
    );
  }

  if (node.type === "group") {
    // KindSurface owns the region field strip; this legacy KindStrip path
    // only surfaces when KindSurface is not mounted.
    return (
      <div className="rts-quiet rts-quiet--compact">
        Region — command card has ops — kind surface has fields
      </div>
    );
  }

  const kind = node.ether?.entity?.kind;
  if (!kind) {
    return (
      <div className="rts-quiet rts-quiet--compact">No kind actions for this node</div>
    );
  }
  if (
    ![
      "agent",
      "terminal",
      "task",
      "requests",
      "watcher",
      "timer",
    ].includes(kind)
  ) {
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
      title={paused ? "Resume region" : "Pause region"}
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
