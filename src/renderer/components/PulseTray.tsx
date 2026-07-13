import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { state$ } from "../lib/state";
import { comparePulse, type PulseItem } from "../lib/pulse";
import { kernel$, type PulseRecord } from "../lib/kernel-state";
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

export function PulseTray() {
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
          const updated = [...current, ...items.map((item): TrayToast => ({ id: item.id, kind: "snapshot", item }))];
          // Remove old timers for newly added items only
          for (const item of items) {
            const existingTimer = timersRef.current.get(item.id);
            if (existingTimer) clearTimeout(existingTimer);
          }
          return updated;
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
          const updated = [...current, ...added.map((record): TrayToast => ({ id: `kernel-${record.id}`, kind: "kernel", record }))];
          for (const record of added) {
            const key = `kernel-${record.id}`;
            const existingTimer = timersRef.current.get(key);
            if (existingTimer) clearTimeout(existingTimer);
          }
          return updated;
        });
      }
    }
    prevPulseLogRef.current = next;
  }, [pulseLog]);

  // Auto-dismiss toasts after TOAST_AUTO_DISMISS_MS
  useEffect(() => {
    const removeToast = (id: string) => {
      setToasts((current) => current.filter((t) => t.id !== id));
      const timer = timersRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    };

    for (const toast of toasts) {
      // Skip if already has a timer
      if (timersRef.current.has(toast.id)) continue;

      const timer = setTimeout(() => removeToast(toast.id), TOAST_AUTO_DISMISS_MS);
      timersRef.current.set(toast.id, timer);
    }

    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, [toasts]);

  const visibleToasts = toasts.slice(0, MAX_VISIBLE_TOASTS);
  const hiddenCount = Math.max(0, toasts.length - MAX_VISIBLE_TOASTS);

  return (
    <div
      className="pulse-tray fixed bottom-0 left-0 z-30 flex flex-col gap-1 p-3 pointer-events-none"
      style={{ maxWidth: "300px" }}
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
