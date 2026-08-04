import { useEffect, useMemo, useState } from "react";
import { Flag, SlidersHorizontal } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { HashMap, HashSet, Option, Schema } from "effect";
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EdgeCriteria,
  EdgeEffect,
  EtherFlag,
  EtherRegionDefaults,
  EtherWatch,
} from "@shared/canvas";
import { HERDR_ENABLED } from "@shared/features";
import { isGroup } from "@shared/graph";
import { workRolesInDoc } from "@shared/attention";
import {
  Port,
  asNodeId,
  canvasDocToCapabilityView,
  chipPortsFromOffers,
  grantLawForRoles,
  offerPortsForAccessWire,
  offersOf,
  resolveNodePlacement,
  resolveSpec,
  roleOf,
  selectGrant,
  placementLabel,
  undirectedEdgeKey,
  type FactoryRoleName,
  type PortName,
  type NodeSpecValue,
} from "@shared/physics";
import {
  addEdge,
  setEdgeCriteria,
  setEdgeEffect,
  setEdgeNotify,
  setEdgePorts,
  setEdgeWhen,
} from "../lib/edge-mutations";
import { specOf } from "../lib/node-spec";
import { commitDoc, editLink, editText, renameGroup, setNodeHost, setNodeTimer, setNodeWatch, setNodeWorkRole, setPageBinding, setRegionDefaults, setRegionHold, toggleFlag } from "../lib/mutations";
import { isSchedulerEntityKind } from "@shared/scheduler-effects";
import {
  describeCronExpression,
  isValidCronExpression,
} from "@shared/cron-expression";
import { AgentMessagesPane } from "./work/WorkSurfaces";
import { state$ } from "../lib/state";
import { resolveNodeHostId } from "@shared/station";
import { DIM, HUE, INK, withAlpha } from "../lib/theme";
import { nodeTitle, searchText } from "../lib/presentation";
import { Chip, Select, type ChipTone } from "./ui";
import { BrowserProfileSelect, EnrolledHostSelect } from "./HostPickers";

// ---------------------------------------------------------------------------
// Factory physics — capability inventory (read-only) + "limit this key" editor

const decodePort = Schema.decodeUnknownOption(Port);

const entityNameOf = (node: CanvasNode | undefined): string =>
  typeof node?.ether?.entity?.name === "string" ? node.ether.entity.name : "";

/** Valid edge.ether.ports → mask; absent / empty / all-invalid → undefined (full offers). */
const readEdgePortMask = (
  edge: CanvasEdge,
): HashSet.HashSet<PortName> | undefined => {
  const ports = edge.ether?.ports;
  if (!ports || ports.length === 0) return undefined;
  let set = HashSet.empty<PortName>();
  let any = false;
  for (const p of ports) {
    const decoded = decodePort(p);
    if (Option.isSome(decoded)) {
      set = HashSet.add(set, decoded.value);
      any = true;
    }
  }
  return any ? set : undefined;
};

/** Effective ports for caller → target: GrantLaw + mask → PortGrant ∩ offers. */
const effectivePorts = (
  caller: NodeSpecValue,
  target: NodeSpecValue,
  mask: HashSet.HashSet<PortName> | undefined,
): ReadonlyArray<PortName> => {
  const law = grantLawForRoles(roleOf(caller), roleOf(target));
  const grant = selectGrant(law, mask);
  if (grant.isEmpty()) return [];
  const offers = offersOf(target);
  return [...offers].filter((port) => grant.allows(port, offers));
};

function PortChips({ ports }: { readonly ports: ReadonlyArray<PortName> }) {
  if (ports.length === 0) {
    return <div className="inspector-detail">Nothing allowed on this wire</div>;
  }
  return (
    <div className="inspector-flags" role="list" aria-label="Allowed actions">
      {ports.map((port) => (
        <span
          key={port}
          role="listitem"
          className="inspector-flag-toggle"
          title={portLabel(port)}
          style={{
            color: HUE.cyan,
            borderColor: withAlpha(HUE.cyan, 0.4),
            background: withAlpha(HUE.cyan, 0.08),
            cursor: "default",
          }}
        >
          {portLabel(port)}
        </span>
      ))}
    </div>
  );
}

/** Edge reach: one plain line + compact port chips. */
export function EdgeCapabilitySection({
  edge,
  fromNode,
  toNode,
}: {
  readonly edge: CanvasEdge;
  readonly fromNode: CanvasNode | undefined;
  readonly toNode: CanvasNode | undefined;
}) {
  const fromSpec = specOf(fromNode);
  const toSpec = specOf(toNode);
  const mask = readEdgePortMask(edge);
  const forward = effectivePorts(fromSpec, toSpec, mask);
  const fromLabel = fromNode ? nodeTitle(fromNode) : "This end";
  const toLabel = toNode ? nodeTitle(toNode) : "the other end";

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Allows</div>
      <div className="inspector-detail" style={{ marginBottom: forward.length > 0 ? 8 : 0 }}>
        What {fromLabel} may do to {toLabel}
      </div>
      {forward.length > 0 ? <PortChips ports={forward} /> : null}
    </div>
  );
}

/**
 * "Limit this key" — explicit port allow-list editor for `edge.ether.ports`.
 * Absent field means full default (every port the target offers); the mask
 * array, when present, is an explicit allow-list. Toggling a port off the
 * allow-list down to zero clears the field entirely — the editor can never
 * write `ports: []`, which would (under attenuation) grant nothing at all
 * instead of restoring the full default.
 */
/** Board megaphone membership — default on. */
export function EdgeBoardNotifyToggle({ edge }: { readonly edge: CanvasEdge }) {
  const doc = use$(state$.doc);
  const from = doc.nodes.find((n) => n.id === edge.fromNode);
  const to = doc.nodes.find((n) => n.id === edge.toNode);
  const touchesBoard =
    from?.ether?.entity?.kind === "board" || to?.ether?.entity?.kind === "board";
  if (!touchesBoard) return null;
  const on = edge.ether?.wake !== false;
  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Board wakes this agent</div>
      <button
        type="button"
        className="inspector-flag-toggle"
        aria-pressed={on}
        style={{
          color: on ? HUE.amber : "#68604a",
          borderColor: on ? withAlpha(HUE.amber, 0.5) : "rgba(237,230,218,.12)",
          background: on ? withAlpha(HUE.amber, 0.1) : "rgba(255,255,255,.02)",
        }}
        onClick={() => setEdgeNotify(edge.id, !on)}
      >
        {on ? "On" : "Off"}
      </button>
    </div>
  );
}

/** Human labels for port chips — never raw protocol tokens as the only text. */
const PORT_LABEL: Partial<Record<PortName, string>> = {
  "tasks.list": "List tasks",
  "tasks.create": "Create tasks",
  "tasks.claim": "Claim tasks",
  "tasks.update": "Update tasks",
  "msg.list": "List messages",
  "msg.send": "Send messages",
  "request.escalate": "Raise requests",
  "artifact.publish": "Publish artifacts",
  "browser.automate": "Drive browser",
  "board.list": "List board",
  "board.create_topic": "Create topics",
  "board.post": "Post to board",
  "board.mark_read": "Mark board read",
};

const portLabel = (port: PortName): string => PORT_LABEL[port] ?? port;

/** @deprecated cascade removed — no UI. */
export function EdgeRelayStateToggle(_props: { readonly edge: CanvasEdge }) {
  return null;
}

export function EdgePortsAttenuator({ edge }: { readonly edge: CanvasEdge }) {
  const doc = use$(state$.doc);
  const toNode = doc.nodes.find((n) => n.id === edge.toNode);
  const fromNode = doc.nodes.find((n) => n.id === edge.fromNode);
  // Direction-agnostic: non-actor end offers; actor–actor unions both.
  const targetSpec = specOf(toNode);
  const fromSpec = specOf(fromNode);
  const offerSet = offerPortsForAccessWire(
    roleOf(fromSpec),
    roleOf(targetSpec),
    offersOf(fromSpec),
    offersOf(targetSpec),
  );
  const offeredPorts = chipPortsFromOffers(offerSet) as PortName[];
  const mask = readEdgePortMask(edge);
  const active = mask ?? HashSet.empty<PortName>();

  const commit = (next: HashSet.HashSet<PortName>): void => {
    if (HashSet.size(next) === 0) {
      setEdgePorts(edge.id, undefined);
      return;
    }
    setEdgePorts(edge.id, [...next]);
  };

  const toggle = (port: PortName): void => {
    if (mask === undefined) {
      // Full default → allow-list with this port removed.
      commit(HashSet.remove(offerSet, port));
      return;
    }
    commit(
      HashSet.has(active, port)
        ? HashSet.remove(active, port)
        : HashSet.add(active, port),
    );
  };

  if (offeredPorts.length === 0) {
    return (
      <div className="inspector-section">
        <EdgeBoardNotifyToggle edge={edge} />
      </div>
    );
  }

  return (
    <div className="inspector-section">
      <EdgeBoardNotifyToggle edge={edge} />
      <div className="inspector-section__label">Permissions</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        {mask === undefined
          ? "Everything this side offers is allowed. Turn one off to limit."
          : "Only the highlighted actions are allowed."}
      </div>
      <div className="inspector-flags" role="list" aria-label="Permissions on this link">
        {offeredPorts.map((port) => {
          const isActive = mask === undefined || HashSet.has(active, port);
          return (
            <button
              key={port}
              type="button"
              role="listitem"
              aria-pressed={isActive}
              className="inspector-flag-toggle"
              title={port}
              style={{
                color: isActive ? HUE.cyan : "#68604a",
                borderColor: isActive ? withAlpha(HUE.cyan, 0.5) : "rgba(237,230,218,.12)",
                background: isActive ? withAlpha(HUE.cyan, 0.1) : "rgba(255,255,255,.02)",
              }}
              onClick={() => toggle(port)}
            >
              {portLabel(port)}
            </button>
          );
        })}
      </div>
      {mask !== undefined ? (
        <button
          type="button"
          className="inspector-flag-toggle"
          style={{ marginTop: 8 }}
          onClick={() => setEdgePorts(edge.id, undefined)}
        >
          Allow all again
        </button>
      ) : null}
    </div>
  );
}

type CapabilityNeighbor = {
  readonly id: string;
  readonly title: string;
  readonly role: FactoryRoleName;
  readonly kind: string | undefined;
  readonly ports: ReadonlyArray<PortName>;
};

/** Actor: "reaches"; sink: "reached by" — plain inventory, no physics lecture. */
export function NodeCapabilityInventory({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const selfSpec = useMemo(
    () => resolveSpec({ isGroup: isGroup(node), kind: node.ether?.entity?.kind }),
    [node],
  );
  const selfRole = roleOf(selfSpec);

  const inventory = useMemo(() => {
    if (selfRole !== "actor" && selfRole !== "sink") return null;
    const view = canvasDocToCapabilityView(doc);
    const selfId = asNodeId(node.id);
    const neighbors = HashMap.get(view.connected, selfId);
    if (Option.isNone(neighbors) || HashSet.size(neighbors.value) === 0) {
      return { role: selfRole, rows: [] as CapabilityNeighbor[] };
    }
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const rows: CapabilityNeighbor[] = [];
    for (const peerId of neighbors.value) {
      const peer = byId.get(peerId);
      if (!peer) continue;
      const peerSpec = resolveSpec({
        isGroup: isGroup(peer),
        kind: peer.ether?.entity?.kind,
      });
      const maskOpt = HashMap.get(view.edgePortMask, undirectedEdgeKey(node.id, peerId));
      const mask = Option.isSome(maskOpt) ? maskOpt.value : undefined;
      // Actor: outbound reach; sink: inbound callers only.
      const ports =
        selfRole === "actor"
          ? effectivePorts(selfSpec, peerSpec, mask)
          : effectivePorts(peerSpec, selfSpec, mask);
      if (selfRole === "sink" && roleOf(peerSpec) !== "actor") continue;
      rows.push({
        id: peerId,
        title: nodeTitle(peer),
        role: roleOf(peerSpec),
        kind: peer.ether?.entity?.kind,
        ports,
      });
    }
    rows.sort((a, b) => a.title.localeCompare(b.title));
    return { role: selfRole, rows };
  }, [doc, node, selfRole, selfSpec]);

  if (!inventory) return null;

  const label = inventory.role === "actor" ? "connected to" : "used by";

  if (inventory.rows.length === 0) return null;

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">{label}</div>
      <div className="inspector-bindings mt-2">
        {inventory.rows.map((row) => (
          <div key={row.id} className="inspector-binding" title={row.title}>
            <span className="inspector-binding__source">
              {row.kind ?? row.role}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.title}</span>
            {row.ports.length > 0 ? (
              <span style={{ color: HUE.cyan, flex: "0 1 auto" }}>
                {row.ports.map(portLabel).join(", ")}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const placementTone = (runtimeTag: "Cc" | "Station"): ChipTone =>
  runtimeTag === "Station" ? "cyan" : "amber";

/**
 * Placement chips — where the node runs, and nothing more. Placement is data:
 * it names the host, it never gates a port.
 */
export function NodePlacementSection({ node }: { readonly node: CanvasNode }) {
  const placement = useMemo(() => resolveNodePlacement(node), [node]);
  const label = placementLabel(placement);
  const assign = placement.assignment ?? "—";
  const tone = placementTone(placement.runtime._tag);
  const title = [
    placement.runtime._tag === "Station" ? "remote machine" : "command center",
    placement.assignment ? `host ${placement.assignment}` : "unassigned",
  ].join(" — ");

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">placement</div>
      <div className="inspector-flags" role="list" aria-label="Node placement" title={title}>
        <Chip tone={tone} title={`placement: ${label}`}>
          {label}
        </Chip>
        <Chip tone="steel" title={`assignment: ${assign}`}>
          {assign}
        </Chip>
      </div>
    </div>
  );
}

const FLAG_OPTIONS: ReadonlyArray<{ readonly flag: EtherFlag; readonly hue: string }> = [
  { flag: "blocker", hue: HUE.crimson },
  { flag: "attention", hue: HUE.amber },
  { flag: "parked", hue: HUE.violet },
];

export function NodeFieldEditors({ node }: { readonly node: CanvasNode }) {
  const textValue = node.type === "text" ? node.text : "";
  const groupLabelValue = node.type === "group" ? node.label ?? "" : "";
  const [textDraft, setTextDraft] = useState(textValue);
  const [groupLabelDraft, setGroupLabelDraft] = useState(groupLabelValue);
  const workRoleValue = node.ether?.workRole ?? "";
  const [workRoleDraft, setWorkRoleDraft] = useState(workRoleValue);
  // Work role is claim-routing on actor seats only — not sinks or furniture.
  const showWorkRole = node.ether?.entity?.kind === "agent";
  const knownWorkRoles = use$(() => workRolesInDoc(state$.doc.get()));

  useEffect(() => {
    setTextDraft(textValue);
    setGroupLabelDraft(groupLabelValue);
    setWorkRoleDraft(workRoleValue);
  }, [groupLabelValue, node.id, textValue, workRoleValue]);

  const commitText = () => { if (node.type === "text" && textDraft !== textValue) editText(node.id, textDraft); };
  const commitGroupLabel = () => { if (node.type === "group" && groupLabelDraft !== groupLabelValue) renameGroup(node.id, groupLabelDraft.trim()); };

  return <>
    {showWorkRole ? (
      <div className="inspector-editor">
        <span>work role - routes task claims</span>
        <input
          aria-label="Work role for claim routing"
          placeholder="type a role or pick below"
          list="work-role-options"
          value={workRoleDraft}
          onChange={(event) => setWorkRoleDraft(event.target.value)}
          onBlur={() => setNodeWorkRole(node.id, workRoleDraft || undefined)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setNodeWorkRole(node.id, workRoleDraft || undefined);
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setWorkRoleDraft(workRoleValue);
              event.currentTarget.blur();
            }
          }}
        />
        <datalist id="work-role-options">
          {knownWorkRoles.map((role) => (
            <option key={role} value={role} />
          ))}
        </datalist>
        {knownWorkRoles.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {knownWorkRoles.map((role) => {
              const active = role === workRoleValue;
              const hex = active ? HUE.amber : DIM;
              return (
                <button
                  key={role}
                  type="button"
                  title={active ? `Clear role ${role}` : `Assign role ${role}`}
                  className="inline-flex cursor-pointer items-center rounded-[3px] border px-1.5 py-0.5 text-[8px] leading-none tracking-[0.13em] uppercase select-none"
                  style={{
                    color: hex,
                    borderColor: withAlpha(hex, active ? 0.5 : 0.36),
                    background: withAlpha(hex, active ? 0.14 : 0.06),
                  }}
                  onClick={() => {
                    const next = active ? undefined : role;
                    setWorkRoleDraft(next ?? "");
                    setNodeWorkRole(node.id, next);
                  }}
                >
                  {role}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    ) : null}
    {/* Work sinks / schedulers rename via kind-strip pencil — no fat label field. */}
    {node.type === "text" &&
    node.ether?.entity?.kind !== "task" &&
    node.ether?.entity?.kind !== "requests" &&
    node.ether?.entity?.kind !== "artifacts" &&
    node.ether?.entity?.kind !== "board" &&
    node.ether?.entity?.kind !== "cron" &&
    node.ether?.entity?.kind !== "timer" &&
    node.ether?.entity?.kind !== "watcher" &&
    node.ether?.entity?.kind !== "relay" ? (
      <label className="inspector-editor">
        <span>{node.ether?.entity ? "label" : "note text"}</span>
        <textarea
          aria-label={node.ether?.entity ? "Node label" : "Note text"}
          value={textDraft}
          onChange={(event) => setTextDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setTextDraft(textValue);
              event.currentTarget.blur();
            }
          }}
        />
      </label>
    ) : null}
    {node.ether?.entity?.kind === "agent"
      ? <div className="inspector-section">
          <div className="inspector-section__label">machine</div>
          <div className="inspector-detail">
            This agent lives on its machine. To run one elsewhere, add a new agent there.
          </div>
        </div>
      : null}
    {node.type === "group" ? <label className="inspector-editor"><span>region label</span><input aria-label="Region label" value={groupLabelDraft} placeholder="unnamed region" onChange={(event) => setGroupLabelDraft(event.target.value)} onBlur={commitGroupLabel} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitGroupLabel(); event.currentTarget.blur(); } if (event.key === "Escape") { setGroupLabelDraft(groupLabelValue); event.currentTarget.blur(); } }} /></label> : null}
    {/* Region dense fields: kind-strip keys are preferred (briefing / herdr /
        page / paths). Hold stays on the command card; plate + placement are gone. */}
    {node.type === "group" ? <RegionHoldControl node={node} /> : null}
    {HERDR_ENABLED && node.type === "group" ? (
      <RegionHerdrDefaultsControl node={node} />
    ) : null}
    {node.type === "group" ? <RegionPageDefaultsControl node={node} /> : null}
    <KernelFieldEditors node={node} />
  </>;
}

/** Queue home host for a tasks sink — used from RTS kind strip pop. */
export function TaskQueueHomeControl({ node }: { readonly node: CanvasNode }) {
  const storedHost = resolveNodeHostId(node);
  return (
    <div className="inspector-section" style={{ marginTop: 0 }}>
      <div className="inspector-section__label">queue home</div>
      <label className="inspector-editor">
        <span>host for new tasks</span>
        <EnrolledHostSelect
          ariaLabel="Task queue home host"
          value={storedHost}
          onChange={(next) => setNodeHost(node.id, next)}
        />
      </label>
      <div className="inspector-detail">Existing tasks stay where they are.</div>
    </div>
  );
}

/** Host + profile for a page — used from RTS kind-strip pop. */
export function PageBindingControl({ node }: { readonly node: CanvasNode }) {
  const storedProfile = node.ether?.browser?.profile ?? "personal";
  const storedHost = resolveNodeHostId(node);
  const [profile, setProfile] = useState(storedProfile);
  const [host, setHost] = useState(storedHost);

  useEffect(() => {
    setProfile(storedProfile);
    setHost(storedHost);
  }, [node.id, storedHost, storedProfile]);

  const commit = (nextProfile = profile, nextHost = host) => {
    setPageBinding(node.id, { profile: nextProfile, host: nextHost });
  };

  return (
    <div className="inspector-section" style={{ marginTop: 0 }}>
      <div className="inspector-section__label">browser binding</div>
      <label className="inspector-editor">
        <span>host</span>
        <EnrolledHostSelect
          ariaLabel="Page browser host"
          value={host}
          capability="browser"
          onChange={(next) => {
            setHost(next);
            commit(profile, next);
          }}
        />
      </label>
      <label className="inspector-editor">
        <span>profile</span>
        <BrowserProfileSelect
          ariaLabel="Page browser profile"
          value={profile}
          onChange={(next) => {
            setProfile(next);
            commit(next, host);
          }}
        />
      </label>
    </div>
  );
}

/** Page URL — used from RTS kind-strip pop. */
export function PageUrlControl({ node }: { readonly node: CanvasNode }) {
  const url = node.type === "link" ? node.url : "";
  const [draft, setDraft] = useState(url);
  useEffect(() => {
    setDraft(url);
  }, [node.id, url]);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === url || node.type !== "link") return;
    editLink(node.id, next);
  };
  return (
    <div className="inspector-section" style={{ marginTop: 0 }}>
      <div className="inspector-section__label">page url</div>
      <label className="inspector-editor">
        <span>url</span>
        <input
          aria-label="Page URL"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(url);
              event.currentTarget.blur();
            }
          }}
        />
      </label>
    </div>
  );
}

// Watcher/timer/region briefing editors, grouped behind one call so the
// switchboard above reads as one branch per concern instead of three more
// node-type ternaries stacked onto an already-dense dispatcher.
function KernelFieldEditors({ node }: { readonly node: CanvasNode }) {
  const kind = node.ether?.entity?.kind;
  return <>
    {node.type === "group" ? <RegionBriefingEditor node={node} /> : null}
    {kind === "watcher" ? <WatcherEditor node={node} /> : null}
    {kind === "timer" || kind === "cron" ? <TimerEditor node={node} /> : null}
    {kind === "relay" ? <RelayEditor node={node} /> : null}

    {kind === "agent" ? <AgentMessagesPane node={node} /> : null}
  </>;
}

function EdgeEffectEditor({
  edgeId,
  fromNode,
  toNode,
}: {
  readonly edgeId: string;
  readonly fromNode: CanvasNode | undefined;
  readonly toNode: CanvasNode | undefined;
}) {
  const doc = use$(state$.doc);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  const effect = edge?.ether?.does;
  const fromIsScheduler = isSchedulerEntityKind(fromNode?.ether?.entity?.kind);
  if (!fromIsScheduler) return null;

  const mode = effect?.mode ?? "none";
  const brief =
    effect && effect.mode === "enqueue_task"
      ? effect.brief
      : fromNode?.type === "text"
        ? fromNode.text
        : "";

  const setMode = (next: "none" | "enqueue_task" | "set_flag") => {
    if (next === "none") {
      setEdgeEffect(edgeId, undefined);
      return;
    }
    if (next === "enqueue_task") {
      setEdgeEffect(edgeId, {
        mode: "enqueue_task",
        brief: brief.trim() || "Scheduled work",
        reason: "scheduler",
      });
      return;
    }
    setEdgeEffect(edgeId, {
      mode: "set_flag",
      flag: "attention",
      enabled: true,
    });
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">When it fires</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        Applied to {toNode ? nodeTitle(toNode) : "the other end"}
      </div>
      <label className="inspector-editor">
        <span>Action</span>
        <Select
          dense
          aria-label="Action when this fires"
          value={mode}
          options={[
            { value: "none", label: "Do nothing" },
            { value: "enqueue_task", label: "Add a task" },
            { value: "set_flag", label: "Set a flag" },
          ]}
          onChange={(value) => setMode(value as "none" | "enqueue_task" | "set_flag")}
        />
      </label>
      {effect?.mode === "enqueue_task" ? (
        <label className="inspector-editor">
          <span>Task brief</span>
          <input
            aria-label="Task brief"
            value={effect.brief}
            onChange={(event) =>
              setEdgeEffect(edgeId, {
                mode: "enqueue_task",
                brief: event.target.value,
                reason: effect.reason ?? "scheduler",
              })
            }
          />
        </label>
      ) : null}
      {effect?.mode === "set_flag" ? (
        <label className="inspector-editor">
          <span>Flag</span>
          <Select
            dense
            aria-label="Flag to set"
            value={effect.flag}
            options={[
              { value: "blocker", label: "Blocker" },
              { value: "attention", label: "Needs attention" },
              { value: "parked", label: "Parked" },
            ]}
            onChange={(value) =>
              setEdgeEffect(edgeId, {
                mode: "set_flag",
                flag: value as EtherFlag,
                enabled: effect.enabled,
              })
            }
          />
        </label>
      ) : null}
    </div>
  );
}

function EdgeWhenEditor({
  edgeId,
  toNode,
}: {
  readonly edgeId: string;
  readonly toNode: CanvasNode | undefined;
}) {
  const doc = use$(state$.doc);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  const when = edge?.ether?.when;
  // Only relay consumes watch — cron/gauge show no when editor.
  if (toNode?.ether?.entity?.kind !== "relay") return null;

  const value =
    when?.word === "flagged"
      ? `flagged:${when.flag}`
      : when?.word === "completes"
        ? "completes"
        : "none";

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Watch for</div>
      <label className="inspector-editor">
        <span>Condition</span>
        <Select
          dense
          aria-label="Condition that fires this relay"
          value={value}
          options={[
            { value: "none", label: "Not set" },
            { value: "completes", label: "A task completes" },
            { value: "flagged:attention", label: "Marked needs attention" },
            { value: "flagged:blocker", label: "Marked blocker" },
            { value: "flagged:parked", label: "Marked parked" },
          ]}
          onChange={(next) => {
            if (next === "none") {
              setEdgeWhen(edgeId, undefined);
              return;
            }
            if (next === "completes") {
              setEdgeWhen(edgeId, { word: "completes" });
              return;
            }
            const flag = next.replace("flagged:", "") as EtherFlag;
            setEdgeWhen(edgeId, { word: "flagged", flag });
          }}
        />
      </label>
    </div>
  );
}

export function EdgeCriteriaEditor({
  edgeId,
  fromNode,
  livePhase: _livePhase,
  liveDetail: _liveDetail,
}: {
  readonly edgeId: string;
  readonly fromNode: CanvasNode | undefined;
  readonly livePhase?: string;
  readonly liveDetail?: string;
}) {
  const doc = use$(state$.doc);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  const criteria = edge?.ether?.stops;
  const toNode = doc.nodes.find((node) => node.id === edge?.toNode);
  const fromKind = fromNode?.ether?.entity?.kind;
  const fromIsTask = fromKind === "task" || fromKind === "requests";

  type AuthoringMode = "none" | "tasks";
  const mode: AuthoringMode = criteria?.mode === "tasks" ? "tasks" : "none";
  const showStops = fromIsTask || criteria?.mode === "tasks";

  return (
    <>
      <EdgeWhenEditor edgeId={edgeId} toNode={toNode} />
      <EdgeEffectEditor edgeId={edgeId} fromNode={fromNode} toNode={toNode} />
      {showStops ? (
        <div className="inspector-section">
          <div className="inspector-section__label">Blocks the agent</div>
          <label className="inspector-editor">
            <span>When</span>
            <Select
              dense
              aria-label="When this link blocks the agent"
              value={mode}
              options={[
                { value: "none", label: "Never" },
                { value: "tasks", label: "Work needs input" },
              ]}
              onChange={(value) => {
                if (value === "none") setEdgeCriteria(edgeId, undefined);
                else setEdgeCriteria(edgeId, { mode: "tasks" });
              }}
            />
          </label>
        </div>
      ) : null}
    </>
  );
}

// Region hold (group nodes only): a structural container whose contents
// travel with it when dragged. Membership is derived from geometry at drag
// time — this toggle only ever writes the boolean flag, never a member list.
// Prefer the command-bar Hold key; this control remains for form surfaces.
export function RegionHoldControl({ node }: { readonly node: CanvasNode }) {
  const hold = Boolean(node.ether?.region?.hold);
  return <div className="inspector-section">
    <div className="inspector-section__label">region</div>
    <div className="inspector-flags">
      <button
        type="button"
        className="inspector-flag-toggle"
        aria-label="Hold contents"
        aria-pressed={hold}
        style={{ color: hold ? HUE.amber : "#68604a", borderColor: hold ? withAlpha(HUE.amber, 0.5) : "rgba(237,230,218,.12)", background: hold ? withAlpha(HUE.amber, 0.1) : "rgba(255,255,255,.02)" }}
        onClick={() => setRegionHold(node.id, !hold)}
      >hold contents</button>
    </div>
  </div>;
}

/** Defaults for new herdr nodes created inside this region. Paths are separate. */
export function RegionHerdrDefaultsControl({ node }: { readonly node: CanvasNode }) {
  const stored = node.ether?.region?.defaults;
  const storedHost = stored?.herdr?.host ?? "";
  const [host, setHost] = useState(storedHost);
  const [session, setSession] = useState(
    stored?.herdr?.session === null ? "default" : (stored?.herdr?.session ?? ""),
  );
  const [workspaceId, setWorkspaceId] = useState(stored?.herdr?.workspaceId ?? "");
  const [tabId, setTabId] = useState(stored?.herdr?.tabId ?? "");
  useEffect(() => {
    setHost(storedHost);
    setSession(stored?.herdr?.session === null ? "default" : (stored?.herdr?.session ?? ""));
    setWorkspaceId(stored?.herdr?.workspaceId ?? "");
    setTabId(stored?.herdr?.tabId ?? "");
  }, [node.id, storedHost, stored?.herdr?.session, stored?.herdr?.workspaceId, stored?.herdr?.tabId]);

  const writeHerdr = (
    nextHost: string,
    nextSession: string,
    nextWorkspace: string,
    nextTab: string,
  ) => {
    const hostTrim = nextHost.trim();
    const sessionTrim = nextSession.trim();
    let sessionValue: string | null | undefined;
    if (hostTrim) {
      if (!sessionTrim || sessionTrim === "default") sessionValue = null;
      else sessionValue = sessionTrim;
    }
    const paths = stored?.paths;
    const page = stored?.page;
    const herdr = hostTrim
      ? {
          host: hostTrim,
          session: sessionValue ?? null,
          ...(nextWorkspace.trim() ? { workspaceId: nextWorkspace.trim() } : {}),
          ...(nextTab.trim() ? { tabId: nextTab.trim() } : {}),
        }
      : undefined;
    const next: EtherRegionDefaults = {
      ...(herdr ? { herdr } : {}),
      ...(page ? { page } : {}),
      ...(paths && Object.keys(paths).length > 0 ? { paths } : {}),
    };
    setRegionDefaults(node.id, Object.keys(next).length > 0 ? next : undefined);
  };

  const commit = () => writeHerdr(host, session, workspaceId, tabId);

  const clearHerdr = () => {
    setHost("");
    setSession("");
    setWorkspaceId("");
    setTabId("");
    writeHerdr("", "", "", "");
  };

  const onEnter = commitOnEnter(commit);
  const hasHerdrDefaults = Boolean(stored?.herdr?.host);

  return (
    <div className="inspector-section">
      <div className="inspector-detail mb-1">
        Applied when a new herdr node is created inside this region. Edit the node after create to override.
      </div>
      <label className="inspector-editor">
        <span>host</span>
        <EnrolledHostSelect
          ariaLabel="Region herdr host default"
          value={host}
          onChange={(next) => {
            setHost(next);
            writeHerdr(next, session, workspaceId, tabId);
          }}
        />
      </label>
      <label className="inspector-editor">
        <span>session</span>
        <input
          aria-label="Region herdr session default"
          value={session}
          placeholder="default (unnamed)"
          onChange={(e) => setSession(e.target.value)}
          onBlur={commit}
          onKeyDown={onEnter}
        />
      </label>
      <label className="inspector-editor">
        <span>workspace id</span>
        <input
          aria-label="Region herdr workspace default"
          value={workspaceId}
          placeholder="workspace id from herdr"
          onChange={(e) => setWorkspaceId(e.target.value)}
          onBlur={commit}
          onKeyDown={onEnter}
        />
      </label>
      <label className="inspector-editor">
        <span>tab id</span>
        <input
          aria-label="Region herdr tab default"
          value={tabId}
          placeholder="optional tab id"
          onChange={(e) => setTabId(e.target.value)}
          onBlur={commit}
          onKeyDown={onEnter}
        />
      </label>
      {hasHerdrDefaults ? (
        <div className="inspector-flags" style={{ marginTop: 14 }}>
          <button type="button" className="inspector-flag-toggle" onClick={clearHerdr}>
            clear herdr defaults
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Defaults for new page nodes created inside this region. */
export function RegionPageDefaultsControl({ node }: { readonly node: CanvasNode }) {
  const stored = node.ether?.region?.defaults;
  const [pageUrl, setPageUrl] = useState(stored?.page?.url ?? "");
  const [pageProfile, setPageProfile] = useState(stored?.page?.profile ?? "");
  const [pageHost, setPageHost] = useState(stored?.page?.host ?? "");

  useEffect(() => {
    setPageUrl(stored?.page?.url ?? "");
    setPageProfile(stored?.page?.profile ?? "");
    setPageHost(stored?.page?.host ?? "");
  }, [node.id, stored?.page?.url, stored?.page?.profile, stored?.page?.host]);

  const writePage = (url: string, profile: string, host: string) => {
    const paths = stored?.paths;
    const herdr = stored?.herdr;
    const page =
      url.trim() || profile.trim() || host.trim()
        ? {
            ...(url.trim() ? { url: url.trim() } : {}),
            ...(profile.trim() ? { profile: profile.trim() } : {}),
            ...(host.trim() ? { host: host.trim() } : {}),
          }
        : undefined;
    const next: EtherRegionDefaults = {
      ...(herdr ? { herdr } : {}),
      ...(page ? { page } : {}),
      ...(paths && Object.keys(paths).length > 0 ? { paths } : {}),
    };
    setRegionDefaults(node.id, Object.keys(next).length > 0 ? next : undefined);
  };

  const commit = () => writePage(pageUrl, pageProfile, pageHost);

  const clearPage = () => {
    setPageUrl("");
    setPageProfile("");
    setPageHost("");
    writePage("", "", "");
  };

  const onEnter = commitOnEnter(commit);
  const hasPageDefaults = Boolean(
    stored?.page?.url || stored?.page?.profile || stored?.page?.host,
  );

  return (
    <div className="inspector-section">
      <div className="inspector-detail mb-1">
        Applied when a new page node is created inside this region. Edit the node after create to override.
      </div>
      <label className="inspector-editor">
        <span>url</span>
        <input
          aria-label="Region page url default"
          value={pageUrl}
          placeholder="https://…"
          onChange={(e) => setPageUrl(e.target.value)}
          onBlur={commit}
          onKeyDown={onEnter}
        />
      </label>
      <label className="inspector-editor">
        <span>profile</span>
        <BrowserProfileSelect
          ariaLabel="Region page profile default"
          value={pageProfile}
          allowNone
          onChange={(next) => {
            setPageProfile(next);
            writePage(pageUrl, next, pageHost);
          }}
        />
      </label>
      <label className="inspector-editor">
        <span>host</span>
        <EnrolledHostSelect
          ariaLabel="Region page browser host default"
          value={pageHost}
          capability="browser"
          onChange={(next) => {
            setPageHost(next);
            writePage(pageUrl, pageProfile, next);
          }}
        />
      </label>
      {hasPageDefaults ? (
        <div className="inspector-flags" style={{ marginTop: 14 }}>
          <button type="button" className="inspector-flag-toggle" onClick={clearPage}>
            clear page defaults
          </button>
        </div>
      ) : null}
    </div>
  );
}

const withoutKey = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

// Region briefing (ether.region.instruction) — operator context for agents
// inside the group. Work-control `onboard` returns it via containingRegion;
// nothing auto-injects it into agent turns.
// Writes via commitDoc rather than a lib/mutations.ts export — same strip
// pattern as setRegionHold.
const commitRegionInstruction = (node: CanvasNode, instruction: string): void => {
  const trimmed = instruction.trim();
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== node.id) return n;
      if (trimmed) {
        return { ...n, ether: { ...(n.ether ?? {}), region: { ...(n.ether?.region ?? {}), instruction: trimmed } } };
      }
      if (!n.ether?.region) return n;
      const nextRegion = withoutKey(n.ether.region, "instruction");
      const nextEther = Object.keys(nextRegion).length ? { ...n.ether, region: nextRegion } : withoutKey(n.ether, "region");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : withoutKey(n, "ether")) as CanvasNode;
    }),
  });
};

/**
 * Region briefing — context agents receive on onboard.
 * Single copy line; large editor; CLI refs use first-class amber mono.
 */
export function RegionBriefingEditor({ node }: { readonly node: CanvasNode }) {
  const instructionValue = node.ether?.region?.instruction ?? "";
  const [instructionDraft, setInstructionDraft] = useState(instructionValue);

  useEffect(() => {
    setInstructionDraft(instructionValue);
  }, [node.id, instructionValue]);

  const commitInstruction = () => {
    if (instructionDraft === instructionValue) return;
    commitRegionInstruction(node, instructionDraft);
  };

  return (
    <div className="region-briefing">
      <p className="region-briefing__hint">
        Agents receive this from the{" "}
        <span className="cli-cmd">onboard</span>
        {" "}command inside the region.
      </p>
      <textarea
        className="region-briefing__editor"
        aria-label="Region briefing"
        placeholder="What should agents inside this region know?"
        value={instructionDraft}
        onChange={(event) => setInstructionDraft(event.target.value)}
        onBlur={commitInstruction}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setInstructionDraft(instructionValue);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

const STAT_SOURCE_OPTIONS: ReadonlyArray<NonNullable<EtherWatch["source"]>> = ["hermes"];

const STAT_OP_OPTIONS: ReadonlyArray<{ readonly value: NonNullable<EtherWatch["op"]>; readonly label: string }> = [
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "eq", label: "equal to" },
];

// Enter commits and blurs; every text field below shares this handler.
const commitOnEnter = (onCommit: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  onCommit();
  event.currentTarget.blur();
};

// stat_threshold: numeric comparison on a bound hermes entity's stat.
// Selects commit immediately (onSourceChange/onOpChange carry the override
// into the same commit call — React state from setSource/setOp wouldn't be
// flushed yet if commit() read it directly); text fields commit on blur.
function StatThresholdFields({ source, entityKey, stat, op, valueText, onSourceChange, onKey, onStat, onOpChange, onValue, onCommit }: {
  readonly source: NonNullable<EtherWatch["source"]>;
  readonly entityKey: string;
  readonly stat: string;
  readonly op: NonNullable<EtherWatch["op"]>;
  readonly valueText: string;
  readonly onSourceChange: (value: NonNullable<EtherWatch["source"]>) => void;
  readonly onKey: (value: string) => void;
  readonly onStat: (value: string) => void;
  readonly onOpChange: (value: NonNullable<EtherWatch["op"]>) => void;
  readonly onValue: (value: string) => void;
  readonly onCommit: () => void;
}) {
  const onEnter = commitOnEnter(onCommit);
  return <>
    <label className="inspector-editor">
      <span>source</span>
      <Select
        dense
        aria-label="Watcher stat source"
        value={source}
        options={STAT_SOURCE_OPTIONS.map((s) => ({ value: s, label: s }))}
        onChange={(value) => onSourceChange(value as NonNullable<EtherWatch["source"]>)}
      />
    </label>
    <label className="inspector-editor">
      <span>key</span>
      <input aria-label="Watcher entity key" value={entityKey} placeholder="bound entity key" onChange={(event) => onKey(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>stat</span>
      <input aria-label="Watcher stat name" value={stat} placeholder="e.g. signals" onChange={(event) => onStat(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>op</span>
      <Select
        dense
        aria-label="Watcher comparison"
        value={op}
        options={STAT_OP_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onChange={(value) => onOpChange(value as NonNullable<EtherWatch["op"]>)}
      />
    </label>
    <label className="inspector-editor">
      <span>value</span>
      <input aria-label="Watcher threshold value" type="number" value={valueText} onChange={(event) => onValue(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
  </>;
}

// Every watch field's draft state, reset together whenever the inspected
// node changes — split out of WatcherEditor so the component body reads as
// "fields + commit", not a wall of useState declarations.
function useWatchDraft(nodeId: string, watch: EtherWatch | undefined) {
  const [source, setSource] = useState<NonNullable<EtherWatch["source"]>>(watch?.source ?? "hermes");
  const [key, setKey] = useState(watch?.key ?? "");
  const [stat, setStat] = useState(watch?.stat ?? "");
  const [op, setOp] = useState<NonNullable<EtherWatch["op"]>>(watch?.op ?? "gt");
  const [valueText, setValueText] = useState(watch?.value !== undefined ? String(watch.value) : "");
  const [flagOnUnsatisfied, setFlagOnUnsatisfied] = useState(Boolean(watch?.flagOnUnsatisfied));

  useEffect(() => {
    setSource(watch?.source ?? "hermes");
    setKey(watch?.key ?? "");
    setStat(watch?.stat ?? "");
    setOp(watch?.op ?? "gt");
    setValueText(watch?.value !== undefined ? String(watch.value) : "");
    setFlagOnUnsatisfied(Boolean(watch?.flagOnUnsatisfied));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset drafts only on node identity change, not on every keystroke into watch/*
  }, [nodeId]);

  return {
    source, setSource, key, setKey, stat, setStat, op, setOp,
    valueText, setValueText, flagOnUnsatisfied, setFlagOnUnsatisfied,
  };
}

// Gauge editor: hermes stat_threshold.
export function WatcherEditor({ node }: { readonly node: CanvasNode }) {
  const watch = node.ether?.watch;
  const {
    source, setSource, key, setKey, stat, setStat, op, setOp,
    valueText, setValueText, flagOnUnsatisfied, setFlagOnUnsatisfied,
  } = useWatchDraft(node.id, watch);

  type Overrides = Partial<{
    readonly source: NonNullable<EtherWatch["source"]>;
    readonly op: NonNullable<EtherWatch["op"]>;
    readonly flagOnUnsatisfied: boolean;
  }>;

  const commit = (overrides: Overrides = {}) => {
    const nextSource = overrides.source ?? source;
    const nextOp = overrides.op ?? op;
    const nextFlag = overrides.flagOnUnsatisfied ?? flagOnUnsatisfied;
    const parsedValue = valueText.trim() === "" ? undefined : Number(valueText);
    const nextWatch: EtherWatch = {
      kind: "stat_threshold",
      source: nextSource,
      ...(key.trim() ? { key: key.trim() } : {}),
      ...(stat.trim() ? { stat: stat.trim() } : {}),
      op: nextOp,
      ...(parsedValue !== undefined && Number.isFinite(parsedValue) ? { value: parsedValue } : {}),
      ...(nextFlag ? { flagOnUnsatisfied: true } : {}),
    };
    setNodeWatch(node.id, nextWatch);
  };

  return <div className="inspector-section">
    <div className="inspector-section__label">gauge - hermes threshold</div>
    <StatThresholdFields
      source={source}
      entityKey={key}
      stat={stat}
      op={op}
      valueText={valueText}
      onSourceChange={(next) => { setSource(next); commit({ source: next }); }}
      onKey={setKey}
      onStat={setStat}
      onOpChange={(next) => { setOp(next); commit({ op: next }); }}
      onValue={setValueText}
      onCommit={() => commit()}
    />
    <div className="inspector-flags mt-2">
      <button
        type="button"
        className="inspector-flag-toggle"
        aria-label="Flag when unsatisfied"
        aria-pressed={flagOnUnsatisfied}
        style={{ color: flagOnUnsatisfied ? HUE.crimson : "#68604a", borderColor: flagOnUnsatisfied ? withAlpha(HUE.crimson, 0.5) : "rgba(237,230,218,.12)", background: flagOnUnsatisfied ? withAlpha(HUE.crimson, 0.1) : "rgba(255,255,255,.02)" }}
        onClick={() => { const next = !flagOnUnsatisfied; setFlagOnUnsatisfied(next); commit({ flagOnUnsatisfied: next }); }}
      >flag when unsatisfied</button>
    </div>
  </div>;
}

/** Relay binding is the drawn links only. */
export function RelayEditor({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const inbound = doc.edges.filter((edge) => edge.toNode === node.id);
  const outbound = doc.edges.filter(
    (edge) => edge.fromNode === node.id && edge.ether?.does,
  );
  const watchLine =
    inbound.length === 0
      ? "Not watching anything yet"
      : inbound
          .map((edge) => {
            const src = doc.nodes.find((n) => n.id === edge.fromNode);
            const name = src ? nodeTitle(src) : "a connected node";
            const when = edge.ether?.when;
            const word =
              when?.word === "flagged" ? `flagged ${when.flag}` : "completes";
            return `${name} ${word}`;
          })
          .join("; ");
  const effectLine =
    outbound.length === 0
      ? "Does nothing yet"
      : `${outbound.length} action${outbound.length === 1 ? "" : "s"} when it fires`;

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Relay</div>
      <div className="text-[11px] leading-snug" style={{ color: INK }}>
        Watches: {watchLine}
      </div>
      <div className="mt-1 text-[11px] leading-snug" style={{ color: DIM }}>
        Then: {effectLine}
      </div>
    </div>
  );
}

// Compact expression strip — full human schedule is CronScheduleSurface.
export function TimerEditor({ node }: { readonly node: CanvasNode }) {
  const timer = node.ether?.timer;
  const defaultExpr =
    timer?.expression?.trim() ||
    (typeof timer?.everyMinutes === "number" && timer.everyMinutes > 0
      ? `*/${Math.round(timer.everyMinutes)} * * * *`
      : "*/30 * * * *");
  const [draft, setDraft] = useState(defaultExpr);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(
      timer?.expression?.trim() ||
        (typeof timer?.everyMinutes === "number" && timer.everyMinutes > 0
          ? `*/${Math.round(timer.everyMinutes)} * * * *`
          : "*/30 * * * *"),
    );
    setError("");
  }, [node.id, timer?.expression, timer?.everyMinutes]);

  const commit = () => {
    const cleaned = draft.trim().replace(/\s+/g, " ");
    if (!isValidCronExpression(cleaned)) {
      setError("invalid expression");
      return;
    }
    setError("");
    setNodeTimer(node.id, { expression: cleaned });
  };

  return (
    <div className="inspector-section" style={{ marginTop: 0 }}>
      <div className="inspector-section__label">schedule</div>
      <div className="mb-1.5 text-[11px]" style={{ color: INK }}>
        {describeCronExpression(draft)}
      </div>
      <label className="inspector-editor">
        <span>expression</span>
        <input
          aria-label="Cron expression"
          className="font-mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(defaultExpr);
              setError("");
              event.currentTarget.blur();
            }
          }}
          spellCheck={false}
        />
      </label>
      {error ? (
        <div className="mt-1 text-[9px]" style={{ color: withAlpha(HUE.crimson, 0.8) }}>
          {error}
        </div>
      ) : (
        <div className="mt-1 text-[9px]" style={{ color: DIM }}>
          double-click card for presets
        </div>
      )}
    </div>
  );
}

export function NodeFlagControls({ node }: { readonly node: CanvasNode }) {
  const flags = node.ether?.flags ?? [];
  return <div className="inspector-section"><div className="inspector-section__label"><Flag size={11} /> flags</div><div className="inspector-flags">{FLAG_OPTIONS.map(({ flag, hue }) => { const active = flags.includes(flag); return <button key={flag} type="button" className="inspector-flag-toggle" aria-pressed={active} style={{ color: active ? hue : "#68604a", borderColor: active ? withAlpha(hue, 0.5) : "rgba(237,230,218,.12)", background: active ? withAlpha(hue, 0.1) : "rgba(255,255,255,.02)" }} onClick={() => toggleFlag(node.id, flag)}>{flag}</button>; })}</div></div>;
}

export function ConnectEditor({ node, doc, open, onOpenChange }: { readonly node: CanvasNode; readonly doc: CanvasDoc; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const [targetId, setTargetId] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const targets = doc.nodes.filter((candidate) => candidate.id !== node.id && candidate.type !== "group");
  const availableTargets = targets.filter((target) => !doc.edges.some((edge) => edge.fromNode === node.id && edge.toNode === target.id));
  const filteredTargets = availableTargets.filter((target) => !targetQuery.trim() || searchText(target).includes(targetQuery.trim().toLowerCase()));
  const kind = node.ether?.entity?.kind;
  const fromIsTask = kind === "task" || kind === "requests";
  const connect = () => {
    if (!targetId) return;
    // Criteria inferred from source (tasks/requests → tasks criteria).
    addEdge({ source: node.id, target: targetId });
    setTargetId("");
    setTargetQuery("");
    onOpenChange(false);
  };
  if (!open) return null;
  return (
    <div className="inspector-connect">
      <label>
        <span>
          find a node <em>{filteredTargets.length}/{availableTargets.length}</em>
        </span>
        <input
          aria-label="Find a node"
          value={targetQuery}
          onChange={(event) => setTargetQuery(event.target.value)}
          placeholder="name, source, or binding"
        />
      </label>
      {availableTargets.length === 0 ? (
        <div className="inspector-connect__empty">No unlinked nodes available.</div>
      ) : filteredTargets.length === 0 ? (
        <div className="inspector-connect__empty">No nodes match this filter.</div>
      ) : (
        <label>
          <span>connect to</span>
          <Select
            dense
            aria-label="Connect to node"
            value={targetId}
            placeholder="choose a node"
            options={[
              { value: "", label: "choose a node" },
              ...filteredTargets.map((target) => ({
                value: target.id,
                label: `${nodeTitle(target)} - ${target.ether?.entity?.kind ?? target.type}`,
              })),
            ]}
            onChange={setTargetId}
          />
        </label>
      )}
      <div className="inspector-detail">
        {fromIsTask
          ? "Work on this lane pauses its agent while a task waits on you."
          : "Draw the wire, then open it to set what it allows."}
      </div>
      <button disabled={!targetId} onClick={connect}>
        create edge
      </button>
    </div>
  );
}
