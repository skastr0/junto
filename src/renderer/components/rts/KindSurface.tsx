/**
 * Middle RTS third — kind surface.
 *
 * Identity + live glance + kind action keys live here. Dense node/edge field
 * editors open in a FocusSurface form (not a sidebar). Reuses pristine
 * InspectorFields editors as-is; this file is glue only.
 *
 * Regions: ops on the command card. Kind strip is field keys only —
 * briefing, herdr defaults, page defaults, folder paths. No plate, no placement.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  FolderOpen,
  Globe,
  Package,
  Pencil,
  RefreshCw,
  ScrollText,
  Settings2,
  X,
} from "lucide-react";
import type { CanvasEdge, CanvasNode } from "@shared/canvas";
import {
  BROWSER_ENABLED,
  CRON_ENABLED,
  HERDR_ENABLED,
  RELAY_ENABLED,
} from "@shared/features";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { state$ } from "../../lib/state";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../../lib/presentation";
import { HUE } from "../../lib/theme";
import { connectionStateOf, herdr$, refreshHerdrMeta } from "../../lib/herdr-state";
import {
  classifyMultiSelection,
  multiSelectionLabel,
  surfaceLabel,
} from "../../lib/multi-selection";
import {
  multiPromptAgents,
  multiPromptTargetsFromNodes,
} from "../../lib/multi-prompt";
import { FocusSurface } from "../FocusSurface";
import { OverlayHeader, IconButton } from "../ui";
import { HarnessMark } from "../herdr/HarnessMark";
import { WaitingOnSection } from "../WaitingOnSection";
import { RegionPathsModal } from "../RegionPathsModal";
import { ChatComposer } from "../chat/ChatComposer";
import "../chat/chat.css";
import {
  NodeCapabilityInventory,
  NodeFieldEditors,
  NodePlacementSection,
  RegionBriefingEditor,
  RegionHerdrDefaultsControl,
  RegionPageDefaultsControl,
} from "../InspectorFields";
import { deleteEdges } from "../../lib/edge-mutations";
import { edgeSheetTitle, WireSheetBody } from "../edges/WireSheet";
import { KindActions, EdgePairStrip, KindKey } from "./RtsControls";
import "./rts-controls.css";

const ICON = 12;

type RegionFormKey = "briefing" | "herdr" | "page";

/**
 * Seat-native agent glance — harness mark + document label.
 * No hermes corpus join, no matrix/avatar IPC, no adapter freshness copy.
 */
function AgentSeatGlance({ node }: { readonly node: CanvasNode }) {
  const harness =
    typeof node.ether?.terminal?.harness === "string"
      ? node.ether.terminal.harness
      : undefined;
  const managed = harness !== undefined && isHarnessId(harness);
  return (
    <div className="rts-kind-id" title={nodeTitle(node)}>
      <span className="rts-kind-id__avatar rts-kind-id__avatar--mark" aria-hidden>
        <HarnessMark agent={managed ? harness : undefined} size={22} />
      </span>
      <div className="rts-kind-id__text">
        <div className="rts-kind-id__name">{nodeTitle(node)}</div>
        <div className="rts-kind-id__live">{managed ? harness : "agent seat"}</div>
      </div>
    </div>
  );
}

function HerdrGlance({ node }: { readonly node: CanvasNode }) {
  const herdr = node.ether?.herdr;
  const metaCache = use$(herdr$.metaByNodeId[node.id]);
  const conn = use$(herdr$.connectionByNodeId[node.id]);
  if (!herdr) return null;
  const meta = metaCache?.meta;
  const connState = conn?.state ?? connectionStateOf(node.id);
  const agent = meta?.agent
    ? meta.agentStatus
      ? `${meta.agent} — ${meta.agentStatus}`
      : meta.agent
    : undefined;

  return (
    <div className="rts-kind-id">
      <span className="rts-kind-id__avatar rts-kind-id__avatar--mark" aria-hidden>
        <HarnessMark agent={meta?.agent} size={22} focused={meta?.focused === true} />
      </span>
      <div className="rts-kind-id__text">
        <div className="rts-kind-id__name">{nodeTitle(node)}</div>
        <div className="rts-kind-id__live">
          {herdr.host}
          {agent ? ` — ${agent}` : ""}
          {` — ${connState}`}
        </div>
      </div>
      <KindKey
        label="Refresh herdr meta"
        title="Refresh"
        onClick={() => void refreshHerdrMeta(node.id, herdr)}
      >
        <RefreshCw size={ICON} />
      </KindKey>
    </div>
  );
}

function NodeFormFocus({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const kind = node.ether?.entity?.kind;
  const isLabel = kind === "label";
  return (
    <FocusSurface
      measure="form"
      height="fit"
      layer="detail"
      label={`${nodeTypeLabel(node)} fields`}
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="rts-kind-form-panel nowheel"
    >
      <OverlayHeader
        eyebrow={kind ?? nodeTypeLabel(node)}
        title={nodeTitle(node)}

        actions={
          <IconButton aria-label="Close fields" title="Close fields" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <div className="rts-kind-form-body inspector-body">
        {!isLabel &&
        kind !== "terminal" &&
        kind !== "task" &&
        kind !== "requests" &&
        kind !== "artifacts" &&
        kind !== "board" &&
        kind !== "watcher" &&
        kind !== "timer" &&
        kind !== "cron" &&
        kind !== "relay" &&
        kind !== "page" &&
        Boolean(node.ether?.entity) ? (
          <WaitingOnSection nodeId={node.id} />
        ) : null}
        {!isLabel &&
        kind !== "terminal" &&
        kind !== "task" &&
        kind !== "requests" &&
        kind !== "artifacts" &&
        kind !== "board" &&
        kind !== "watcher" &&
        kind !== "timer" &&
        kind !== "cron" &&
        kind !== "relay" &&
        kind !== "page" &&
        node.type !== "group" &&
        Boolean(node.ether?.entity) ? (
          <NodePlacementSection node={node} />
        ) : null}
        {!isLabel &&
        kind !== "terminal" &&
        kind !== "task" &&
        kind !== "requests" &&
        kind !== "artifacts" &&
        kind !== "board" &&
        kind !== "watcher" &&
        kind !== "timer" &&
        kind !== "cron" &&
        kind !== "relay" &&
        kind !== "page" &&
        Boolean(node.ether?.entity) ? (
          <NodeCapabilityInventory node={node} />
        ) : null}
        {node.ether?.entity && !isLabel && nodeDetail(node) ? (
          <div className="inspector-detail">{nodeDetail(node)}</div>
        ) : null}
        {isLabel ? (
          <div className="inspector-detail">Bare map text — color and size from the canvas controls</div>
        ) : null}
        <NodeFieldEditors node={node} />
      </div>
    </FocusSurface>
  );
}

function EdgeFormFocus({
  edge,
  onClose,
}: {
  readonly edge: CanvasEdge;
  readonly onClose: () => void;
}) {
  const doc = use$(state$.doc);
  const fromNode = doc.nodes.find((n) => n.id === edge.fromNode);
  const toNode = doc.nodes.find((n) => n.id === edge.toNode);
  const title = edgeSheetTitle(edge, fromNode, toNode);
  const pair = `${fromNode ? nodeTitle(fromNode) : edge.fromNode} → ${toNode ? nodeTitle(toNode) : edge.toNode}`;

  return (
    <FocusSurface
      measure="form"
      height="fit"
      layer="detail"
      label="Link settings"
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="rts-kind-form-panel nowheel"
    >
      <OverlayHeader
        eyebrow={pair}
        title={title}
        actions={
          <IconButton aria-label="Close fields" title="Close fields" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <div className="rts-kind-form-body inspector-body">
        <WireSheetBody
          edge={edge}
          fromNode={fromNode}
          toNode={toNode}
          showDelete
          onDelete={() => {
            deleteEdges([edge.id]);
            onClose();
          }}
        />
      </div>
    </FocusSurface>
  );
}

function RegionFieldFocus({
  node,
  form,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly form: RegionFormKey;
  readonly onClose: () => void;
}) {
  const copy: Record<
    RegionFormKey,
    { readonly title: string; readonly measure: "form" | "document"; readonly body: ReactNode }
  > = {
    briefing: {
      title: "Briefing",
      measure: "document",
      body: <RegionBriefingEditor node={node} />,
    },
    herdr: {
      title: "Herdr defaults",
      measure: "form",
      body: <RegionHerdrDefaultsControl node={node} />,
    },
    page: {
      title: "Page defaults",
      measure: "form",
      body: <RegionPageDefaultsControl node={node} />,
    },
  };
  const panel = copy[form];
  return (
    <FocusSurface
      measure={panel.measure}
      height="fit"
      layer="detail"
      label={panel.title}
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="rts-kind-form-panel nowheel"
    >
      <OverlayHeader
        eyebrow="region"
        title={panel.title}
        actions={
          <IconButton aria-label="Close fields" title="Close fields" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <div className="rts-kind-form-body inspector-body">{panel.body}</div>
    </FocusSurface>
  );
}

/** Region kind strip — field keys only. No title, no flag glance, no plate/placement. */
function RegionKindSurface({ node }: { readonly node: CanvasNode }) {
  const [form, setForm] = useState<RegionFormKey | null>(null);
  const [pathsOpen, setPathsOpen] = useState(false);
  const instruction = Boolean(node.ether?.region?.instruction?.trim());
  const defaults = node.ether?.region?.defaults;
  const hasHerdr = Boolean(defaults?.herdr?.host);
  const hasPage = Boolean(
    defaults?.page?.url || defaults?.page?.profile || defaults?.page?.host,
  );
  const pathMap = defaults?.paths;
  const hasPaths = Boolean(
    pathMap && Object.values(pathMap).some((p) => typeof p === "string" && p.trim().length > 0),
  );

  useEffect(() => {
    setForm(null);
    setPathsOpen(false);
  }, [node.id]);

  const toggleForm = (key: RegionFormKey) => {
    setPathsOpen(false);
    setForm((current) => (current === key ? null : key));
  };

  return (
    <div className="rts-kind-surface rts-kind-surface--region">
      <div className="rts-kind-cluster">
        <span className="rts-kind-kind-label">region</span>
        <div className="rts-kind-strip" role="toolbar" aria-label="Region fields">
          <KindKey
            label={form === "briefing" ? "Close briefing" : "Region briefing"}
            title="Region briefing"
            active={form === "briefing" || instruction}
            style={form === "briefing" || instruction ? { color: HUE.amber } : undefined}
            onClick={() => toggleForm("briefing")}
          >
            <ScrollText size={ICON} />
          </KindKey>
          <KindKey
            label={pathsOpen ? "Close folder paths" : "Folder paths"}
            title="Folder paths"
            active={pathsOpen || hasPaths}
            style={pathsOpen || hasPaths ? { color: HUE.amber } : undefined}
            onClick={() => {
              setForm(null);
              setPathsOpen((open) => !open);
            }}
          >
            <FolderOpen size={ICON} />
          </KindKey>
          {HERDR_ENABLED ? (
            <KindKey
              label={form === "herdr" ? "Close herdr defaults" : "Herdr defaults"}
              title="Defaults for new herdr nodes in this region"
              active={form === "herdr" || hasHerdr}
              style={form === "herdr" || hasHerdr ? { color: HUE.cyan } : undefined}
              onClick={() => toggleForm("herdr")}
            >
              <Package size={ICON} />
            </KindKey>
          ) : null}
          {BROWSER_ENABLED ? (
            <KindKey
              label={form === "page" ? "Close page defaults" : "Page defaults"}
              title="Defaults for new page nodes in this region"
              active={form === "page" || hasPage}
              style={form === "page" || hasPage ? { color: HUE.cyan } : undefined}
              onClick={() => toggleForm("page")}
            >
              <Globe size={ICON} />
            </KindKey>
          ) : null}
        </div>
      </div>

      {form && (form !== "page" || BROWSER_ENABLED) ? (
        <RegionFieldFocus node={node} form={form} onClose={() => setForm(null)} />
      ) : null}
      {pathsOpen ? <RegionPathsModal nodeId={node.id} onClose={() => setPathsOpen(false)} /> : null}
    </div>
  );
}

/**
 * Multi-select kind surface: generic cue for mixed; kind actions when homogeneous.
 * Agents get multi-prompt (same text → every selected managed seat) via ChatComposer.
 * Send / label / status float over the textarea so the mid panel never clips them.
 */
function MultiKindSurface({ nodes }: { readonly nodes: ReadonlyArray<CanvasNode> }) {
  const selectionKey = nodes.map((n) => n.id).join("|");
  const classified = useMemo(() => classifyMultiSelection(nodes), [nodes]);
  const targets = useMemo(
    () =>
      classified.mode === "homogeneous" && classified.surface === "kind:agent"
        ? multiPromptTargetsFromNodes(classified.nodes)
        : [],
    [classified],
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    setBusy(false);
    setStatus("");
  }, [selectionKey]);

  if (classified.mode === "heterogeneous") {
    return (
      <div className="rts-kind-surface">
        <div className="rts-quiet rts-quiet--compact">
          {multiSelectionLabel(classified)} — colors & flags on command card
        </div>
      </div>
    );
  }

  if (classified.mode !== "homogeneous") {
    return (
      <div className="rts-quiet rts-quiet--compact">
        Multi-select — kind actions need a single node
      </div>
    );
  }

  if (classified.surface === "kind:agent" && targets.length > 0) {
    const label = `multi-prompt — ${targets.length} agent${targets.length === 1 ? "" : "s"}`;
    return (
      <div
        className="rts-kind-surface rts-kind-surface--multi-prompt"
        data-testid="rts-multi-prompt"
      >
        <ChatComposer
          key={selectionKey}
          className="chat-composer--rts chat-composer--overlay"
          ariaLabel="Prompt all selected agents"
          placeholder="Message all selected agents…"
          hint="⌘↵ send to all"
          sendLabel="Send to all selected agents"
          disabled={busy}
          eyebrow={label}
          status={status}
          onSend={async (text) => {
            setBusy(true);
            setStatus(targets.length > 1 ? `sending ${targets.length}…` : "sending…");
            try {
              const result = await multiPromptAgents(targets, text);
              if (result.failed.length === 0) {
                setStatus(`sent to ${result.sent}`);
                return true;
              }
              const failKeys = result.failed.map((f) => f.agentKey).join(", ");
              setStatus(
                `sent ${result.sent} — failed ${result.failed.length}${failKeys ? ` — ${failKeys}` : ""}`,
              );
              // Keep draft so the operator can retry failed seats.
              return false;
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
    );
  }

  if (classified.surface === "kind:agent" && targets.length === 0) {
    return (
      <div className="rts-kind-surface">
        <div className="rts-quiet rts-quiet--compact">
          agents missing managed seats — multi-prompt needs terminal.bindingId
        </div>
      </div>
    );
  }

  return (
    <div className="rts-kind-surface">
      <div className="rts-quiet rts-quiet--compact">
        {classified.nodes.length} {surfaceLabel(classified.surface)} — shared settings on command card
      </div>
    </div>
  );
}

/**
 * Full kind middle surface: glance + actions + Fields focus form.
 */
export function KindSurface() {
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const selectedEdgeId = use$(state$.selectedEdgeId);
  const edgeSettingsRequestId = use$(state$.edgeSettingsRequestId);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    setFormOpen(false);
  }, [selectedNodeId, selectedEdgeId, selectedNodeIds.length]);

  useEffect(() => {
    if (!edgeSettingsRequestId || edgeSettingsRequestId !== selectedEdgeId) return;
    setFormOpen(true);
    state$.edgeSettingsRequestId.set("");
  }, [edgeSettingsRequestId, selectedEdgeId]);

  if (selectedNodeIds.length > 1) {
    const selectedNodes = selectedNodeIds
      .map((id) => doc.nodes.find((n) => n.id === id))
      .filter((n): n is CanvasNode => n !== undefined);
    return <MultiKindSurface nodes={selectedNodes} />;
  }

  if (selectedEdgeId) {
    const edge = doc.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (!edge) {
      return <div className="rts-quiet rts-quiet--compact"></div>;
    }
    return (
      <div className="rts-kind-surface">
        <EdgePairStrip edge={edge} />
        <div className="rts-kind-strip" role="toolbar" aria-label="Relation fields">
          <KindKey
            label={formOpen ? "Close fields" : "Open fields"}
            title="Wire settings"
            active={formOpen}
            onClick={() => setFormOpen((open) => !open)}
          >
            <Settings2 size={ICON} />
          </KindKey>
        </div>
        {formOpen ? <EdgeFormFocus edge={edge} onClose={() => setFormOpen(false)} /> : null}
      </div>
    );
  }

  if (!selectedNodeId) {
    return <div className="rts-quiet rts-quiet--compact"></div>;
  }

  const node = doc.nodes.find((candidate) => candidate.id === selectedNodeId);
  if (!node) {
    return <div className="rts-quiet rts-quiet--compact"></div>;
  }

  if (node.type === "group") {
    return <RegionKindSurface node={node} />;
  }

  const kind = node.ether?.entity?.kind;
  const isFreeNote = node.type === "text" && !node.ether?.entity;
  const hasKindActions =
    kind !== undefined &&
    [
      "agent",
      ...(HERDR_ENABLED ? (["herdr"] as const) : []),
      "terminal",
      "task",
      "requests",
      "artifacts",
      "board",
      ...(RELAY_ENABLED ? (["watcher", "relay"] as const) : []),
      ...(CRON_ENABLED ? (["timer", "cron"] as const) : []),
      ...(BROWSER_ENABLED ? (["page"] as const) : []),
    ].includes(kind);
  // Agent/herdr keep a live glance. Everything else is strip-only (kind once +
  // keys) so command title is not echoed three more times in the mid third.
  const showSeatGlance =
    kind === "agent" || (HERDR_ENABLED && kind === "herdr");
  // Free notes / agents / work sinks / schedulers / page / shell: no fields
  // sheet. Config is kind-strip pops; rename is pencil. Placement chips are
  // noise.
  const showFieldsKey =
    !isFreeNote &&
    kind !== "agent" &&
    kind !== "terminal" &&
    kind !== "label" &&
    kind !== "task" &&
    kind !== "requests" &&
    kind !== "artifacts" &&
    kind !== "board" &&
    kind !== "watcher" &&
    kind !== "timer" &&
    kind !== "cron" &&
    kind !== "relay" &&
    kind !== "page";
  const stripLabel = kind ?? nodeTypeLabel(node);

  return (
    <div className={`rts-kind-surface${showSeatGlance ? "" : " rts-kind-surface--simple"}`}>
      {kind === "agent" ? <AgentSeatGlance node={node} /> : null}
      {HERDR_ENABLED && kind === "herdr" ? <HerdrGlance node={node} /> : null}

      <div className="rts-kind-cluster">
        <span className="rts-kind-kind-label">{stripLabel}</span>
        <div className="rts-kind-strip" role="toolbar" aria-label={`${stripLabel} actions`}>
          {hasKindActions ? <KindActions node={node} /> : null}
          {isFreeNote ? (
            <KindKey
              label="Edit note"
              title="Edit note"
              onClick={() => state$.editNodeId.set(node.id)}
            >
              <Pencil size={ICON} />
            </KindKey>
          ) : null}
          {showFieldsKey ? (
            <KindKey
              label={formOpen ? "Close fields" : "Open fields"}
              title="Edit node fields"
              active={formOpen}
              style={{ color: formOpen ? HUE.amber : undefined }}
              onClick={() => setFormOpen((open) => !open)}
            >
              <Settings2 size={ICON} />
            </KindKey>
          ) : null}
        </div>
      </div>

      {formOpen && showFieldsKey ? (
        <NodeFormFocus node={node} onClose={() => setFormOpen(false)} />
      ) : null}
    </div>
  );
}
