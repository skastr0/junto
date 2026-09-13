import { useEffect, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  Flame,
  Gauge,
  Globe,
  Inbox,
  Link2,
  ListChecks,
  MessageSquareText,
  Mic,
  Package,
  Pause,
  Pencil,
  PenLine,
  Table,
  Play,
  Plus,
  Radio,
  Server,
  SlidersHorizontal,
  Terminal,
  Timer,
  Trash2,
} from "lucide-react";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import type { TaskAdmission, TasksContract, TasksIncoming } from "@shared/work-model";
import { resolveTaskAdmission } from "@shared/work-model";
import {
  BROWSER_ENABLED,
  CRON_ENABLED,
  FLEET_UI_ENABLED,
  RELAY_ENABLED,
  productNodeKindEnabled,
} from "@shared/features";
import { type PauseScope } from "@shared/pause";
import { verbsForPair, type Verb } from "@shared/physics";
import { isTaskSinkNode } from "@shared/flow-graph";
import { tasksNodeIdentity } from "@shared/tasks-node-identity";
import { verbSentence as formatWireSentence } from "../../lib/verb-sentence";
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
import { deleteEdges } from "../../lib/edge-mutations";
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
import { formatWait, normalizeBoardSettings } from "../rules";
import { commitDoc, setBoardSettings } from "../../lib/mutations";
import { Button } from "../ui";
import { CronScheduleSurface } from "../nodes/CronScheduleSurface";
import { AgentReseatControl } from "./AgentReseatControl";
import { OverseerToggleKey } from "./OverseerToggle";
import { canStartOverseerLive, openOverseerLive } from "../../lib/overseer-live-state";
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

// --- the relation surface ----------------------------------------------------
//
// An edge says one thing: which relationship this is. So it needs no dialog,
// no form, and no second authoring surface — the bottom bar reads the verb,
// names the two ends, offers the pair's other verb when there is one, and
// deletes. Everything else about the wire is compiled from that verb.

type EdgeVerbView = {
  readonly verb: Verb | undefined;
  /** The pair's other verb, present only when the pair admits two. */
  readonly sibling: Verb | undefined;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly sentence: string;
};

/**
 * What to call an end of a relationship: the name its card wears.
 *
 * A task sink's live items overwrite its node text, so the plain title of one
 * is whichever task happens to sit at the top of it — the sentence would say
 * an agent manages "Ship the verb cut" while the card it points at says
 * "Backlog". `tasksNodeIdentity` is the one board-name projection every other
 * Tasks surface already reads; the edge readout owes the same word.
 */
const endLabel = (node: CanvasNode | undefined, fallbackId: string): string => {
  if (!node) return fallbackId;
  return isTaskSinkNode(node) ? tasksNodeIdentity(node).name : nodeTitle(node);
};

const edgeVerbView = (doc: CanvasDoc, edge: CanvasEdge): EdgeVerbView => {
  const fromNode = doc.nodes.find((n) => n.id === edge.fromNode);
  const toNode = doc.nodes.find((n) => n.id === edge.toNode);
  const fromLabel = endLabel(fromNode, edge.fromNode);
  const toLabel = endLabel(toNode, edge.toNode);
  const verb = edge.ether?.verb;
  const sibling =
    verb === undefined
      ? undefined
      : verbsForPair(
          fromNode?.ether?.entity?.kind,
          toNode?.ether?.entity?.kind,
        ).find((candidate) => candidate !== verb);
  return {
    verb,
    sibling,
    fromLabel,
    toLabel,
    sentence:
      verb === undefined
        ? `${fromLabel} → ${toLabel}`
        : formatWireSentence(verb, fromLabel, toLabel),
  };
};

/**
 * Swap this edge to the pair's other verb. Both are legal for the pair by
 * construction — the control only ever appears when the pair holds two — so
 * the write is the whole decision and there is nothing left to validate.
 */
const swapEdgeVerb = (edgeId: string, verb: Verb): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) =>
      edge.id === edgeId ? { ...edge, ether: { verb } } : edge,
    ),
  });
};

/**
 * Left command card for a selected relation: the two ends, the live phase (or
 * the verb sentence when the kernel is quiet), and delete.
 */
export function EdgeCommandCard({ edgeId }: { readonly edgeId: string }) {
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return null;

  const view = edgeVerbView(doc, edge);
  const livePhase = execution?.phaseByEdgeId[edgeId];
  const liveDetail = execution?.detailByEdgeId[edgeId];
  const line = liveDetail ?? livePhase ?? view.sentence;
  const phaseHue = livePhase === "blocks" ? HUE.crimson : undefined;

  return (
    <div className="rts-panel rts-panel--cmd">
      <div className="rts-panel__body rts-cmd-shell">
        <div className="rts-cmd-main">
          <div className="rts-cmd-head">
            <div className="rts-cmd__title">
              {view.fromLabel} → {view.toLabel}
            </div>
            <div className="rts-cmd__live" style={{ color: phaseHue }} title={line}>
              {line}
            </div>
          </div>
        </div>
        <div className="rts-cmd-keys rts-cmd-keys--col" role="toolbar" aria-label="Relation actions">
          <KindKey label="Delete relation" danger onClick={() => deleteEdges([edgeId])}>
            <Trash2 size={ICON} />
          </KindKey>
        </div>
      </div>
    </div>
  );
}

// --- middle panel: kind strip ------------------------------------------------

function PageKindKeys({ node }: { readonly node: CanvasNode }) {
  const [pop, setPop] = useState<"url" | "binding" | null>(null);
  const canvasName = use$(state$.canvasName);
  const pageRef = (() => {
    try {
      return formatNodeRef({ canvasName, nodeId: node.id });
    } catch {
      return undefined;
    }
  })();
  const session = use$(browser$.sessionByRef[pageRef ?? ""]);
  const browser = node.ether?.browser;
  const url = node.type === "link" ? node.url : "";

  useEffect(() => {
    setPop(null);
  }, [node.id]);

  const open = () => {
    if (!pageRef || !browser) return;
    void openDockBrowser(pageRef, {
      nodeId: node.id,
      browser,
      url,
      title: session?.title ?? hostOf(url),
    });
  };

  return (
    <>
      <KindKey label="Open page" title="Open page" onClick={open}>
        <Globe size={ICON} />
      </KindKey>
      <KindKey
        label={pop === "url" ? "Close url" : "Page url"}
        title="Page URL"
        active={pop === "url"}
        onClick={() => setPop((current) => (current === "url" ? null : "url"))}
      >
        <Link2 size={ICON} />
      </KindKey>
      <KindKey
        label={pop === "binding" ? "Close binding" : "Browser binding"}
        title="Host and profile"
        active={pop === "binding"}
        onClick={() => setPop((current) => (current === "binding" ? null : "binding"))}
      >
        <Server size={ICON} />
      </KindKey>
      {pop === "url" ? (
        <div className="rts-kind-pop rts-kind-pop--editor">
          <PageUrlControl node={node} />
        </div>
      ) : null}
      {pop === "binding" ? (
        <div className="rts-kind-pop rts-kind-pop--editor">
          <PageBindingControl node={node} />
        </div>
      ) : null}
    </>
  );
}

function TaskKindKeys({ node }: { readonly node: CanvasNode }) {
  const [pop, setPop] = useState<"home" | "admission" | "wait" | null>(null);
  const fleetUi =
    FLEET_UI_ENABLED &&
    isCommandCenterAuthoring(use$(state$.settings.station.role));
  const contract = node.ether?.tasks?.contract;
  const admission = resolveTaskAdmission(contract);
  const waitMs = contract?.incoming?.waitMs;

  const writeIncoming = (
    patch: Partial<TasksIncoming>,
  ) => {
    setBoardSettings(
      node.id,
      normalizeBoardSettings({
        ...contract,
        incoming: { ...contract?.incoming, ...patch },
      }),
    );
  };

  useEffect(() => {
    setPop(null);
  }, [node.id]);

  return (
    <>
      <KindKey
        label="Open task board"
        title="Open the task board"
        onClick={() => openWorkDetail(node.id)}
      >
        <ListChecks size={ICON} />
      </KindKey>
      <KindKey
        label="Add task"
        title="Enqueue a task"
        onClick={() => openTaskCreateSurface(node)}
      >
        <Plus size={ICON} />
      </KindKey>
      <KindKey
        label="Rename"
        title="Rename"
        onClick={() => state$.editNodeId.set(node.id)}
      >
        <Pencil size={ICON} />
      </KindKey>
      <KindKey
        label="Who starts tasks"
        title={`Starts: ${admissionLabel(admission)}`}
        active={pop === "admission" || admission !== "auto"}
        style={pop === "admission" || admission !== "auto" ? { color: HUE.amber } : undefined}
        onClick={() => setPop((current) => (current === "admission" ? null : "admission"))}
      >
        <Gauge size={ICON} />
      </KindKey>
      <KindKey
        label="Wait before starting"
        title={`Wait: ${formatWait(waitMs) || "none"}`}
        active={pop === "wait" || waitMs !== undefined}
        style={pop === "wait" || waitMs !== undefined ? { color: HUE.amber } : undefined}
        onClick={() => setPop((current) => (current === "wait" ? null : "wait"))}
      >
        <Timer size={ICON} />
      </KindKey>
      {/* Queue home is pure host choice — a fleet surface. */}
      {fleetUi ? (
        <KindKey
          label={pop === "home" ? "Close queue home" : "Queue home"}
          title="Host for new tasks"
          active={pop === "home"}
          onClick={() => setPop((current) => (current === "home" ? null : "home"))}
        >
          <Server size={ICON} />
        </KindKey>
      ) : null}
      {pop === "admission" ? (
        <div className="rts-kind-pop rts-kind-pop--quick" aria-label="Admission quick select">
          <span className="rts-kind-pop__title">Who starts tasks</span>
          <div className="rts-kind-pop__choices">
            {ADMISSION_ORDER.map((value) => (
              <Button
                key={value}
                size="xs"
                variant={admission === value ? "primary" : "chrome"}
                aria-pressed={admission === value}
                onClick={() => {
                  writeIncoming({ admission: value as TaskAdmission });
                  setPop(null);
                }}
              >
                {admissionLabel(value)}
              </Button>
            ))}
          </div>
          <span className="rts-kind-pop__hint">Who can start new tasks on this board.</span>
        </div>
      ) : null}
      {pop === "wait" ? (
        <div className="rts-kind-pop rts-kind-pop--quick" aria-label="Wait quick set">
          <span className="rts-kind-pop__title">Wait before starting</span>
          <div className="rts-kind-pop__choices">
            {([
              [undefined, "None"],
              [15 * 60_000, "15m"],
              [60 * 60_000, "1h"],
              [12 * 60 * 60_000, "12h"],
              [24 * 60 * 60_000, "1d"],
            ] as const).map(([value, label]) => (
              <Button
                key={label}
                size="xs"
                variant={waitMs === value ? "primary" : "chrome"}
                aria-pressed={waitMs === value}
                onClick={() => {
                  writeIncoming({ waitMs: value });
                  setPop(null);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <span className="rts-kind-pop__hint">
            Current: {formatWait(waitMs) || "none"}. Tasks wait this long before any agent can
            start them. Set a custom time in Board settings.
          </span>
        </div>
      ) : null}
      {fleetUi && pop === "home" ? (
        <div className="rts-kind-pop rts-kind-pop--queue-home">
          <TaskQueueHomeControl node={node} />
        </div>
      ) : null}
    </>
  );
}

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
            <OverseerToggleKey node={node} />
            {canStartOverseerLive(node) && <KindKey
              label="Start live conversation"
              title="Talk with this Overseer"
              testId="rts-overseer-live"
              onClick={() => openOverseerLive({ canvasName: state$.canvasName.peek(), nodeId: node.id, title: nodeTitle(node) })}
            ><Mic size={ICON} /></KindKey>}
            {rename}
          </>
        );
      }
      if (ACP_CHAT_SURFACE_HIDDEN) {
        return (
          <>
            <OverseerToggleKey node={node} />
            {rename}
          </>
        );
      }
      return (
        <>
          <KindKey
            label="Open chat"
            title="Open chat"
            onClick={() => openAgentChatSurface(node)}
          >
            <MessageSquareText size={ICON} />
          </KindKey>
          <OverseerToggleKey node={node} />
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
        <KindKey
          label="Open artifacts"
          title="Open artifacts"
          onClick={() => openWorkDetail(node.id)}
        >
          <Package size={ICON} />
        </KindKey>
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
    case "sheet":
      return (
        <>
          <KindKey
            label="Open sheet"
            title="Open the sheet"
            onClick={() => openWorkDetail(node.id)}
          >
            <Table size={ICON} />
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

/**
 * Middle-bar relation surface: the verb, the sentence it makes of the two
 * ends, and — only when the pair admits a second verb — the swap to it.
 */
export function EdgePairStrip({ edge }: { readonly edge: CanvasEdge }) {
  const doc = use$(state$.doc);
  const view = edgeVerbView(doc, edge);
  const sibling = view.sibling;

  return (
    <div className="rts-kind-cluster">
      <span className="rts-kind-kind-label">{view.verb ?? "link"}</span>
      <div className="rts-kind-strip" role="toolbar" aria-label="Relation">
        <span className="rts-kind-strip__meta" title={view.sentence}>
          {view.sentence}
        </span>
        {sibling ? (
          <Button
            size="xs"
            variant="chrome"
            title={formatWireSentence(sibling, view.fromLabel, view.toLabel)}
            aria-label={`Change to ${sibling}`}
            onClick={() => swapEdgeVerb(edge.id, sibling)}
          >
            {sibling}
          </Button>
        ) : null}
      </div>
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
