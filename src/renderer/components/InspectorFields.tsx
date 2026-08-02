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
  EtherRelay,
  EtherWatch,
} from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { workRolesInDoc } from "@shared/attention";
import {
  ALL_PORTS,
  Port,
  asNodeId,
  canvasDocToCapabilityView,
  grantLawForRoles,
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
  setEdgeRelayState,
} from "../lib/edge-mutations";
import { specOf } from "../lib/node-spec";
import { commitDoc, editFileDetails, editGroupBackground, editLink, editText, renameGroup, setNodeHost, setNodeRelay, setNodeTimer, setNodeWatch, setNodeWorkRole, setPageBinding, setRegionDefaults, setRegionHold, toggleFlag } from "../lib/mutations";
import { isSchedulerEntityKind } from "@shared/scheduler-effects";
import { AgentMessagesPane } from "./work/WorkSurfaces";
import { state$ } from "../lib/state";
import { resolveNodeHostId } from "@shared/station";
import { DIM, HUE, INK, withAlpha } from "../lib/theme";
import { nodeTitle, searchText } from "../lib/presentation";
import { Chip, Select, type ChipTone } from "./ui";

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
  return ALL_PORTS.filter((port) => grant.allows(port, offers));
};

function PortChips({ ports }: { readonly ports: ReadonlyArray<PortName> }) {
  if (ports.length === 0) {
    return <div className="inspector-detail">no ports granted</div>;
  }
  return (
    <div className="inspector-flags" role="list" aria-label="Granted ports">
      {ports.map((port) => (
        <span
          key={port}
          role="listitem"
          className="inspector-flag-toggle"
          title={port}
          style={{
            color: HUE.cyan,
            borderColor: withAlpha(HUE.cyan, 0.4),
            background: withAlpha(HUE.cyan, 0.08),
            cursor: "default",
          }}
        >
          {port}
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
  const fromLabel = fromNode ? nodeTitle(fromNode) : edge.fromNode;
  const toLabel = toNode ? nodeTitle(toNode) : edge.toNode;
  const portsNote = forward.length > 0 ? ` · ${forward.join(" · ")}` : "";

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">reach</div>
      <div className="inspector-detail" style={{ marginBottom: forward.length > 0 ? 8 : 0 }}>
        {fromLabel} can reach {toLabel}{portsNote}
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
/** Operator megaphone eligibility for agent↔board edges. Default ON. */
export function EdgeBoardNotifyToggle({ edge }: { readonly edge: CanvasEdge }) {
  const doc = use$(state$.doc);
  const from = doc.nodes.find((n) => n.id === edge.fromNode);
  const to = doc.nodes.find((n) => n.id === edge.toNode);
  const touchesBoard =
    from?.ether?.entity?.kind === "board" || to?.ether?.entity?.kind === "board";
  if (!touchesBoard) return null;
  // Absent / true = ON; only explicit false opts out.
  const on = edge.ether?.notify !== false;
  return (
    <div className="inspector-section">
      <div className="inspector-section__label">board wake</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        On by default when connected — this seat is in the board megaphone set
        (operator Post topic / Notify all). Turn OFF to silence. Not a capability
        port.
      </div>
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
        Notify {on ? "ON" : "OFF"}
      </button>
    </div>
  );
}

/**
 * Opt-in actor↔actor stoppage relay. Default OFF.
 * Only shown when both endpoints are blockable actors.
 */
export function EdgeRelayStateToggle({ edge }: { readonly edge: CanvasEdge }) {
  const doc = use$(state$.doc);
  const from = doc.nodes.find((n) => n.id === edge.fromNode);
  const to = doc.nodes.find((n) => n.id === edge.toNode);
  const fromActor = roleOf(specOf(from)) === "actor";
  const toActor = roleOf(specOf(to)) === "actor";
  if (!fromActor || !toActor) return null;
  const on = edge.ether?.relayState === true;
  return (
    <div className="inspector-section">
      <div className="inspector-section__label">relay state</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        Off by default. When ON, a blocked actor on either end relays its
        stoppage and reason to the other — cascading along further relay edges.
        Not a capability port.
      </div>
      <button
        type="button"
        className="inspector-flag-toggle"
        aria-label="Toggle relay state"
        aria-pressed={on}
        style={{
          color: on ? HUE.crimson : "#68604a",
          borderColor: on ? withAlpha(HUE.crimson, 0.5) : "rgba(237,230,218,.12)",
          background: on ? withAlpha(HUE.crimson, 0.1) : "rgba(255,255,255,.02)",
        }}
        onClick={() => setEdgeRelayState(edge.id, !on)}
      >
        Relay state {on ? "ON" : "OFF"}
      </button>
    </div>
  );
}

export function EdgePortsAttenuator({ edge }: { readonly edge: CanvasEdge }) {
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
    commit(HashSet.has(active, port) ? HashSet.remove(active, port) : HashSet.add(active, port));
  };

  return (
    <div className="inspector-section">
      <EdgeBoardNotifyToggle edge={edge} />
      <EdgeRelayStateToggle edge={edge} />
      <div className="inspector-section__label">limit this key</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        {mask === undefined
          ? "Full default — every port the target offers. Toggle a port to start an explicit allow-list."
          : "Explicit allow-list. Toggling off the last port restores full default."}
      </div>
      <div className="inspector-flags" role="list" aria-label="Limit edge ports">
        {ALL_PORTS.map((port) => {
          const isActive = HashSet.has(active, port);
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
              {port}
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
          restore full default
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

  const label = inventory.role === "actor" ? "reaches" : "reached by";

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
                {row.ports.join(" · ")}
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
  ].join(" · ");

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
  const linkValue = node.type === "link" ? node.url : "";
  const groupLabelValue = node.type === "group" ? node.label ?? "" : "";
  const fileValue = node.type === "file" ? node.file : "";
  const subpathValue = node.type === "file" ? node.subpath ?? "" : "";
  const [textDraft, setTextDraft] = useState(textValue);
  const [linkDraft, setLinkDraft] = useState(linkValue);
  const [groupLabelDraft, setGroupLabelDraft] = useState(groupLabelValue);
  const [fileDraft, setFileDraft] = useState(fileValue);
  const [subpathDraft, setSubpathDraft] = useState(subpathValue);
  const workRoleValue = node.ether?.workRole ?? "";
  const [workRoleDraft, setWorkRoleDraft] = useState(workRoleValue);
  const showWorkRole =
    Boolean(node.ether?.entity) && node.ether?.entity?.kind !== "label";
  const knownWorkRoles = use$(() => workRolesInDoc(state$.doc.get()));

  useEffect(() => {
    setTextDraft(textValue);
    setLinkDraft(linkValue);
    setGroupLabelDraft(groupLabelValue);
    setFileDraft(fileValue);
    setSubpathDraft(subpathValue);
    setWorkRoleDraft(workRoleValue);
  }, [fileValue, groupLabelValue, linkValue, node.id, subpathValue, textValue, workRoleValue]);

  const commitText = () => { if (node.type === "text" && textDraft !== textValue) editText(node.id, textDraft); };
  const commitLink = () => { if (node.type === "link" && linkDraft.trim() && linkDraft.trim() !== linkValue) editLink(node.id, linkDraft.trim()); };
  const commitGroupLabel = () => { if (node.type === "group" && groupLabelDraft !== groupLabelValue) renameGroup(node.id, groupLabelDraft.trim()); };
  const commitFile = () => { if (node.type === "file") editFileDetails(node.id, fileDraft, subpathDraft); };

  return <>
    {showWorkRole ? (
      <div className="inspector-editor">
        <span>work role · routes task claims</span>
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
                  title={active ? "click to clear this role" : `assign role "${role}"`}
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
    {node.type === "text" ? <label className="inspector-editor"><span>{node.ether?.entity ? "label" : "note text"}</span><textarea aria-label={node.ether?.entity ? "Node label" : "Note text"} value={textDraft} onChange={(event) => setTextDraft(event.target.value)} onBlur={commitText} onKeyDown={(event) => { if (event.key === "Escape") { setTextDraft(textValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "link" ? <label className="inspector-editor"><span>web reference</span><input aria-label="Link URL" value={linkDraft} onChange={(event) => setLinkDraft(event.target.value)} onBlur={commitLink} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitLink(); event.currentTarget.blur(); } if (event.key === "Escape") { setLinkDraft(linkValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "link" && node.ether?.entity?.kind === "page"
      ? <PageBindingControl node={node} />
      : null}
    {node.ether?.entity?.kind === "task"
      ? <TaskQueueHomeControl node={node} />
      : null}
    {node.ether?.entity?.kind === "agent"
      ? <div className="inspector-section">
          <div className="inspector-section__label">actor placement</div>
          <div className="inspector-detail">
            This host is part of the actor seat identity. Create a new actor seat to move it.
          </div>
        </div>
      : null}
    {node.type === "group" ? <label className="inspector-editor"><span>region label</span><input aria-label="Region label" value={groupLabelDraft} placeholder="unnamed region" onChange={(event) => setGroupLabelDraft(event.target.value)} onBlur={commitGroupLabel} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitGroupLabel(); event.currentTarget.blur(); } if (event.key === "Escape") { setGroupLabelDraft(groupLabelValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "file" ? <div className="inspector-section"><div className="inspector-section__label">file reference</div><div className="inspector-file-fields"><label><span>path</span><input aria-label="File path" value={fileDraft} onChange={(event) => setFileDraft(event.target.value)} onBlur={commitFile} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitFile(); event.currentTarget.blur(); } if (event.key === "Escape") { setFileDraft(fileValue); event.currentTarget.blur(); } }} /></label><label><span>subpath</span><input aria-label="File subpath" value={subpathDraft} placeholder="#section or block" onChange={(event) => setSubpathDraft(event.target.value)} onBlur={commitFile} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitFile(); event.currentTarget.blur(); } if (event.key === "Escape") { setSubpathDraft(subpathValue); event.currentTarget.blur(); } }} /></label></div></div> : null}
    {/* Region dense fields: preferred entry is individual kind-strip keys
        (briefing / defaults / background / paths). Keep these for the legacy
        full form path and any non-RTS openers. */}
    {node.type === "group" ? <RegionBackgroundEditor node={node} /> : null}
    {node.type === "group" ? <RegionHoldControl node={node} /> : null}
    {node.type === "group" ? <RegionDefaultsControl node={node} /> : null}
    <KernelFieldEditors node={node} />
  </>;
}

/** Region background URL + fit — focused form body for the kind-strip key. */
export function RegionBackgroundEditor({ node }: { readonly node: CanvasNode }) {
  if (node.type !== "group") return null;
  const backgroundValue = node.background ?? "";
  const backgroundStyleValue = node.backgroundStyle ?? "cover";
  const [backgroundDraft, setBackgroundDraft] = useState(backgroundValue);
  const [backgroundStyleDraft, setBackgroundStyleDraft] = useState<"cover" | "ratio" | "repeat">(backgroundStyleValue);

  useEffect(() => {
    setBackgroundDraft(backgroundValue);
    setBackgroundStyleDraft(backgroundStyleValue);
  }, [node.id, backgroundValue, backgroundStyleValue]);

  const commitBackground = (background = backgroundDraft, style = backgroundStyleDraft) => {
    editGroupBackground(node.id, background, style);
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">background</div>
      <div className="inspector-background">
        <input
          aria-label="Region background source"
          value={backgroundDraft}
          placeholder="image URL or file path"
          onChange={(event) => setBackgroundDraft(event.target.value)}
          onBlur={() => commitBackground()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitBackground();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setBackgroundDraft(backgroundValue);
              event.currentTarget.blur();
            }
          }}
        />
        <label>
          <span>fit</span>
          <Select
            dense
            aria-label="Region background fit"
            value={backgroundStyleDraft}
            options={[
              { value: "cover", label: "cover" },
              { value: "ratio", label: "contain" },
              { value: "repeat", label: "repeat" },
            ]}
            onChange={(value) => {
              const style = value as "cover" | "ratio" | "repeat";
              setBackgroundStyleDraft(style);
              commitBackground(backgroundDraft, style);
            }}
          />
        </label>
      </div>
    </div>
  );
}

function TaskQueueHomeControl({ node }: { readonly node: CanvasNode }) {
  const storedHost = resolveNodeHostId(node);
  const [host, setHost] = useState(storedHost);
  const [hostOptions, setHostOptions] = useState<
    ReadonlyArray<{ readonly id: string; readonly label: string }>
  >([{ id: storedHost, label: storedHost }]);

  useEffect(() => {
    setHost(storedHost);
  }, [node.id, storedHost]);

  useEffect(() => {
    let current = true;
    void window.vellum?.hostsList?.()
      .then((result) => {
        if (!current || !result.ok || !result.hosts) return;
        const seen = new Set<string>();
        const enrolled = result.hosts
          .filter((candidate) => {
            if (seen.has(candidate.id)) return false;
            seen.add(candidate.id);
            return true;
          })
          .map((candidate) => ({
            id: candidate.id,
            label:
              candidate.label === candidate.id
                ? candidate.id
                : `${candidate.label} (${candidate.id})`,
          }));
        setHostOptions(
          enrolled.some((candidate) => candidate.id === storedHost)
            ? enrolled
            : [
                { id: storedHost, label: `${storedHost} (unavailable)` },
                ...enrolled,
              ],
        );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [storedHost]);

  return <div className="inspector-section">
    <div className="inspector-section__label">task queue</div>
    <label className="inspector-editor">
      <span>home for new tasks</span>
      <Select
        dense
        aria-label="Task queue home host"
        value={host}
        options={hostOptions.map((candidate) => ({
          value: candidate.id,
          label: candidate.label,
        }))}
        onChange={(next) => {
          setHost(next);
          setNodeHost(node.id, next);
        }}
      />
    </label>
    <div className="inspector-detail">
      Existing tasks keep their current authority home.
    </div>
  </div>;
}

function PageBindingControl({ node }: { readonly node: CanvasNode }) {
  const storedProfile = node.ether?.browser?.profile ?? "personal";
  const storedHost = resolveNodeHostId(node);
  const [profile, setProfile] = useState(storedProfile);
  const [host, setHost] = useState(storedHost);
  const [hostOptions, setHostOptions] = useState<
    ReadonlyArray<{ readonly id: string; readonly label: string }>
  >([{ id: storedHost, label: storedHost }]);

  useEffect(() => {
    setProfile(storedProfile);
    setHost(storedHost);
  }, [node.id, storedHost, storedProfile]);

  useEffect(() => {
    let current = true;
    void window.vellum?.hostsList?.()
      .then((result) => {
        if (!current || !result.ok || !result.hosts) return;
        const declared = result.hosts
          .filter((candidate) => candidate.capabilities.includes("browser"))
          .map((candidate) => ({ id: candidate.id, label: candidate.label }));
        setHostOptions(
          declared.some((candidate) => candidate.id === storedHost)
            ? declared
            : [{ id: storedHost, label: `${storedHost} (unavailable)` }, ...declared],
        );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [storedHost]);

  const commit = (nextProfile = profile, nextHost = host) => {
    setPageBinding(node.id, { profile: nextProfile, host: nextHost });
  };

  return <div className="inspector-section">
    <div className="inspector-section__label">browser binding</div>
    <label className="inspector-editor">
      <span>host</span>
      <Select
        dense
        aria-label="Page browser host"
        value={host}
        options={hostOptions.map((candidate) => ({
          value: candidate.id,
          label: candidate.label,
        }))}
        onChange={(next) => {
          setHost(next);
          commit(profile, next);
        }}
      />
    </label>
    <label className="inspector-editor">
      <span>profile</span>
      <input
        aria-label="Page browser profile"
        value={profile}
        onChange={(event) => setProfile(event.target.value)}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setProfile(storedProfile);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
    <div className="inspector-detail">The page opens only on this exact registered browser host.</div>
  </div>;
}

// Watcher/timer/region-pulse editors, grouped behind one call so the
// switchboard above reads as one branch per concern instead of three more
// node-type ternaries stacked onto an already-dense dispatcher.
function KernelFieldEditors({ node }: { readonly node: CanvasNode }) {
  const kind = node.ether?.entity?.kind;
  return <>
    {node.type === "group" ? <RegionPulseControl node={node} /> : null}
    {kind === "watcher" ? <WatcherEditor node={node} /> : null}
    {kind === "timer" || kind === "cron" ? <TimerEditor node={node} /> : null}
    {kind === "relay" ? <RelayEditor node={node} /> : null}
    {kind === "task" || kind === "requests" || kind === "artifacts" ? (
      <div className="inspector-section">
        <div className="inspector-section__label">work plane</div>
        <div className="inspector-detail">
          Double-click the card for the full {kind} surface. Mutations go through the work service.
        </div>
      </div>
    ) : null}
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
  const effect = edge?.ether?.effect;
  const fromIsScheduler = isSchedulerEntityKind(fromNode?.ether?.entity?.kind);
  if (!fromIsScheduler) return null;

  const mode = effect?.mode ?? "none";
  const brief =
    effect && effect.mode === "enqueue_task" ? effect.brief : fromNode?.type === "text" ? fromNode.text : "";

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
      <div className="inspector-section__label">automation effect</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        On fire → target {toNode ? nodeTitle(toNode) : "…"}
      </div>
      <label className="inspector-editor">
        <span>mode</span>
        <Select
          dense
          aria-label="Edge automation effect"
          value={mode}
          options={[
            { value: "none", label: "none" },
            { value: "enqueue_task", label: "enqueue task" },
            { value: "set_flag", label: "set flag" },
          ]}
          onChange={(value) => setMode(value as "none" | "enqueue_task" | "set_flag")}
        />
      </label>
      {effect?.mode === "enqueue_task" ? (
        <label className="inspector-editor">
          <span>brief</span>
          <input
            aria-label="Enqueue task brief"
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
          <span>flag</span>
          <Select
            dense
            aria-label="Set flag name"
            value={effect.flag}
            options={[
              { value: "blocker", label: "blocker" },
              { value: "attention", label: "attention" },
              { value: "parked", label: "parked" },
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

export function EdgeCriteriaEditor({
  edgeId,
  fromNode,
  livePhase,
  liveDetail,
}: {
  readonly edgeId: string;
  readonly fromNode: CanvasNode | undefined;
  readonly livePhase?: string;
  readonly liveDetail?: string;
}) {
  const doc = use$(state$.doc);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  const criteria = edge?.ether?.criteria;
  const toNode = doc.nodes.find((node) => node.id === edge?.toNode);
  const fromKind = fromNode?.ether?.entity?.kind;
  const fromIsTask = fromKind === "task" || fromKind === "requests";

  type AuthoringMode = "none" | "tasks";
  const mode: AuthoringMode = criteria?.mode === "tasks" ? "tasks" : "none";
  const isTrustMode = criteria?.mode === "proof" || criteria?.mode === "approval";

  const setMode = (next: AuthoringMode) => {
    if (next === "none") {
      setEdgeCriteria(edgeId, undefined);
      return;
    }
    setEdgeCriteria(edgeId, { mode: "tasks" });
  };

  return (
    <>
    <EdgeEffectEditor edgeId={edgeId} fromNode={fromNode} toNode={toNode} />
    <div className="inspector-section">
      <div className="inspector-section__label">phase</div>
      {livePhase ? (
        <div className="inspector-detail" style={{ marginBottom: 8 }}>
          <strong style={{ color: livePhase === "blocks" ? HUE.crimson : undefined }}>
            {livePhase}
          </strong>
          {liveDetail ? ` · ${liveDetail}` : null}
          {!criteria ? " · soft relates (no stoppage)" : null}
        </div>
      ) : null}
      <div className="inspector-section__label">stop when</div>
      {isTrustMode ? (
        <div className="inspector-detail">
          trust plane · {criteria?.mode}
          {criteria && "step" in criteria ? ` · ${String((criteria as { step?: string }).step ?? "")}` : ""}
        </div>
      ) : (
        <label className="inspector-editor">
          <span>mode</span>
          <Select
            dense
            aria-label="Edge phase filter mode"
            value={mode}
            options={[
              { value: "none", label: "none · soft relates" },
              {
                value: "tasks",
                label:
                  fromIsTask && fromKind === "requests"
                    ? "tasks · pending requests block"
                    : "tasks · needs input blocks",
              },
            ]}
            onChange={(value) => setMode(value as AuthoringMode)}
          />
        </label>
      )}
    </div>
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

// Create-time stamp source for herdr/page nodes placed inside this region.
// Not live rebind — node ether wins after create. Clear empties the bag.
// Kind-strip "defaults" key opens this alone — not the kitchen-sink inspector.
export function RegionDefaultsControl({ node }: { readonly node: CanvasNode }) {
  const stored = node.ether?.region?.defaults;
  const [host, setHost] = useState(stored?.herdr?.host ?? "");
  const [session, setSession] = useState(
    stored?.herdr?.session === null ? "default" : (stored?.herdr?.session ?? ""),
  );
  const [workspaceId, setWorkspaceId] = useState(stored?.herdr?.workspaceId ?? "");
  const [tabId, setTabId] = useState(stored?.herdr?.tabId ?? "");
  const [pageUrl, setPageUrl] = useState(stored?.page?.url ?? "");
  const [pageProfile, setPageProfile] = useState(stored?.page?.profile ?? "");
  const [pageHost, setPageHost] = useState(stored?.page?.host ?? "");

  useEffect(() => {
    setHost(stored?.herdr?.host ?? "");
    setSession(stored?.herdr?.session === null ? "default" : (stored?.herdr?.session ?? ""));
    setWorkspaceId(stored?.herdr?.workspaceId ?? "");
    setTabId(stored?.herdr?.tabId ?? "");
    setPageUrl(stored?.page?.url ?? "");
    setPageProfile(stored?.page?.profile ?? "");
    setPageHost(stored?.page?.host ?? "");
  }, [node.id, stored?.herdr?.host, stored?.herdr?.session, stored?.herdr?.workspaceId, stored?.herdr?.tabId, stored?.page?.url, stored?.page?.profile, stored?.page?.host]);

  const commit = () => {
    const hostTrim = host.trim();
    const sessionTrim = session.trim();
    // "default" / empty → null unnamed session when host is set; blank session with no host → omit.
    let sessionValue: string | null | undefined;
    if (hostTrim) {
      if (!sessionTrim || sessionTrim === "default") sessionValue = null;
      else sessionValue = sessionTrim;
    }
    // Preserve host→cwd paths bag — edited from the region paths modal, not here.
    const paths = stored?.paths;
    const next: EtherRegionDefaults = {
      ...(hostTrim
        ? {
            herdr: {
              host: hostTrim,
              session: sessionValue ?? null,
              ...(workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}),
              ...(tabId.trim() ? { tabId: tabId.trim() } : {}),
            },
          }
        : {}),
      ...(pageUrl.trim() || pageProfile.trim() || pageHost.trim()
        ? {
            page: {
              ...(pageUrl.trim() ? { url: pageUrl.trim() } : {}),
              ...(pageProfile.trim() ? { profile: pageProfile.trim() } : {}),
              ...(pageHost.trim() ? { host: pageHost.trim() } : {}),
            },
          }
        : {}),
      ...(paths && Object.keys(paths).length > 0 ? { paths } : {}),
    };
    setRegionDefaults(node.id, Object.keys(next).length > 0 ? next : undefined);
  };

  const clearAll = () => {
    setHost("");
    setSession("");
    setWorkspaceId("");
    setTabId("");
    setPageUrl("");
    setPageProfile("");
    setPageHost("");
    // clear defaults clears herdr/page only — keep host paths (region folder modal)
    const paths = stored?.paths;
    setRegionDefaults(
      node.id,
      paths && Object.keys(paths).length > 0 ? { paths } : undefined,
    );
  };

  const onEnter = commitOnEnter(commit);

  const pathCount = stored?.paths
    ? Object.values(stored.paths).filter((p) => typeof p === "string" && p.trim()).length
    : 0;

  return <div className="inspector-section">
    <div className="inspector-section__label">spawn defaults</div>
    <div className="inspector-detail mb-1">Stamped onto new herdr/page nodes inside this region. Actor folder paths are set from the region toolbar (folder icon). Not live rebind — edit a node after create to override.</div>
    {pathCount > 0 ? (
      <div className="inspector-detail mb-1" style={{ color: withAlpha(HUE.amber, 0.85) }}>
        {pathCount} host folder path{pathCount === 1 ? "" : "s"} · region toolbar → folder
      </div>
    ) : null}
    <label className="inspector-editor">
      <span>herdr host</span>
      <input aria-label="Region herdr host default" value={host} placeholder="local · host id from Settings → Hosts" onChange={(e) => setHost(e.target.value)} onBlur={commit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>herdr session</span>
      <input aria-label="Region herdr session default" value={session} placeholder="default (unnamed)" onChange={(e) => setSession(e.target.value)} onBlur={commit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>herdr workspace id</span>
      <input aria-label="Region herdr workspace default" value={workspaceId} placeholder="workspace id from herdr" onChange={(e) => setWorkspaceId(e.target.value)} onBlur={commit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>herdr tab id</span>
      <input aria-label="Region herdr tab default" value={tabId} placeholder="optional tab id" onChange={(e) => setTabId(e.target.value)} onBlur={commit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>page url</span>
      <input aria-label="Region page url default" value={pageUrl} placeholder="https://…" onChange={(e) => setPageUrl(e.target.value)} onBlur={commit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>page profile</span>
      <input aria-label="Region page profile default" value={pageProfile} placeholder="personal" onChange={(e) => setPageProfile(e.target.value)} onBlur={commit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>page host</span>
      <input aria-label="Region page host default" value={pageHost} placeholder="local · browser host id" onChange={(e) => setPageHost(e.target.value)} onBlur={commit} onKeyDown={onEnter} />
    </label>
    <div className="inspector-flags mt-1">
      <button type="button" className="inspector-flag-toggle" onClick={clearAll}>clear defaults</button>
    </div>
  </div>;
}

const withoutKey = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

// Region briefing text is document furniture (ether.region.instruction).
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
 * Region briefing only — document furniture; not wired to operator pulse UI.
 * Kind-strip "briefing" key opens this alone.
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
    <div className="inspector-section">
      <div className="inspector-section__label">region briefing</div>
      <label className="inspector-editor">
        <span>context for agents inside this region</span>
        <textarea
          aria-label="Region briefing"
          placeholder="what should agents inside this region know?"
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
      </label>
    </div>
  );
}

// Legacy full-form path: briefing only (ops moved to command keys).
function RegionPulseControl({ node }: { readonly node: CanvasNode }) {
  return <RegionBriefingEditor node={node} />;
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
function WatcherEditor({ node }: { readonly node: CanvasNode }) {
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
    <div className="inspector-section__label">gauge · hermes threshold</div>
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

function RelayEditor({ node }: { readonly node: CanvasNode }) {
  const relay = node.ether?.relay;
  const [sourceNodeId, setSourceNodeId] = useState(relay?.sourceNodeId ?? "");
  const [path, setPath] = useState<EtherRelay["path"]>(relay?.path ?? "task_state");
  const [equals, setEquals] = useState(relay?.equals ?? "completed");
  const [itemId, setItemId] = useState(relay?.itemId ?? "");

  useEffect(() => {
    setSourceNodeId(relay?.sourceNodeId ?? "");
    setPath(relay?.path ?? "task_state");
    setEquals(relay?.equals ?? "completed");
    setItemId(relay?.itemId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const commit = (overrides: Partial<EtherRelay> = {}) => {
    const next: EtherRelay = {
      sourceNodeId: (overrides.sourceNodeId ?? sourceNodeId).trim(),
      path: overrides.path ?? path,
      ...( (overrides.equals ?? equals).trim()
        ? { equals: (overrides.equals ?? equals).trim() }
        : {}),
      ...( (overrides.itemId ?? itemId).trim()
        ? { itemId: (overrides.itemId ?? itemId).trim() }
        : {}),
    };
    if (!next.sourceNodeId) return;
    setNodeRelay(node.id, next);
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">relay · watch node</div>
      <label className="inspector-editor">
        <span>source node id</span>
        <input
          aria-label="Relay source node id"
          value={sourceNodeId}
          onChange={(event) => setSourceNodeId(event.target.value)}
          onBlur={() => commit()}
        />
      </label>
      <label className="inspector-editor">
        <span>path</span>
        <Select
          dense
          aria-label="Relay path"
          value={path}
          options={[
            { value: "task_state", label: "task state" },
            { value: "flags", label: "flags" },
          ]}
          onChange={(value) => {
            const next = value as EtherRelay["path"];
            setPath(next);
            commit({ path: next });
          }}
        />
      </label>
      <label className="inspector-editor">
        <span>equals</span>
        <input
          aria-label="Relay equals"
          value={equals}
          onChange={(event) => setEquals(event.target.value)}
          onBlur={() => commit()}
          placeholder={path === "flags" ? "blocker" : "completed"}
        />
      </label>
      {path === "task_state" ? (
        <label className="inspector-editor">
          <span>item id (optional)</span>
          <input
            aria-label="Relay task item id"
            value={itemId}
            onChange={(event) => setItemId(event.target.value)}
            onBlur={() => commit()}
          />
        </label>
      ) : null}
    </div>
  );
}

const MIN_TIMER_EVERY_MINUTES = 5;

// Cron editor: interval field; 5-minute UI floor before setNodeTimer.
function TimerEditor({ node }: { readonly node: CanvasNode }) {
  const timer = node.ether?.timer;
  const defaultMinutes = timer?.everyMinutes ?? 30;
  const [minutesText, setMinutesText] = useState(String(defaultMinutes));
  const [error, setError] = useState("");

  useEffect(() => {
    setMinutesText(String(timer?.everyMinutes ?? 30));
    setError("");
  }, [node.id, timer?.everyMinutes]);

  const commit = () => {
    const parsed = Number(minutesText);
    if (!Number.isFinite(parsed) || parsed < MIN_TIMER_EVERY_MINUTES) {
      setError(`minimum is ${MIN_TIMER_EVERY_MINUTES}m`);
      return;
    }
    setError("");
    setNodeTimer(node.id, { everyMinutes: Math.round(parsed) });
  };

  return <div className="inspector-section">
    <div className="inspector-section__label">timer</div>
    <label className="inspector-editor">
      <span>every (minutes)</span>
      <input
        aria-label="Timer interval minutes"
        type="number"
        min={MIN_TIMER_EVERY_MINUTES}
        value={minutesText}
        onChange={(event) => setMinutesText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setMinutesText(String(timer?.everyMinutes ?? 30)); setError(""); event.currentTarget.blur(); }
        }}
      />
    </label>
    {error ? <div className="mt-1 text-[9px]" style={{ color: withAlpha(HUE.crimson, 0.8) }}>{error}</div> : null}
  </div>;
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
                label: `${nodeTitle(target)} · ${target.ether?.entity?.kind ?? target.type}`,
              })),
            ]}
            onChange={setTargetId}
          />
        </label>
      )}
      <div className="inspector-detail">
        {fromIsTask
          ? "From a tasks/requests node: edge auto-binds tasks criteria (blocks while needs input)."
          : "Soft relates by default. Attach tasks criteria on the edge after connect."}
      </div>
      <button disabled={!targetId} onClick={connect}>
        create edge
      </button>
    </div>
  );
}
