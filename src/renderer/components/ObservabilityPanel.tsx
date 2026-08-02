import { use$ } from "@legendapp/state/react";
import {
  ArrowDown,
  CirclePause,
  Eraser,
  Filter,
  Play,
  ScrollText,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ObservabilityLogEntry,
  ObservabilityLogLevel,
  ObservabilityLogSource,
} from "@shared/observability";
import { state$ } from "../lib/state";
import { DIM, FAINT, GREEN, HUE, INK, RAISE, WELL, withAlpha } from "../lib/theme";
import { IconButton, OverlayHeader } from "./ui";

const LEVELS: ReadonlyArray<ObservabilityLogLevel> = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

const SOURCES: ReadonlyArray<ObservabilityLogSource> = [
  "effect",
  "main",
  "renderer",
  "system",
];

const LEVEL_COLOR: Record<ObservabilityLogLevel, string> = {
  trace: FAINT,
  debug: DIM,
  info: HUE.steel,
  warn: HUE.amber,
  error: HUE.crimson,
  fatal: HUE.crimson,
};

const SOURCE_COLOR: Record<ObservabilityLogSource, string> = {
  effect: HUE.violet,
  main: HUE.cyan,
  renderer: HUE.gold,
  system: GREEN,
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
};

function LevelChip({
  level,
  active,
  onToggle,
}: {
  readonly level: ObservabilityLogLevel;
  readonly active: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className="rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] transition"
      style={{
        color: active ? LEVEL_COLOR[level] : FAINT,
        border: `1px solid ${withAlpha(LEVEL_COLOR[level], active ? 0.45 : 0.18)}`,
        background: active ? withAlpha(LEVEL_COLOR[level], 0.1) : "transparent",
      }}
    >
      {level}
    </button>
  );
}

function SourceChip({
  source,
  active,
  onToggle,
}: {
  readonly source: ObservabilityLogSource;
  readonly active: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className="rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] transition"
      style={{
        color: active ? SOURCE_COLOR[source] : FAINT,
        border: `1px solid ${withAlpha(SOURCE_COLOR[source], active ? 0.45 : 0.18)}`,
        background: active ? withAlpha(SOURCE_COLOR[source], 0.1) : "transparent",
      }}
    >
      {source}
    </button>
  );
}

function LogRow({ entry }: { readonly entry: ObservabilityLogEntry }) {
  const [open, setOpen] = useState(false);
  const hasMeta =
    Boolean(entry.fiber) ||
    (entry.spans?.length ?? 0) > 0 ||
    (entry.annotations && Object.keys(entry.annotations).length > 0);
  return (
    <div
      className="border-b px-3 py-1.5 font-mono text-[11px] leading-relaxed"
      style={{ borderColor: "rgba(237,230,218,0.06)" }}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => hasMeta && setOpen((v) => !v)}
        style={{ cursor: hasMeta ? "pointer" : "default" }}
      >
        <span className="shrink-0 tabular-nums" style={{ color: FAINT, width: 88 }}>
          {formatTime(entry.ts)}
        </span>
        <span
          className="w-10 shrink-0 uppercase tracking-[0.08em]"
          style={{ color: LEVEL_COLOR[entry.level], fontSize: 9, paddingTop: 2 }}
        >
          {entry.level}
        </span>
        <span
          className="w-14 shrink-0 uppercase tracking-[0.08em]"
          style={{ color: SOURCE_COLOR[entry.source], fontSize: 9, paddingTop: 2 }}
        >
          {entry.source}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words" style={{ color: INK }}>
          {entry.message}
        </span>
      </button>
      {open && hasMeta ? (
        <div
          className="mt-1 ml-[calc(88px+0.5rem)] space-y-0.5 text-[10px]"
          style={{ color: DIM }}
        >
          {entry.fiber ? <div>fiber · {entry.fiber}</div> : null}
          {entry.spans && entry.spans.length > 0 ? (
            <div>spans · {entry.spans.join(" › ")}</div>
          ) : null}
          {entry.annotations
            ? Object.entries(entry.annotations).map(([key, value]) => (
                <div key={key}>
                  <span style={{ color: HUE.steel }}>{key}</span>
                  {" · "}
                  {value}
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

export function ObservabilityPanel() {
  const open = use$(state$.observabilityOpen);
  const [entries, setEntries] = useState<ReadonlyArray<ObservabilityLogEntry>>([]);
  const [total, setTotal] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [q, setQ] = useState("");
  const [levels, setLevels] = useState<ReadonlyArray<ObservabilityLogLevel>>(LEVELS);
  const [sources, setSources] = useState<ReadonlyArray<ObservabilityLogSource>>(SOURCES);
  const [live, setLive] = useState(true);
  const [stickBottom, setStickBottom] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const newestIdRef = useRef(0);

  const close = useCallback(() => {
    state$.observabilityOpen.set(false);
  }, []);

  const load = useCallback(async () => {
    if (!window.vellum?.observabilityQuery) return;
    try {
      const snap = await window.vellum.observabilityQuery({
        limit: 500,
        q: q.trim() || undefined,
        levels: levels.length === LEVELS.length ? undefined : [...levels],
        sources: sources.length === SOURCES.length ? undefined : [...sources],
      });
      setEntries(snap.entries);
      setTotal(snap.total);
      setDropped(snap.dropped);
      newestIdRef.current = snap.newestId;
    } catch {
      // Unreachable backend: leave prior frame.
    }
  }, [q, levels, sources]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open || !live) return;
    const unsub = window.vellum?.onObservabilityLog?.((entry) => {
      if (levels.length !== LEVELS.length && !levels.includes(entry.level)) return;
      if (sources.length !== SOURCES.length && !sources.includes(entry.source)) return;
      const needle = q.trim().toLowerCase();
      if (needle && !entry.message.toLowerCase().includes(needle)) {
        // Full filter (annotations/spans) still applies on next full reload;
        // live path is message-only for speed.
        return;
      }
      newestIdRef.current = Math.max(newestIdRef.current, entry.id);
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > 800 ? next.slice(-800) : next;
      });
      setTotal((t) => t + 1);
    });
    return () => {
      unsub?.();
    };
  }, [open, live, levels, sources, q]);

  useEffect(() => {
    if (!open || !stickBottom) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, open, stickBottom]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const toggleLevel = (level: ObservabilityLogLevel) => {
    setLevels((prev) =>
      prev.includes(level)
        ? prev.filter((l) => l !== level)
        : [...prev, level],
    );
  };

  const toggleSource = (source: ObservabilityLogSource) => {
    setSources((prev) =>
      prev.includes(source)
        ? prev.filter((s) => s !== source)
        : [...prev, source],
    );
  };

  const clear = async () => {
    if (!window.vellum?.observabilityClear) return;
    await window.vellum.observabilityClear();
    setEntries([]);
    setTotal(0);
    setDropped(0);
    newestIdRef.current = 0;
  };

  const status = useMemo(() => {
    const parts = [`${entries.length} shown`];
    if (total > 0) parts.push(`${total} in ring`);
    if (dropped > 0) parts.push(`${dropped} dropped`);
    parts.push(live ? "live" : "paused");
    return parts.join(" · ");
  }, [entries.length, total, dropped, live]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-stretch justify-end"
      role="presentation"
    >
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close logs explorer"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}
        onClick={close}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Observability logs"
        className="relative z-10 flex h-full w-[min(720px,92vw)] flex-col border-l"
        style={{
          borderColor: "rgba(237,230,218,0.12)",
          background: WELL,
        }}
      >
        <OverlayHeader
          eyebrow="observability"
          title="Logs"
          status={status}
          actions={
            <>
              <IconButton
                aria-label={live ? "Pause live tail" : "Resume live tail"}
                title={live ? "pause live" : "resume live"}
                onClick={() => setLive((v) => !v)}
              >
                {live ? <CirclePause size={14} /> : <Play size={14} />}
              </IconButton>
              <IconButton
                aria-label="Scroll to latest"
                title="scroll to latest"
                onClick={() => {
                  setStickBottom(true);
                  const el = listRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                }}
              >
                <ArrowDown size={14} />
              </IconButton>
              <IconButton
                aria-label="Clear ring"
                title="clear ring"
                onClick={() => void clear()}
              >
                <Eraser size={14} />
              </IconButton>
              <IconButton aria-label="Close logs" title="close" onClick={close}>
                <X size={14} />
              </IconButton>
            </>
          }
        />

        <div
          className="flex shrink-0 flex-col gap-2 border-b px-3 py-2"
          style={{ borderColor: "rgba(237,230,218,0.1)", background: RAISE }}
        >
          <label className="flex items-center gap-2">
            <Filter size={12} style={{ color: FAINT }} />
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="filter message / fiber / spans…"
              aria-label="Filter logs"
              className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 font-mono text-[11px] outline-none"
              style={{
                borderColor: "rgba(237,230,218,0.14)",
                color: INK,
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-1">
            {LEVELS.map((level) => (
              <LevelChip
                key={level}
                level={level}
                active={levels.includes(level)}
                onToggle={() => toggleLevel(level)}
              />
            ))}
            <span className="mx-1" style={{ color: FAINT }}>
              |
            </span>
            {SOURCES.map((source) => (
              <SourceChip
                key={source}
                source={source}
                active={sources.includes(source)}
                onToggle={() => toggleSource(source)}
              />
            ))}
          </div>
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(event) => {
            const el = event.currentTarget;
            const nearBottom =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            setStickBottom(nearBottom);
          }}
        >
          {entries.length === 0 ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
              style={{ color: DIM }}
            >
              <ScrollText size={22} style={{ color: FAINT }} />
              <p className="font-mono text-[12px]">No log lines match.</p>
              <p className="max-w-sm text-[11px]" style={{ color: FAINT }}>
                The process ring captures Effect logs, main console, and renderer
                console. Emit traffic or loosen filters.
              </p>
            </div>
          ) : (
            entries.map((entry) => <LogRow key={entry.id} entry={entry} />)
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
