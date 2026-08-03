import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { timerActivity, watcherActivity } from "../../lib/activity";
import { kernel$, type WatcherRuntimeState } from "../../lib/kernel-view";
import { editText } from "../../lib/mutations";
import { INK } from "../../lib/theme";

type RenameProps = {
  readonly renaming?: boolean;
  readonly onRequestRename?: () => void;
  readonly onRenameDone?: () => void;
};

const REFRESH_MS = 30_000;

function useRelativeNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useFreshFire(lastFiredAt: number | undefined): boolean {
  const initialized = useRef(false);
  const previous = useRef<number | undefined>(undefined);
  const [firing, setFiring] = useState(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      previous.current = lastFiredAt;
      return;
    }
    if (lastFiredAt === undefined || lastFiredAt === previous.current) return;
    previous.current = lastFiredAt;
    setFiring(true);
    const clear = window.setTimeout(() => setFiring(false), 920);
    return () => window.clearTimeout(clear);
  }, [lastFiredAt]);

  return firing;
}

const titleOf = (node: CanvasNode, fallback: string): string =>
  node.type === "text" ? node.text.split("\n")[0]?.trim() || fallback : fallback;

const formatCountdown = (nextFire: number | undefined, now: number): string => {
  if (nextFire === undefined) return "—";
  const minutes = Math.max(0, Math.round((nextFire - now) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours)}h${remainder > 0 ? ` ${String(remainder)}m` : ""}`;
};

const formatAgo = (lastFiredAt: number | undefined, now: number): string | undefined => {
  if (lastFiredAt === undefined) return undefined;
  const minutes = Math.max(0, Math.round((now - lastFiredAt) / 60_000));
  if (minutes < 1) return "fired now";
  if (minutes < 60) return `fired ${String(minutes)}m ago`;
  return `fired ${String(Math.round(minutes / 60))}h ago`;
};

const operatorSymbol = (op: "gt" | "lt" | "eq" | undefined): string =>
  op === "gt" ? ">" : op === "lt" ? "<" : op === "eq" ? "=" : "?";

function InstrumentLabel({
  kind,
  node,
  title,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly kind: string;
  readonly node: CanvasNode;
  readonly title: string;
} & RenameProps) {
  const customTitle = title.toLowerCase() !== kind.toLowerCase();
  const rawText = node.type === "text" ? node.text : "";
  const commitRename = (nextFirst: string) => {
    const rest = rawText.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${nextFirst}\n${rest}` : nextFirst);
  };

  if (renaming && onRenameDone) {
    return (
      <div className="special-node__label">
        <span className="special-node__kind">{kind}</span>
        <input
          ref={(el) => {
            el?.focus();
            el?.select();
          }}
          aria-label="Rename"
          className="special-node__name nodrag nopan nowheel min-w-0 flex-1 bg-transparent outline-none"
          style={{ color: INK }}
          defaultValue={title}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            if (next && next !== title) commitRename(next);
            onRenameDone();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onRenameDone();
            }
          }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <div className="special-node__label">
      <span className="special-node__kind">{kind}</span>
      {customTitle ? (
        <button
          type="button"
          className="special-node__name nodrag nopan truncate bg-transparent p-0 text-left"
          title={onRequestRename ? "Rename" : title}
          onDoubleClick={(event) => {
            if (event.shiftKey || !onRequestRename) return;
            event.preventDefault();
            event.stopPropagation();
            onRequestRename();
          }}
        >
          {title}
        </button>
      ) : onRequestRename ? (
        <button
          type="button"
          className="special-node__name nodrag nopan truncate bg-transparent p-0 text-left opacity-0"
          aria-label="Rename"
          title="Rename"
          onDoubleClick={(event) => {
            if (event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            onRequestRename();
          }}
        >
          {kind}
        </button>
      ) : null}
    </div>
  );
}

export function CronCard({
  node,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & RenameProps) {
  const nextFire = use$(kernel$.nextFire[node.id]) as number | undefined;
  const now = useRelativeNow();
  const everyMinutes = node.ether?.timer?.everyMinutes;
  const intervalMs = everyMinutes && everyMinutes > 0 ? everyMinutes * 60_000 : undefined;
  const remainingMs = nextFire === undefined ? undefined : Math.max(0, nextFire - now);
  const progress =
    intervalMs === undefined || remainingMs === undefined
      ? 0
      : Math.max(0, Math.min(1, 1 - remainingMs / intervalMs));
  const activity = timerActivity({ nextFire, now });
  const due = activity.label === "due";
  const title = titleOf(node, "cron");

  return (
    <div
      className={`special-node special-node--cron${due ? " is-triggering" : ""}`}
      role="group"
      aria-label={`${title}, ${activity.label}`}
    >
      <InstrumentLabel
        kind="cron"
        node={node}
        title={title}
        renaming={renaming}
        onRequestRename={onRequestRename}
        onRenameDone={onRenameDone}
      />
      <svg className="special-cron" viewBox="0 0 200 96" aria-hidden="true">
        <path className="special-cron__rail" d="M20 78 A78 70 0 0 1 180 78" pathLength="100" />
        <path
          className="special-cron__progress"
          d="M20 78 A78 70 0 0 1 180 78"
          pathLength="100"
          strokeDasharray={`${String(progress * 100)} 100`}
        />
        <path className="special-cron__ticks" d="M34 67 A66 58 0 0 1 166 67" pathLength="100" />
        <path className="special-cron__notch" d="M172 68 L180 78 L169 81" />
        <circle className="special-cron__event" cx="181" cy="78" r="3.5" />
        <path className="special-cron__outlet" d="M184 78 H200" />
      </svg>
      <div className="special-cron__readout">
        <span className="special-cron__time">{formatCountdown(nextFire, now)}</span>
        <span className="special-node__detail">
          {everyMinutes ? `every ${String(everyMinutes)}m` : "interval unset"}
        </span>
      </div>
    </div>
  );
}

function GaugeGraphic({ status, firing }: { readonly status: string; readonly firing: boolean }) {
  const signalPath =
    status === "satisfied"
      ? "M18 48 C32 48 34 25 46 25 S60 48 72 48 S86 20 98 20 S114 42 126 42 S140 16 158 16"
      : "M18 48 C32 48 34 38 46 38 S60 51 72 51 S86 35 98 35 S114 48 126 48 S140 36 158 36";
  return (
    <svg className="special-gauge" viewBox="0 0 220 72" aria-hidden="true">
      <path className="special-gauge__inlet" d="M0 48 H18" />
      <path className="special-gauge__bracket" d="M30 12 H20 V62 H30 M190 12 H200 V62 H190" />
      <path className="special-gauge__signal" d={signalPath} />
      <path className="special-gauge__threshold" d="M158 12 V62" />
      <path className="special-gauge__outlet" d="M158 36 H220" />
      <circle className={`special-gauge__spark${firing ? " is-live" : ""}`} cx="158" cy="16" r="3.5" />
      <circle className="special-gauge__terminal" cx="218" cy="36" r="2.5" />
    </svg>
  );
}

function RelayGraphic({ status, firing }: { readonly status: string; readonly firing: boolean }) {
  return (
    <svg className="special-relay" viewBox="0 0 220 76" aria-hidden="true">
      <path className="special-relay__inlet" d="M0 38 H34" />
      <g className="special-relay__aperture">
        <path d="M70 10 H150" />
        <path d="M150 10 L184 38" />
        <path d="M184 38 L150 66" />
        <path d="M150 66 H70" />
        <path d="M70 66 L36 38" />
        <path d="M36 38 L70 10" />
      </g>
      <circle className="special-relay__core" cx="110" cy="38" r={status === "satisfied" ? 7 : 4} />
      <path className="special-relay__outlet" d="M184 38 H196 L220 24 M196 38 L220 52" />
      <circle className={`special-relay__token${firing ? " is-live" : ""}`} cx="36" cy="38" r="3.5" />
      <circle className="special-relay__terminal" cx="218" cy="24" r="2.5" />
      <circle className="special-relay__terminal" cx="218" cy="52" r="2.5" />
    </svg>
  );
}

function WatcherInstrument({
  node,
  kind,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  readonly kind: "gauge" | "relay";
} & RenameProps) {
  const runtime = use$(kernel$.watchers[node.id]) as WatcherRuntimeState | undefined;
  const now = useRelativeNow();
  const status = runtime?.status ?? "unknown";
  const detail = runtime?.detail ?? (kind === "gauge" ? "watching" : "source unset");
  const activity = watcherActivity(status);
  const firing = useFreshFire(runtime?.lastFiredAt);
  const title = titleOf(node, kind);
  const watch = node.ether?.watch;
  const rule =
    kind === "gauge" && watch?.stat && watch.value !== undefined
      ? `${watch.stat} ${operatorSymbol(watch.op)} ${String(watch.value)}`
      : detail;
  const lastFired = formatAgo(runtime?.lastFiredAt, now);
  const className = [
    "special-node",
    `special-node--${kind}`,
    `is-${status}`,
    firing ? "is-triggering" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={className} role="group" aria-label={`${title}, ${activity.label}, ${detail}`}>
      <InstrumentLabel
        kind={kind}
        node={node}
        title={title}
        renaming={renaming}
        onRequestRename={onRequestRename}
        onRenameDone={onRenameDone}
      />
      {kind === "gauge" ? (
        <GaugeGraphic status={status} firing={firing} />
      ) : (
        <RelayGraphic status={status} firing={firing} />
      )}
      <div className="special-node__footer">
        <span className="special-node__rule" title={detail}>{rule}</span>
        {lastFired ? <span className="special-node__detail">{lastFired}</span> : null}
      </div>
    </div>
  );
}

export function GaugeCard({
  node,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & RenameProps) {
  return (
    <WatcherInstrument
      node={node}
      kind="gauge"
      renaming={renaming}
      onRequestRename={onRequestRename}
      onRenameDone={onRenameDone}
    />
  );
}

export function RelayCard({
  node,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & RenameProps) {
  return (
    <WatcherInstrument
      node={node}
      kind="relay"
      renaming={renaming}
      onRequestRename={onRequestRename}
      onRenameDone={onRenameDone}
    />
  );
}
