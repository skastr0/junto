import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { Ban, Crosshair, Link2, Trash2 } from "lucide-react";
import type { EtherFlag } from "@shared/canvas";
import type { MemberSeverity, RegionRollup } from "@shared/region-rollup";
import { state$, toggleFlagFilter } from "../../lib/state";
import { assignSlot, mergeSlotOrder, useRegionRollups } from "../../lib/region-rollups";
import { signalMark, signalMarkForMember } from "../../lib/signal-mark";
import { deleteNode, deleteNodes, setNodeColor, toggleFlag, addNode } from "../../lib/mutations";
import { makeGroupNode } from "../../lib/node-factories";
import { nodeTitle, nodeTypeLabel } from "../../lib/presentation";
import { HUE, withAlpha } from "../../lib/theme";
import { disarmOrphan, kernel$ } from "../../lib/kernel-view";
import { PulseTray } from "../PulseTray";
import "./RtsBottomBar.css";

const COLOR_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string; readonly hue: string }> = [
  { value: "1", label: "red", hue: HUE.crimson },
  { value: "2", label: "orange", hue: HUE.orange },
  { value: "3", label: "gold", hue: HUE.gold },
  { value: "4", label: "green", hue: "#5FB98E" },
  { value: "5", label: "cyan", hue: HUE.cyan },
  { value: "6", label: "violet", hue: HUE.violet },
];

const FLAG_OPTIONS: ReadonlyArray<{ readonly flag: EtherFlag; readonly hue: string }> = [
  { flag: "blocker", hue: HUE.crimson },
  { flag: "attention", hue: HUE.amber },
  { flag: "parked", hue: HUE.violet },
];

const isTextEditing = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest("input, textarea, [contenteditable='true']"));

const createRegionFromIds = (ids: ReadonlyArray<string>): string | undefined => {
  const targets = state$.doc.peek().nodes.filter((node) => ids.includes(node.id) && node.type !== "group");
  if (targets.length === 0) return undefined;
  const pad = 48;
  const minX = Math.min(...targets.map((node) => node.x)) - pad;
  const minY = Math.min(...targets.map((node) => node.y)) - pad;
  const maxX = Math.max(...targets.map((node) => node.x + node.width)) + pad;
  const maxY = Math.max(...targets.map((node) => node.y + node.height)) + pad;
  const region = makeGroupNode(minX, minY, { width: maxX - minX, height: maxY - minY });
  addNode(region, { edit: false, focus: false });
  return region.id;
};

function CommandCard({ regionRollup }: { readonly regionRollup?: RegionRollup }) {
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const multi = selectedNodeIds.length > 1;
  const node = !multi && selectedNodeId
    ? doc.nodes.find((candidate) => candidate.id === selectedNodeId)
    : undefined;

  if (multi) {
    const count = selectedNodeIds.length;
    return (
      <div className="rts-panel">
        <div className="rts-panel__label">command</div>
        <div className="rts-panel__body rts-cmd">
          <div className="rts-cmd__meta">{count} selected</div>
          <div className="rts-cmd__row">
            <button type="button" className="rts-cmd__btn" aria-label="Flag selected as blocker" onClick={() => selectedNodeIds.forEach((id) => toggleFlag(id, "blocker"))}>
              <Ban size={12} /> flag blocker
            </button>
            <button type="button" className="rts-cmd__btn rts-cmd__btn--danger" aria-label="Delete selected" onClick={() => deleteNodes(selectedNodeIds)}>
              <Trash2 size={12} /> delete
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Region selected → tactical rollcall lives here (middle stays regions-only).
  if (node?.type === "group" && regionRollup) {
    const mark = signalMark(regionRollup.severity);
    return (
      <div className="rts-panel">
        <div className="rts-panel__label">
          command · region
          <span className="rts-signal" style={{ color: mark.hue }} title={mark.label}>
            {mark.symbol} {mark.label}
          </span>
        </div>
        <div className="rts-panel__body rts-cmd">
          <div className="rts-cmd__title" title={regionRollup.label}>{regionRollup.label}</div>
          <div className="rts-cmd__meta">
            {regionRollup.counts.total} ·{" "}
            {regionRollup.counts.blocked > 0 ? <span style={{ color: HUE.crimson }}>{regionRollup.counts.blocked} blocked </span> : null}
            {regionRollup.counts.attention > 0 ? <span style={{ color: HUE.amber }}>{regionRollup.counts.attention} attn </span> : null}
            {regionRollup.counts.working > 0 ? <span style={{ color: HUE.cyan }}>{regionRollup.counts.working} working</span> : null}
          </div>
          {regionRollup.members.length === 0 ? (
            <div className="rts-quiet">Empty region — drop nodes inside its bounds.</div>
          ) : (
            <div className="rts-rollcall">
              {regionRollup.members.map((member) => {
                const m = signalMarkForMember(member);
                return (
                  <button
                    key={member.nodeId}
                    type="button"
                    className="rts-rollcall__row"
                    title={m.label}
                    aria-label={`${member.label}, ${m.label}`}
                    onClick={() => {
                      state$.selectedNodeId.set(member.nodeId);
                      state$.selectedNodeIds.set([member.nodeId]);
                      state$.selectedEdgeId.set("");
                      state$.focusNodeId.set(member.nodeId);
                    }}
                  >
                    <span className="rts-signal-mark" style={{ color: m.hue }} aria-hidden>{m.symbol}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.label}</span>
                    <span className="rts-rollcall__kind">{member.kind}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="rts-cmd__row">
            <button type="button" className="rts-cmd__btn" onClick={() => state$.focusNodeId.set(node.id)}>
              <Crosshair size={12} /> focus
            </button>
            <button type="button" className="rts-cmd__btn rts-cmd__btn--danger" onClick={() => deleteNode(node.id)}>
              <Trash2 size={12} /> delete region
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!node) {
    return (
      <div className="rts-panel">
        <div className="rts-panel__label">command</div>
        <div className="rts-panel__body"><div className="rts-quiet">No selection — click a node or tap 1–9 for a region.</div></div>
      </div>
    );
  }

  const flags = node.ether?.flags ?? [];
  return (
    <div className="rts-panel">
      <div className="rts-panel__label">command</div>
      <div className="rts-panel__body rts-cmd">
        <div>
          <div className="rts-cmd__meta">{nodeTypeLabel(node)}</div>
          <div className="rts-cmd__title" title={nodeTitle(node)}>{nodeTitle(node)}</div>
        </div>
        <div className="rts-cmd__row" aria-label="Accent color">
          <button
            type="button"
            className={`rts-cmd__btn${!node.color ? " is-active" : ""}`}
            title="default accent"
            aria-label="Use default accent"
            aria-pressed={!node.color}
            onClick={() => setNodeColor(node.id, undefined)}
          >
            <span className="rts-cmd__swatch" style={{ background: HUE.amber }} />
          </button>
          {COLOR_OPTIONS.map(({ value, label, hue }) => (
            <button
              key={value}
              type="button"
              className={`rts-cmd__btn${node.color === value ? " is-active" : ""}`}
              title={`${label} accent`}
              aria-label={`Set ${label} accent`}
              aria-pressed={node.color === value}
              style={{ color: hue }}
              onClick={() => setNodeColor(node.id, value)}
            >
              <span className="rts-cmd__swatch" style={{ background: hue }} />
            </button>
          ))}
        </div>
        <div className="rts-cmd__row" aria-label="Flags">
          {FLAG_OPTIONS.map(({ flag, hue }) => {
            const active = flags.includes(flag);
            return (
              <button
                key={flag}
                type="button"
                className={`rts-cmd__btn${active ? " is-active" : ""}`}
                style={{ color: active ? hue : undefined }}
                aria-pressed={active}
                onClick={() => toggleFlag(node.id, flag)}
              >
                {flag}
              </button>
            );
          })}
        </div>
        <div className="rts-cmd__row">
          <button type="button" className="rts-cmd__btn" onClick={() => state$.focusNodeId.set(node.id)}>
            <Crosshair size={12} /> focus
          </button>
          <button
            type="button"
            className="rts-cmd__btn"
            title="Select this node, then drag an edge handle to connect"
            onClick={() => {
              state$.selectedNodeId.set(node.id);
              state$.selectedNodeIds.set([node.id]);
              state$.selectedEdgeId.set("");
            }}
          >
            <Link2 size={12} /> connect
          </button>
          <button type="button" className="rts-cmd__btn rts-cmd__btn--danger" onClick={() => deleteNode(node.id)}>
            <Trash2 size={12} /> delete
          </button>
        </div>
      </div>
    </div>
  );
}

function RegionMiddle({
  rollups,
  byId,
}: {
  readonly rollups: ReadonlyArray<RegionRollup>;
  readonly byId: ReadonlyMap<string, RegionRollup>;
}) {
  const selectedNodeId = use$(state$.selectedNodeId);
  const slotOrder = use$(state$.regionSlotOrder);
  const dragFrom = useRef<number | null>(null);

  const slots = useMemo(() => {
    const ids = mergeSlotOrder(slotOrder, rollups.map((r) => r.regionId));
    return ids.map((id, index) => ({ index, rollup: byId.get(id) })).filter((s): s is { index: number; rollup: RegionRollup } => s.rollup !== undefined);
  }, [slotOrder, rollups, byId]);

  // Keep slot order in sync with live regions (append new, drop gone).
  // Never write [] from a transient empty rollup payload — that would wipe
  // the presentational 1–9 order on a failed/quiet IPC fetch.
  useEffect(() => {
    const liveIds = rollups.map((r) => r.regionId);
    if (liveIds.length === 0) {
      const groups = state$.doc.peek().nodes.filter((n) => n.type === "group").map((n) => n.id);
      if (groups.length === 0) return;
      const next = mergeSlotOrder(state$.regionSlotOrder.peek(), groups);
      const prev = state$.regionSlotOrder.peek();
      if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) {
        state$.regionSlotOrder.set(next);
      }
      return;
    }
    const next = mergeSlotOrder(state$.regionSlotOrder.peek(), liveIds);
    const prev = state$.regionSlotOrder.peek();
    if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) {
      state$.regionSlotOrder.set(next);
    }
  }, [rollups]);

  const jumpToRegion = (regionId: string) => {
    state$.selectedNodeId.set(regionId);
    state$.selectedNodeIds.set([regionId]);
    state$.selectedEdgeId.set("");
    state$.focusNodeId.set(regionId);
  };

  // Middle is the nervous system: ALWAYS region chips. Never swaps to rollcall.
  return (
    <div className="rts-panel">
      <div className="rts-panel__label">regions · 1–9</div>
      <div className="rts-panel__body">
        {slots.length === 0 ? (
          <div className="rts-quiet">No regions yet — group nodes, or Ctrl+1–9 on a selection.</div>
        ) : (
          <div className="rts-chips">
            {slots.map(({ index, rollup }) => {
              const mark = signalMark(rollup.severity);
              const elevated = mark.kind !== "idle";
              return (
                <button
                  key={rollup.regionId}
                  type="button"
                  className={`rts-chip${selectedNodeId === rollup.regionId ? " is-active" : ""}${elevated ? " is-hot" : ""}`}
                  style={
                    elevated
                      ? {
                          borderColor: withAlpha(mark.hue, 0.55),
                          boxShadow: `inset 0 0 0 1px ${withAlpha(mark.hue, 0.18)}, 0 0 12px ${withAlpha(mark.hue, 0.12)}`,
                        }
                      : undefined
                  }
                  draggable
                  aria-label={`Region slot ${index + 1}: ${rollup.label}, ${mark.label}, ${rollup.counts.total} members`}
                  onDragStart={() => { dragFrom.current = index; }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    const from = dragFrom.current;
                    dragFrom.current = null;
                    if (from === null || from === index) return;
                    const order = slots.map((s) => s.rollup.regionId);
                    const [moved] = order.splice(from, 1);
                    if (!moved) return;
                    order.splice(index, 0, moved);
                    state$.regionSlotOrder.set(order.slice(0, 9));
                  }}
                  onClick={() => jumpToRegion(rollup.regionId)}
                  title={`${rollup.label} — ${mark.label}`}
                >
                  <span className="rts-chip__slot" style={elevated ? { color: mark.hue, borderColor: withAlpha(mark.hue, 0.4) } : undefined}>
                    {index + 1}
                  </span>
                  <span
                    className="rts-signal-mark"
                    style={{ color: mark.hue }}
                    aria-hidden
                    title={mark.label}
                  >
                    {elevated ? mark.symbol : "●"}
                  </span>
                  <span className="rts-chip__label">{rollup.label}</span>
                  <span className="rts-chip__counts">
                    {rollup.counts.blocked > 0 ? <span style={{ color: HUE.crimson }}><b>{rollup.counts.blocked}</b>b</span> : null}
                    {rollup.counts.attention > 0 ? <span style={{ color: HUE.amber }}><b>{rollup.counts.attention}</b>a</span> : null}
                    {rollup.counts.working > 0 ? <span style={{ color: HUE.cyan }}><b>{rollup.counts.working}</b>w</span> : null}
                    <span><b>{rollup.counts.total}</b></span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MinimapChrome({ children }: { readonly children: ReactNode }) {
  const flagFilter = use$(state$.flagFilter);
  const doc = use$(state$.doc);
  const nodes = doc.nodes.filter((node) => node.type !== "group");
  const counts = FLAG_OPTIONS.reduce((acc, { flag }) => {
    acc[flag] = nodes.filter((node) => node.ether?.flags?.includes(flag)).length;
    return acc;
  }, { blocker: 0, attention: 0, parked: 0 } as Record<EtherFlag, number>);

  return (
    <div className="rts-minimap-wrap">
      {children}
      <div className="rts-layer-toggles" aria-label="Flag layer toggles">
        {FLAG_OPTIONS.map(({ flag, hue }) =>
          counts[flag] > 0 ? (
            <button
              key={flag}
              type="button"
              className={flagFilter === flag ? "is-active" : undefined}
              style={{ color: hue }}
              aria-pressed={flagFilter === flag}
              onClick={() => toggleFlagFilter(flag)}
            >
              {counts[flag]} {flag}
            </button>
          ) : null,
        )}
        {flagFilter ? (
          <button type="button" onClick={() => { state$.flagFilter.set(""); state$.selectedNodeId.set(""); state$.selectedNodeIds.set([]); state$.selectedEdgeId.set(""); }}>
            all
          </button>
        ) : null}
      </div>
    </div>
  );
}

function OrphanNotices() {
  const orphaned = use$(kernel$.orphaned) as ReadonlyArray<string> | undefined;
  const orphans = orphaned ?? [];
  if (orphans.length === 0) return null;
  return (
    <div className="rts-notify" aria-label="Orphaned arming">
      {orphans.map((key) => (
        <div key={key} className="rts-orphan">
          <span title={key} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{key}</span>
          <button type="button" onClick={() => void disarmOrphan(key)}>disarm</button>
        </div>
      ))}
    </div>
  );
}

export function useRegionHotkeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTextEditing(event.target)) return;
      const digit = event.key >= "1" && event.key <= "9" ? Number(event.key) : null;
      if (digit === null) return;
      const slotIndex = digit - 1;
      const order = mergeSlotOrder(
        state$.regionSlotOrder.peek(),
        state$.doc.peek().nodes.filter((n) => n.type === "group").map((n) => n.id),
      );

      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        const selection = state$.selectedNodeIds.peek();
        const single = state$.selectedNodeId.peek();
        const ids = selection.length > 0 ? selection : single ? [single] : [];
        // Prefer assigning an already-selected region into the slot.
        const selectedRegion = ids.find((id) => state$.doc.peek().nodes.some((n) => n.id === id && n.type === "group"));
        const regionId = selectedRegion ?? createRegionFromIds(ids);
        if (!regionId) return;
        state$.regionSlotOrder.set(assignSlot(order, regionId, slotIndex));
        state$.selectedNodeId.set(regionId);
        state$.selectedNodeIds.set([regionId]);
        state$.focusNodeId.set(regionId);
        return;
      }

      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const regionId = order[slotIndex];
      if (!regionId) return;
      event.preventDefault();
      state$.selectedNodeId.set(regionId);
      state$.selectedNodeIds.set([regionId]);
      state$.selectedEdgeId.set("");
      state$.focusNodeId.set(regionId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Severity index for minimap nodeColor — built from latest rollups. */
export function useSeverityByNodeId(rollups: ReadonlyArray<RegionRollup>): ReadonlyMap<string, MemberSeverity> {
  return useMemo(() => {
    const map = new Map<string, MemberSeverity>();
    for (const rollup of rollups) {
      for (const member of rollup.members) {
        const prev = map.get(member.nodeId);
        if (!prev || severityRank(member.severity) < severityRank(prev)) {
          map.set(member.nodeId, member.severity);
        }
      }
      map.set(rollup.regionId, rollup.severity);
    }
    return map;
  }, [rollups]);
}

const severityRank = (s: MemberSeverity): number =>
  s === "blocked" ? 0 : s === "attention" ? 1 : s === "working" ? 2 : s === "parked" ? 3 : 4;

export function RtsBottomBar({ minimap }: { readonly minimap: ReactNode }) {
  useRegionHotkeys();
  const rollups = useRegionRollups();
  const byId = useMemo(() => new Map(rollups.map((r) => [r.regionId, r])), [rollups]);
  const severityMap = useSeverityByNodeId(rollups);

  // Publish into state$ so MiniMap can subscribe (React data path, not a module ref).
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const [id, severity] of severityMap) next[id] = severity;
    state$.regionSeverityByNodeId.set(next);
  }, [severityMap]);

  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedRegion = selectedNodeId ? byId.get(selectedNodeId) : undefined;

  return (
    <div className="rts-bar" role="region" aria-label="RTS bottom bar">
      <CommandCard regionRollup={selectedRegion} />
      <RegionMiddle rollups={rollups} byId={byId} />
      <div className="rts-right">
        <OrphanNotices />
        <div className="rts-notify rts-notify--pulse">
          <PulseTray embedded />
        </div>
        <MinimapChrome>{minimap}</MinimapChrome>
      </div>
    </div>
  );
}
