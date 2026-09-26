import { useEffect, useMemo, useState } from "react";
import { Flag } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { HashMap, HashSet, Option } from "effect";
import type {
  CanvasDoc,
  CanvasNode,
  EtherFlag,
  EtherRegionDefaults,
  EtherWatch,
} from "@shared/canvas";
import { compileEdgeGrant, edgeKindIndex } from "@shared/canvas";
import {
  BROWSER_ENABLED,
  CRON_ENABLED,
  FLEET_UI_ENABLED,
  RELAY_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { isGroup } from "@shared/graph";
import {
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
import { addEdge } from "../lib/edge-mutations";
import { specOf } from "../lib/node-spec";
import { releaseFocus } from "../lib/focus-ownership";
import { commitDoc, editLink, editText, setGitCwd, setNodeHost, setNodeTimer, setNodeWatch, setPageBinding, setRegionDefaults, toggleFlag } from "../lib/mutations";
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
import { RegionRules } from "./rules";
import { BrowserProfileSelect, EnrolledHostSelect } from "./HostPickers";

// ---------------------------------------------------------------------------
// Factory physics — capability inventory (read-only) + "limit this key" editor

const entityNameOf = (node: CanvasNode | undefined): string =>
  typeof node?.ether?.entity?.name === "string" ? node.ether.entity.name : "";

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

/** Human labels for port chips — never raw protocol tokens as the only text. */
const PORT_LABEL: Record<string, string> = {
  "tasks.list": "List tasks",
  "tasks.create": "Create tasks",
  "tasks.claim": "Claim tasks",
  "tasks.update": "Update tasks",
  "msg.list": "List messages",
  "msg.send": "Send mail",
  "msg.prompt": "Prompt immediately",
  "seat.wait": "Wait on seat",
  "terminal.read": "Observe terminal",
  "verdict.post": "Post verdict",
  "artifact.publish": "Publish artifacts",
  "browser.automate": "Drive browser",
  "board.list": "List board",
  "board.create_topic": "Create topics",
  "board.post": "Post to board",
  "board.mark_read": "Mark board read",
  "pad.read": "Read pad",
  "pad.patch": "Patch pad",
};

const portLabel = (port: PortName): string => PORT_LABEL[port] ?? port;

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
  const gitCwdValue = node.ether?.git?.cwd ?? "";
  const [textDraft, setTextDraft] = useState(textValue);
  const [gitCwdDraft, setGitCwdDraft] = useState(gitCwdValue);
  useEffect(() => {
    setTextDraft(textValue);
    setGitCwdDraft(gitCwdValue);
  }, [gitCwdValue, node.id, textValue]);

  const commitText = () => { if (node.type === "text" && textDraft !== textValue) editText(node.id, textDraft); };

  return <>
    {/* Work sinks / schedulers rename via kind-strip pencil — no fat label field. */}
    {node.type === "text" &&
    node.ether?.entity?.kind !== "task" &&
    node.ether?.entity?.kind !== "requests" &&
    node.ether?.entity?.kind !== "artifacts" &&
    node.ether?.entity?.kind !== "board" &&
    node.ether?.entity?.kind !== "cron" &&
    node.ether?.entity?.kind !== "timer" &&
    node.ether?.entity?.kind !== "watcher" &&
    node.ether?.entity?.kind !== "relay" &&
    node.ether?.entity?.kind !== "git" ? (
      <label className="inspector-editor">
        <span>{node.ether?.entity ? "label" : "note text"}</span>
        <textarea
          data-focus-owner="canvas-draft"
          aria-label={node.ether?.entity ? "Node label" : "Note text"}
          value={textDraft}
          onChange={(event) => setTextDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setTextDraft(textValue);
              releaseFocus(event.currentTarget, "gesture");
            }
          }}
        />
      </label>
    ) : null}
    {node.ether?.entity?.kind === "git" ? (
      <label className="inspector-editor">
        <span>repository folder</span>
        <input
          data-focus-owner="canvas-draft"
          aria-label="Git repository folder"
          value={gitCwdDraft}
          onChange={(event) => setGitCwdDraft(event.target.value)}
          onBlur={() => setGitCwd(node.id, gitCwdDraft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setGitCwd(node.id, gitCwdDraft);
              releaseFocus(event.currentTarget, "gesture");
            }
            if (event.key === "Escape") {
              setGitCwdDraft(gitCwdValue);
              releaseFocus(event.currentTarget, "gesture");
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
      {FLEET_UI_ENABLED ? (
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
      ) : null}
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
          data-focus-owner="canvas-draft"
          aria-label="Page URL"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              releaseFocus(event.currentTarget, "gesture");
            }
            if (event.key === "Escape") {
              setDraft(url);
              releaseFocus(event.currentTarget, "gesture");
            }
          }}
        />
      </label>
    </div>
  );
}

// Watcher/timer editors, grouped behind one call so the switchboard above
// reads as one branch per concern instead of more node-type ternaries
// stacked onto an already-dense dispatcher. Regions never reach this form:
// their fields open from the region kind strip.
function KernelFieldEditors({ node }: { readonly node: CanvasNode }) {
  const kind = node.ether?.entity?.kind;
  return <>
    {RELAY_ENABLED && kind === "watcher" ? <WatcherEditor node={node} /> : null}
    {CRON_ENABLED && (kind === "timer" || kind === "cron") ? <TimerEditor node={node} /> : null}
    {RELAY_ENABLED && kind === "relay" ? <RelayEditor node={node} /> : null}

    {kind === "agent" ? <AgentMessagesPane node={node} /> : null}
  </>;
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
    const page =
      url.trim() || profile.trim() || host.trim()
        ? {
            ...(url.trim() ? { url: url.trim() } : {}),
            ...(profile.trim() ? { profile: profile.trim() } : {}),
            ...(host.trim() ? { host: host.trim() } : {}),
          }
        : undefined;
    const next: EtherRegionDefaults = {
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
          data-focus-owner="canvas-draft"
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
      {FLEET_UI_ENABLED ? (
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
      ) : null}
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
 * Region briefing — context agents receive on onboard. Builds with the Tasks
 * feature also author the region's rules and pinned rulings beneath it: rules
 * are statements a closing task must answer, so they live with the briefing.
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
        data-focus-owner="canvas-draft"
        className="region-briefing__editor"
        aria-label="Region briefing"
        placeholder="What should agents inside this region know?"
        value={instructionDraft}
        onChange={(event) => setInstructionDraft(event.target.value)}
        onBlur={commitInstruction}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setInstructionDraft(instructionValue);
            releaseFocus(event.currentTarget, "gesture");
          }
        }}
      />
      {/* Region rules ride the Tasks gate: a tasks-off build has none. */}
      {TASKS_ENABLED ? <RegionRules node={node} /> : null}
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
  releaseFocus(event.currentTarget, "gesture");
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
      <input data-focus-owner="canvas-draft" aria-label="Watcher entity key" value={entityKey} placeholder="bound entity key" onChange={(event) => onKey(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>stat</span>
      <input data-focus-owner="canvas-draft" aria-label="Watcher stat name" value={stat} placeholder="e.g. signals" onChange={(event) => onStat(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
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
      <input data-focus-owner="canvas-draft" aria-label="Watcher threshold value" type="number" value={valueText} onChange={(event) => onValue(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
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
        style={{ color: flagOnUnsatisfied ? HUE.crimson : "var(--color-faint)", borderColor: flagOnUnsatisfied ? withAlpha(HUE.crimson, 0.5) : "var(--color-overlay-4)", background: flagOnUnsatisfied ? withAlpha(HUE.crimson, 0.1) : "var(--color-overlay-1)" }}
        onClick={() => { const next = !flagOnUnsatisfied; setFlagOnUnsatisfied(next); commit({ flagOnUnsatisfied: next }); }}
      >flag when unsatisfied</button>
    </div>
  </div>;
}

/**
 * Relay binding is the drawn links only. Both lines read the compiled verb —
 * an edge says which relationship it is, and the watch predicate and fire
 * action fall out of that plus the two kinds.
 */
export function RelayEditor({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const kinds = useMemo(() => edgeKindIndex(doc), [doc]);
  const inbound = doc.edges.filter(
    (edge) =>
      edge.toNode === node.id && compileEdgeGrant(edge, kinds)?.when !== undefined,
  );
  const outbound = doc.edges.filter(
    (edge) =>
      edge.fromNode === node.id && compileEdgeGrant(edge, kinds)?.does !== undefined,
  );
  const watchLine =
    inbound.length === 0
      ? "Not watching anything yet"
      : inbound
          .map((edge) => {
            const src = doc.nodes.find((n) => n.id === edge.fromNode);
            const name = src ? nodeTitle(src) : "a connected node";
            const when = compileEdgeGrant(edge, kinds)?.when;
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
          data-focus-owner="canvas-draft"
          aria-label="Cron expression"
          className="font-mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              releaseFocus(event.currentTarget, "gesture");
            }
            if (event.key === "Escape") {
              setDraft(defaultExpr);
              setError("");
              releaseFocus(event.currentTarget, "gesture");
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
  return <div className="inspector-section"><div className="inspector-section__label"><Flag size={11} /> flags</div><div className="inspector-flags">{FLAG_OPTIONS.map(({ flag, hue }) => { const active = flags.includes(flag); return <button key={flag} type="button" className="inspector-flag-toggle" aria-pressed={active} style={{ color: active ? hue : "var(--color-faint)", borderColor: active ? withAlpha(hue, 0.5) : "var(--color-overlay-4)", background: active ? withAlpha(hue, 0.1) : "var(--color-overlay-1)" }} onClick={() => toggleFlag(node.id, flag)}>{flag}</button>; })}</div></div>;
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
    // The verb comes from the pair — connecting is the whole authoring act.
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
          : "Drawing the wire names the relationship. Swap it on the bottom bar."}
      </div>
      <button disabled={!targetId} onClick={connect}>
        create edge
      </button>
    </div>
  );
}
