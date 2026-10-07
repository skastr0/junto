/**
 * Middle RTS third — kind surface.
 *
 * Identity + live glance + kind action keys live here. Dense node field
 * editors open in a FocusSurface form (not a sidebar). Reuses pristine
 * InspectorFields editors as-is; this file is glue only.
 *
 * Relations get no form at all: an edge carries one word, so the pair strip
 * reads it, speaks it, and offers the pair's other verb where there is one.
 *
 * Regions: ops on the command card. Kind strip is field keys only —
 * briefing, page defaults, folder paths. No plate, no placement.
 */
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRtsNodes, useRtsWire, useSelectedNodeIds } from "../../lib/rts-selection";
import { use$ } from "@legendapp/state/react";
import {
  FolderOpen,
  Globe,
  KeyRound,
  Package,
  Pencil,
  RefreshCw,
  ScrollText,
  Settings2,
  X,
} from "lucide-react";
import type { Node, Seat, Region } from "@shared/model";
import {
  BROWSER_ENABLED,
  CRON_ENABLED,
  productNodeKindEnabled,
  RELAY_ENABLED,
} from "@shared/features";
import { state$ } from "../../lib/state";
import { titleOf } from "@shared/model/title";
import { detailOf } from "../../lib/node-presentation";
import { HUE } from "../../lib/theme";
import {
  classifySelectionOf,
  selectionLabelOf,
  surfaceLabel,
} from "../../lib/multi-selection";
import {
  formatMultiPromptStatus,
  multiPromptAgents,
  multiPromptTargetsOf,
} from "../../lib/multi-prompt";
import { FocusSurface } from "../FocusSurface";
import { OverlayHeader, IconButton } from "../ui";
import { SeatRingView, useSeatGlanceOf } from "../SeatRing";
import { CustomizeAgentButton } from "../agent-editor/AgentEditor";
import { OverseerMark } from "../OverseerMark";
import { WaitingOnSection } from "../WaitingOnSection";
import { RegionPathsModal } from "../RegionPathsModal";
import { RegionEnvironmentModal } from "../region-environment/RegionEnvironmentModal";
import { ChatComposer } from "../chat/ChatComposer";
import "../chat/chat.css";
import {
  NodeCapabilityInventory,
  NodeFieldEditors,
  NodePlacementSection,
  RegionBriefingEditor,
  RegionPageDefaultsControl,
} from "../InspectorFields";
import { KindActions, EdgePairStrip, KindKey } from "./RtsControls";
import { RegionKey } from "./RegionKey";
import { SeatOffboardKindKey } from "./SeatOffboardKey";
import "./rts-controls.css";

const ICON = 12;

type RegionFormKey = "briefing" | "page";

/**
 * Seat-native agent glance — harness mark + document label.
 * No hermes corpus join, no matrix/avatar IPC, no adapter freshness copy.
 */
function AgentSeatGlance({ node }: { readonly node: Seat }) {
  const glance = useSeatGlanceOf(node);
  const overseer = node.overseer;
  return (
    <div className="rts-kind-id" title={titleOf(node)} data-overseer={overseer ? "true" : undefined}>
      <CustomizeAgentButton identity={node.id} name={titleOf(node)} hint>
        <SeatRingView node={node} px={44} glance={glance} />
      </CustomizeAgentButton>
      <div className="rts-kind-id__text">
        <div className="rts-kind-id__name">{titleOf(node)}</div>
        <div className="rts-kind-id__live">{node.harness}</div>
        {overseer ? (
          <div className="mt-0.5">
            <OverseerMark size="card" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NodeFormFocus({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  const node = useRtsNodes(use$(state$.canvasName), [nodeId])[0];
  if (!node) return null;
  const kind = node.kind;
  const isLabel = kind === "label";
  return (
    <FocusSurface
      measure="form"
      height="fit"
      label={`${node.kind} fields`}
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="rts-kind-form-panel nowheel"
    >
      <OverlayHeader
        eyebrow={kind}
        title={titleOf(node)}

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
        kind !== "cron" &&
        kind !== "relay" &&
        kind !== "page" &&
        kind !== "git" &&
        !["note", "file", "link", "region"].includes(node.kind) ? (
          <WaitingOnSection nodeId={node.id} />
        ) : null}
        {!isLabel &&
        kind !== "terminal" &&
        kind !== "task" &&
        kind !== "requests" &&
        kind !== "artifacts" &&
        kind !== "board" &&
        kind !== "watcher" &&
        kind !== "cron" &&
        kind !== "relay" &&
        kind !== "page" &&
        kind !== "git" &&
        node.kind !== "region" &&
        !["note", "file", "link", "region"].includes(node.kind) ? (
          <NodePlacementSection nodeId={nodeId} />
        ) : null}
        {!isLabel &&
        kind !== "terminal" &&
        kind !== "task" &&
        kind !== "requests" &&
        kind !== "artifacts" &&
        kind !== "board" &&
        kind !== "watcher" &&
        kind !== "cron" &&
        kind !== "relay" &&
        kind !== "page" &&
        kind !== "git" &&
        !["note", "file", "link", "region"].includes(node.kind) ? (
          <NodeCapabilityInventory nodeId={nodeId} />
        ) : null}
        {!["note", "file", "link", "region"].includes(node.kind) && !isLabel && detailOf(node) ? (
          <div className="inspector-detail">{detailOf(node)}</div>
        ) : null}
        {isLabel ? (
          <div className="inspector-detail">Bare map text — color and size from the canvas controls</div>
        ) : null}
        <NodeFieldEditors nodeId={nodeId} />
      </div>
    </FocusSurface>
  );
}

function RegionFieldFocus({
  node,
  form,
  onClose,
}: {
  readonly node: Region;
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
      body: <RegionBriefingEditor nodeId={node.id} />,
    },
    page: {
      title: "Page defaults",
      measure: "form",
      body: <RegionPageDefaultsControl nodeId={node.id} />,
    },
  };
  const panel = copy[form];
  return (
    <FocusSurface
      measure={panel.measure}
      height="fit"
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
function RegionKindSurface({ node }: { readonly node: Region }) {
  const [form, setForm] = useState<RegionFormKey | null>(null);
  const [pathsOpen, setPathsOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const hasEnvironment = node.environment !== undefined;
  const instruction = Boolean(node.instruction?.trim());
  const defaults = node.defaults;
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
    setEnvironmentOpen(false);
  }, [node.id]);

  const toggleForm = (key: RegionFormKey) => {
    setPathsOpen(false);
    setEnvironmentOpen(false);
    setForm((current) => (current === key ? null : key));
  };

  return (
    <div className="rts-kind-surface rts-kind-surface--region">
      <div className="rts-kind-cluster">
        <span className="rts-kind-kind-label">region</span>
        <div className="rts-region-keys" role="toolbar" aria-label="Region fields">
          <RegionKey
            caption="Briefing"
            name="Region briefing"
            set={instruction}
            open={form === "briefing"}
            onClick={() => toggleForm("briefing")}
          >
            <ScrollText />
          </RegionKey>
          <RegionKey
            caption="Folder paths"
            name="Folder paths"
            set={hasPaths}
            open={pathsOpen}
            onClick={() => {
              setForm(null);
              setEnvironmentOpen(false);
              setPathsOpen((open) => !open);
            }}
          >
            <FolderOpen />
          </RegionKey>
          <RegionKey
            caption="Environment"
            name="Environment and secrets"
            set={hasEnvironment}
            open={environmentOpen}
            testId="rts-region-environment"
            onClick={() => {
              setForm(null);
              setPathsOpen(false);
              setEnvironmentOpen((open) => !open);
            }}
          >
            <KeyRound />
          </RegionKey>
          {BROWSER_ENABLED ? (
            <RegionKey
              caption="Page defaults"
              name="Page defaults"
              set={hasPage}
              open={form === "page"}
              onClick={() => toggleForm("page")}
            >
              <Globe />
            </RegionKey>
          ) : null}
        </div>
      </div>

      {form && (form !== "page" || BROWSER_ENABLED) ? (
        <RegionFieldFocus node={node} form={form} onClose={() => setForm(null)} />
      ) : null}
      {pathsOpen ? <RegionPathsModal nodeId={node.id} onClose={() => setPathsOpen(false)} /> : null}
      {environmentOpen ? (
        <RegionEnvironmentModal nodeId={node.id} onClose={() => setEnvironmentOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * Multi-select kind surface: generic cue for mixed; kind actions when homogeneous.
 * Agents get multi-prompt (same text → every selected managed seat) via ChatComposer.
 * Send / label / status float over the textarea so the mid panel never clips them.
 */
const canonicalSelection = (nodes: ReadonlyArray<Node>): ReadonlyArray<Node> =>
  [...new Map(nodes.map((node) => [node.id, node])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

const promptOwnerIdentity = (
  nodes: ReadonlyArray<Node>,
  targets: ReturnType<typeof multiPromptTargetsOf>,
): string =>
  JSON.stringify([
    nodes.map((node) => node.id),
    targets.map((target) => [target.nodeId, target.bindingId, target.agentKey]),
  ]);

/**
 * Interactive leaf: projection churn above the RTS rail must not re-render the
 * active textarea. A real selection or target change gets a new keyed owner,
 * which intentionally drops the old draft instead of sending it to new seats.
 */
const MultiPromptComposer = memo(
  function MultiPromptComposer({
    ownerIdentity: _ownerIdentity,
    targets,
  }: {
    readonly ownerIdentity: string;
    readonly targets: ReturnType<typeof multiPromptTargetsOf>;
  }) {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string>("");
    const label = `multi-prompt — ${targets.length} agent${targets.length === 1 ? "" : "s"}`;

    return (
      <div
        className="rts-kind-surface rts-kind-surface--multi-prompt"
        data-focus-owner="interactive"
        data-testid="rts-multi-prompt"
      >
        <ChatComposer
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
              setStatus(formatMultiPromptStatus(result));
              // Keep the draft whenever any seat did not submit so the
              // operator sees which are waiting for their seat or failed.
              return result.sent === targets.length;
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
    );
  },
  (previous, next) => previous.ownerIdentity === next.ownerIdentity,
);

function MultiKindSurface({ nodes }: { readonly nodes: ReadonlyArray<Node> }) {
  const selectedNodes = useMemo(() => canonicalSelection(nodes), [nodes]);
  const classified = useMemo(() => classifySelectionOf(selectedNodes), [selectedNodes]);
  const targets = useMemo(
    () =>
      classified.mode === "homogeneous" && classified.surface === "kind:agent"
        ? multiPromptTargetsOf(classified.nodes)
        : [],
    [classified],
  );
  const ownerIdentity = useMemo(
    () => promptOwnerIdentity(selectedNodes, targets),
    [selectedNodes, targets],
  );

  if (classified.mode === "heterogeneous") {
    return (
      <div className="rts-kind-surface">
        <div className="rts-quiet rts-quiet--compact">
          {selectionLabelOf(classified)} — colors on command card
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
    return (
      <>
        <div className="rts-kind-strip" role="toolbar" aria-label="Selected agents actions">
          <SeatOffboardKindKey nodeIds={targets.map((target) => target.nodeId)} />
        </div>
        <MultiPromptComposer
          key={ownerIdentity}
          ownerIdentity={ownerIdentity}
          targets={targets}
        />
      </>
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
  const canvasName = use$(state$.canvasName);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = useSelectedNodeIds();
  const selectedEdgeId = use$(state$.selectedEdgeId);
  const nodes = useRtsNodes(canvasName, selectedNodeIds.length > 1 ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []);
  const edge = useRtsWire(canvasName, selectedEdgeId);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    setFormOpen(false);
  }, [selectedNodeId, selectedEdgeId, selectedNodeIds.length]);

  if (selectedNodeIds.length > 1) {
    return <MultiKindSurface nodes={nodes} />;
  }

  if (selectedEdgeId) {
    if (!edge) {
      return <div className="rts-quiet rts-quiet--compact"></div>;
    }
    // The pair strip is the whole relation surface: verb, endpoints, and the
    // swap when the pair holds a second verb. There is no relation form.
    return (
      <div className="rts-kind-surface">
        <EdgePairStrip edge={edge} />
      </div>
    );
  }

  if (!selectedNodeId) {
    return <div className="rts-quiet rts-quiet--compact"></div>;
  }

  const node = nodes[0];
  if (!node) {
    return <div className="rts-quiet rts-quiet--compact"></div>;
  }

  if (node.kind === "region") {
    return <RegionKindSurface node={node} />;
  }

  const kind = node.kind;
  const isFreeNote = node.kind === "note";
  const hasKindActions =
    kind !== undefined &&
    productNodeKindEnabled(kind) &&
    [
      "agent",
      "terminal",
      "task",
      "requests",
      "artifacts",
      "board",
      "pad",
      "sheet",
      ...(RELAY_ENABLED ? (["watcher", "relay"] as const) : []),
      ...(CRON_ENABLED ? (["cron"] as const) : []),
      ...(BROWSER_ENABLED ? (["page"] as const) : []),
    ].includes(kind);
  // Agent seats keep a live glance. Everything else is strip-only (kind once +
  // keys) so command title is not echoed three more times in the mid third.
  const showSeatGlance = kind === "agent";
  // Free notes / agents / work sinks / schedulers / page / shell: no fields
  // sheet. Config is kind-strip pops; rename is pencil. Placement chips are
  // noise.
  const showFieldsKey =
    !isFreeNote &&
    productNodeKindEnabled(kind) &&
    kind !== "agent" &&
    kind !== "terminal" &&
    kind !== "label" &&
    kind !== "task" &&
    kind !== "requests" &&
    kind !== "artifacts" &&
    kind !== "board" &&
    kind !== "watcher" &&
    kind !== "cron" &&
    kind !== "relay" &&
    kind !== "page";
  const stripLabel = kind;

  return (
    <div className={`rts-kind-surface${showSeatGlance ? "" : " rts-kind-surface--simple"}`}>
      {kind === "agent" ? <AgentSeatGlance node={node} /> : null}

      <div className="rts-kind-cluster">
        <span className="rts-kind-kind-label">{stripLabel}</span>
        <div className="rts-kind-strip" role="toolbar" aria-label={`${stripLabel} actions`}>
          {hasKindActions ? <KindActions nodeId={node.id} /> : null}
          {kind === "agent" ? <SeatOffboardKindKey nodeIds={[node.id]} /> : null}
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
        <SelectedNodeForm nodeId={node.id} onClose={() => setFormOpen(false)} />
      ) : null}
    </div>
  );
}

function SelectedNodeForm({ nodeId, onClose }: { readonly nodeId: string; readonly onClose: () => void }) {
  return <NodeFormFocus nodeId={nodeId} onClose={onClose} />;
}
