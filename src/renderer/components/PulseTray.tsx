import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { state$ } from "../lib/state";
import { comparePulse, type PulseItem } from "../lib/pulse";
import { SOURCE_HUE, GROUND, INK } from "../lib/theme";

const TOAST_AUTO_DISMISS_MS = 8000;
const MAX_VISIBLE_TOASTS = 4;

export function PulseTray() {
  const snapshots = use$(state$.snapshots);
  const prevSnapshotsRef = useRef(snapshots);
  const [toasts, setToasts] = useState<PulseItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // When snapshots change, compute diff and append new items
  useEffect(() => {
    const prev = prevSnapshotsRef.current;
    const next = snapshots;

    if (prev && next) {
      const items = comparePulse(prev, next);
      if (items.length > 0) {
        setToasts((current) => {
          const updated = [...current, ...items];
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
        <Toast key={toast.id} item={toast} />
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
