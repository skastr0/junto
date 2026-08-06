import { useEffect, useMemo, useState } from "react";
import type { CanvasNode } from "@shared/canvas";
import {
  describeCronExpression,
  expressionFromEveryMinutes,
  isValidCronExpression,
  nextCronOccurrence,
} from "@shared/cron-expression";
import { collectEffectEdgesFrom } from "@shared/scheduler-effects";
import { setNodeTimer } from "../../lib/mutations";
import { nodeTitle } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { DIM, HUE, INK } from "../../lib/theme";
import { FocusSurface } from "../FocusSurface";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { Input, Select } from "../ui";
import { ChevronDown, ChevronRight, X } from "lucide-react";

type FriendlyMode =
  | "every-5"
  | "every-15"
  | "every-30"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

const MODE_OPTIONS: ReadonlyArray<{ readonly value: FriendlyMode; readonly label: string }> = [
  { value: "every-5", label: "Every 5 minutes" },
  { value: "every-15", label: "Every 15 minutes" },
  { value: "every-30", label: "Every 30 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Once a week" },
  { value: "custom", label: "Custom…" },
];

const WEEKDAYS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

const resolveExpression = (
  timer:
    | { readonly expression?: string; readonly everyMinutes?: number }
    | undefined,
): string => {
  const expr = timer?.expression?.trim();
  if (expr && isValidCronExpression(expr)) return expr.replace(/\s+/g, " ");
  if (typeof timer?.everyMinutes === "number" && timer.everyMinutes > 0) {
    return expressionFromEveryMinutes(timer.everyMinutes);
  }
  return "*/30 * * * *";
};

const expressionFromFriendly = (input: {
  readonly mode: FriendlyMode;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: string;
  readonly custom: string;
}): string => {
  const h = Math.min(23, Math.max(0, Math.round(input.hour)));
  const m = Math.min(59, Math.max(0, Math.round(input.minute)));
  switch (input.mode) {
    case "every-5":
      return "*/5 * * * *";
    case "every-15":
      return "*/15 * * * *";
    case "every-30":
      return "*/30 * * * *";
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${input.weekday}`;
    case "custom":
      return input.custom.trim().replace(/\s+/g, " ");
    default:
      return "*/30 * * * *";
  }
};

const friendlyFromExpression = (
  expr: string,
): {
  readonly mode: FriendlyMode;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: string;
} => {
  const source = expr.trim().replace(/\s+/g, " ");
  const map: Record<string, FriendlyMode> = {
    "*/5 * * * *": "every-5",
    "*/15 * * * *": "every-15",
    "*/30 * * * *": "every-30",
    "0 * * * *": "hourly",
  };
  if (map[source]) {
    return { mode: map[source]!, hour: 9, minute: 0, weekday: "1" };
  }
  const parts = source.split(" ");
  if (parts.length === 5) {
    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    const dom = parts[2];
    const mon = parts[3];
    const dow = parts[4]!;
    if (
      Number.isInteger(minute) &&
      Number.isInteger(hour) &&
      dom === "*" &&
      mon === "*"
    ) {
      if (dow === "*") {
        return { mode: "daily", hour, minute, weekday: "1" };
      }
      if (dow === "1-5") {
        return { mode: "weekdays", hour, minute, weekday: "1" };
      }
      if (/^[0-6]$/.test(dow)) {
        return { mode: "weekly", hour, minute, weekday: dow };
      }
    }
  }
  return { mode: "custom", hour: 9, minute: 0, weekday: "1" };
};

const needsTime = (mode: FriendlyMode): boolean =>
  mode === "daily" || mode === "weekdays" || mode === "weekly";

/**
 * Human-first cron schedule. Presets + time; raw expression is advanced-only.
 */
export function CronScheduleSurface({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const initialExpr = resolveExpression(node.ether?.timer);
  const initial = friendlyFromExpression(initialExpr);

  const [mode, setMode] = useState<FriendlyMode>(initial.mode);
  const [hour, setHour] = useState(initial.hour);
  const [minute, setMinute] = useState(initial.minute);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [custom, setCustom] = useState(initialExpr);
  const [advancedOpen, setAdvancedOpen] = useState(initial.mode === "custom");
  const [error, setError] = useState("");
  const [fireBusy, setFireBusy] = useState(false);
  const [fireStatus, setFireStatus] = useState("");

  useEffect(() => {
    const expr = resolveExpression(node.ether?.timer);
    const next = friendlyFromExpression(expr);
    setMode(next.mode);
    setHour(next.hour);
    setMinute(next.minute);
    setWeekday(next.weekday);
    setCustom(expr);
    setAdvancedOpen(next.mode === "custom");
    setError("");
    setFireStatus("");
  }, [node.id, node.ether?.timer?.expression, node.ether?.timer?.everyMinutes]);

  const expression = useMemo(
    () =>
      expressionFromFriendly({
        mode,
        hour,
        minute,
        weekday,
        custom,
      }),
    [mode, hour, minute, weekday, custom],
  );

  // Keep custom field in sync when using friendly modes (for advanced reveal).
  useEffect(() => {
    if (mode === "custom") return;
    setCustom(
      expressionFromFriendly({ mode, hour, minute, weekday, custom: "" }),
    );
  }, [mode, hour, minute, weekday]);

  const nextDue = useMemo(() => {
    if (!isValidCronExpression(expression)) return undefined;
    return nextCronOccurrence(expression, Date.now());
  }, [expression]);

  const commit = () => {
    const cleaned =
      mode === "custom"
        ? custom.trim().replace(/\s+/g, " ")
        : expressionFromFriendly({ mode, hour, minute, weekday, custom: "" });
    if (!isValidCronExpression(cleaned)) {
      setError("That schedule is not valid");
      return;
    }
    setError("");
    setNodeTimer(node.id, { expression: cleaned });
    onClose();
  };

  const nextLabel = nextDue
    ? new Date(nextDue).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

  const timeValue = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  // Fire now scopes to this cron only — its outbound does wires, nothing else.
  const effectCount = collectEffectEdgesFrom(state$.doc.peek(), node.id).length;
  const cronLabel = nodeTitle(node);
  const fireHint =
    effectCount === 0
      ? "No actions linked yet. Draw an effect wire out of this cron."
      : `Runs this cron's ${effectCount} linked action${effectCount === 1 ? "" : "s"} now. Not a page watch.`;

  const fireNow = async () => {
    const api = window.vellumCommand;
    const canvas = state$.canvasName.peek();
    if (!api?.schedulerFire || !canvas) {
      setFireStatus("Fire is unavailable");
      return;
    }
    setFireBusy(true);
    setFireStatus("");
    try {
      const result = await api.schedulerFire(canvas, node.id);
      setFireStatus(result.ok ? result.message : result.error);
      if (result.ok) {
        const { noteSchedulerFire } = await import("../../lib/edge-sparks");
        noteSchedulerFire(state$.doc.peek(), node.id);
      }
    } catch (error) {
      setFireStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setFireBusy(false);
    }
  };

  return (
    <FocusSurface
      measure="form"
      height="fit"
      layer="detail"
      label="Cron schedule"
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="rts-kind-form-panel nowheel"
    >
      <OverlayHeader
        eyebrow="cron"
        title="When should this fire?"
        status={describeCronExpression(expression)}
        actions={
          <IconButton aria-label="Close" title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <div className="rts-kind-form-body inspector-body flex flex-col gap-3">
        <label className="inspector-editor">
          <span>frequency</span>
          <Select
            dense
            aria-label="Frequency"
            value={mode}
            options={MODE_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
            }))}
            onChange={(value) => {
              const next = value as FriendlyMode;
              setMode(next);
              setAdvancedOpen(next === "custom");
              setError("");
            }}
          />
        </label>

        {needsTime(mode) ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="inspector-editor" style={{ margin: 0 }}>
              <span>time</span>
              <Input
                type="time"
                aria-label="Time of day"
                value={timeValue}
                onChange={(event) => {
                  const [h, m] = event.target.value.split(":").map(Number);
                  if (Number.isFinite(h)) setHour(h!);
                  if (Number.isFinite(m)) setMinute(m!);
                  setError("");
                }}
              />
            </label>
            {mode === "weekly" ? (
              <label className="inspector-editor" style={{ margin: 0 }}>
                <span>day</span>
                <Select
                  dense
                  aria-label="Day of week"
                  value={weekday}
                  options={WEEKDAYS.map((d) => ({
                    value: d.value,
                    label: d.label,
                  }))}
                  onChange={(value) => {
                    setWeekday(value);
                    setError("");
                  }}
                />
              </label>
            ) : (
              <div />
            )}
          </div>
        ) : null}

        <div className="text-[11px] tabular-nums" style={{ color: DIM }}>
          Next: <span style={{ color: INK }}>{nextLabel}</span>
        </div>

        <button
          type="button"
          className="flex items-center gap-1 self-start border-0 bg-transparent p-0 text-[10px] uppercase tracking-[0.12em]"
          style={{ color: DIM }}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          expression
        </button>

        {advancedOpen ? (
          <label className="inspector-editor">
            <span>cron expression</span>
            <Input
              aria-label="Cron expression"
              className="font-mono"
              value={mode === "custom" ? custom : expression}
              onChange={(event) => {
                setMode("custom");
                setCustom(event.target.value);
                setError("");
              }}
              spellCheck={false}
            />
          </label>
        ) : null}

        {error ? (
          <div className="text-[10px]" style={{ color: HUE.crimson }}>
            {error}
          </div>
        ) : null}

        <div
          className="flex flex-col gap-1.5 border-t pt-2"
          style={{ borderColor: "var(--color-overlay-3)" }}
        >
          <div className="text-[11px] leading-snug" style={{ color: DIM }}>
            {fireHint}
          </div>
          <Button
            size="sm"
            variant="chrome"
            disabled={fireBusy}
            onClick={() => void fireNow()}
            data-testid="cron-fire-now"
            title={`Run ${cronLabel}'s linked actions now`}
          >
            {fireBusy ? "Firing…" : "Fire this cron now"}
          </Button>
          {fireStatus ? (
            <div className="text-[11px]" style={{ color: INK }}>
              {fireStatus}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="chrome" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={commit}>
            Save
          </Button>
        </div>
      </div>
    </FocusSurface>
  );
}
