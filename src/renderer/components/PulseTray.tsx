import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { state$ } from "../lib/state";
import { comparePulse, type PulseItem } from "../lib/pulse";
import { kernel$, type PulseRecord } from "../lib/kernel-view";
import { nodeTitle } from "../lib/presentation";
import { SOURCE_HUE, GROUND, INK, DIM, HUE } from "../lib/theme";

const TOAST_AUTO_DISMISS_MS = 8000;
const MAX_VISIBLE_TOASTS = 4;

// Two pulse sources feed one quiet tray: connector snapshot deltas (existing)
// and kernel pulseLog entries (watcher/timer/manual pulses). One discriminated
// toast type keeps a single dismiss/queue pipeline instead of two.
type TrayToast =
  | { readonly id: string; readonly kind: "snapshot"; readonly item: PulseItem }
  | { readonly id: string; readonly kind: "kernel"; readonly record: PulseRecord };

export function PulseTray({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const snapshots = use$(state$.snapshots);
  const prevSnapshotsRef = useRef(snapshots);
  const pulseLog = use$(kernel$.pulseLog) as ReadonlyArray<PulseRecord> | undefined;
  const prevPulseLogRef = useRef(pulseLog ?? []);
  const [toasts, setToasts] = useState<TrayToast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // When snapshots change, compute diff and append new items
  useEffect(() => {
    const prev = prevSnapshotsRef.current;
    const next = snapshots;

    if (prev && next) {
      const items = comparePulse(prev, next);
      if (items.length > 0) {
        setToasts((current) => {
          const incoming = new Map(items.map((item) => [item.id, item] as const));
          // Drop same-id entries then append — re-arm needs a fresh timer key.
          const kept = current.filter((t) => !incoming.has(t.id));
          for (const item of items) {
            const existingTimer = timersRef.current.get(item.id);
            if (existingTimer) clearTimeout(existingTimer);
            timersRef.current.delete(item.id);
          }
          return [
            ...kept,
            ...items.map((item): TrayToast => ({ id: item.id, kind: "snapshot", item })),
          ];
        });
      }
    }

    prevSnapshotsRef.current = next;
  }, [snapshots]);

  // Same shape for the kernel's pulse log: only entries not seen before
  // become toasts — the log's pre-mount history never fires (mirrors the
  // "first evaluation is baseline" law for watchers themselves).
  useEffect(() => {
    const prev = prevPulseLogRef.current;
    const next = pulseLog ?? [];
    if (next.length > prev.length) {
      const seen = new Set(prev.map((record) => record.id));
      const added = next.filter((record) => !seen.has(record.id));
      if (added.length > 0) {
        setToasts((current) => {
          const keys = new Set(added.map((record) => `kernel-${record.id}`));
          const kept = current.filter((t) => !keys.has(t.id));
          for (const record of added) {
            const key = `kernel-${record.id}`;
            const existingTimer = timersRef.current.get(key);
            if (existingTimer) clearTimeout(existingTimer);
            timersRef.current.delete(key);
          }
          return [
            ...kept,
            ...added.map((record): TrayToast => ({ id: `kernel-${record.id}`, kind: "kernel", record })),
          ];
        });
      }
    }
    prevPulseLogRef.current = next;
  }, [pulseLog]);

  // Auto-dismiss toasts after TOAST_AUTO_DISMISS_MS.
  // Timers live across toasts changes: cleanup only on unmount. Clearing the
  // map on every toasts change left ids in timersRef while killing the
  // timeouts, so skipped toasts never got a replacement timer (stuck toast).
  useEffect(() => {
    for (const toast of toasts) {
      if (timersRef.current.has(toast.id)) continue;
      const id = toast.id;
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((current) => current.filter((t) => t.id !== id));
      }, TOAST_AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
    }
  }, [toasts]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const visibleToasts = toasts.slice(0, MAX_VISIBLE_TOASTS);
  const hiddenCount = Math.max(0, toasts.length - MAX_VISIBLE_TOASTS);

  // When embedded, lives in the RTS bar notification stack above the minimap
  // (docs/rts-bottom-bar.md). Standalone fallback keeps absolute placement.
  return (
    <div
      className={
        embedded
          ? "pulse-tray pointer-events-none flex flex-col gap-1 items-stretch w-full"
          : "pulse-tray pointer-events-none absolute bottom-[168px] right-3 z-30 flex flex-col gap-1 items-end"
      }
      style={{ maxWidth: embedded ? "100%" : "280px" }}
    >
      {visibleToasts.map((toast) => (
        toast.kind === "snapshot"
          ? <Toast key={toast.id} item={toast.item} />
          : <KernelToast key={toast.id} record={toast.record} />
      ))}
      {hiddenCount > 0 && (
        <div
          className="text-[10px] leading-tight"
          style={{ color: INK, opacity: 0.6 }}
        >
          +{hiddenCount} more
        </div>
      )}
    </div>
  );
}

interface ToastProps {
  item: PulseItem;
}

function Toast({ item }: ToastProps) {
  const sourceColor = SOURCE_HUE[item.source] || "#E8A33D";

  return (
    <div
      className="pulse-toast rounded-xs border-l-2 px-2 py-1.5 text-[10px] leading-tight transition-all duration-200 ease-in-out animate-in fade-in slide-in-from-bottom"
      style={{
        borderLeftColor: sourceColor,
        backgroundColor: GROUND,
        color: INK,
        borderWidth: "0 0 0 2px",
      }}
    >
      {item.text}
    </div>
  );
}

// Kernel pulse toast — a watcher/timer/manual pulse just fired. Dry pulses
// (logged + toasted, no agent turns) read dim; a real pulse reads amber, the
// same "this cost something" register as an armed region's live dot.
function KernelToast({ record }: { readonly record: PulseRecord }) {
  const targetId = record.regionId ?? record.sourceNodeId;
  const targetNode = state$.doc.peek().nodes.find((node) => node.id === targetId);
  const label = targetNode ? nodeTitle(targetNode) : targetId;
  const count = record.delivered.length;
  const text = `⏻ ${label} pulsed · ${count} agent${count === 1 ? "" : "s"}${record.dry ? " · dry" : ""}`;
  const accent = record.dry ? DIM : HUE.amber;

  return (
    <div
      className="pulse-toast pulse-toast--kernel rounded-xs border-l-2 px-2 py-1.5 text-[10px] leading-tight transition-all duration-200 ease-in-out animate-in fade-in slide-in-from-bottom"
      style={{
        borderLeftColor: accent,
        backgroundColor: GROUND,
        color: record.dry ? DIM : INK,
        opacity: record.dry ? 0.72 : 1,
        borderWidth: "0 0 0 2px",
      }}
      title={record.summary || text}
    >
      {text}
    </div>
  );
}
