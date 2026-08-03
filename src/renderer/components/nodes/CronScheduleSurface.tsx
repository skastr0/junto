import { useEffect, useMemo, useState } from "react";
import type { CanvasNode } from "@shared/canvas";
import {
  CRON_PRESETS,
  describeCronExpression,
  expressionFromEveryMinutes,
  isValidCronExpression,
  nextCronOccurrence,
  parseCronExpression,
} from "@shared/cron-expression";
import { setNodeTimer } from "../../lib/mutations";
import { DIM, HUE, INK } from "../../lib/theme";
import { FocusSurface } from "../FocusSurface";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { Select } from "../ui";
import { X } from "lucide-react";

const FIELD_LABELS = [
  "minute",
  "hour",
  "day of month",
  "month",
  "day of week",
] as const;

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

/**
 * Full cron schedule editor — FocusSurface form.
 * Expression is standard 5-field crontab; next fire is projected for the operator.
 */
export function CronScheduleSurface({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const initial = resolveExpression(node.ether?.timer);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(resolveExpression(node.ether?.timer));
    setError("");
  }, [node.id, node.ether?.timer?.expression, node.ether?.timer?.everyMinutes]);

  const parts = draft.trim().split(/\s+/);
  const fieldValues = FIELD_LABELS.map((_, i) => parts[i] ?? "");

  const setField = (index: number, value: string) => {
    const next = FIELD_LABELS.map((_, i) =>
      i === index ? value.trim() || "*" : fieldValues[i] || "*",
    );
    setDraft(next.join(" "));
    setError("");
  };

  const parsed = useMemo(() => parseCronExpression(draft), [draft]);
  const nextDue = useMemo(() => {
    if ("error" in parsed) return undefined;
    return nextCronOccurrence(parsed.source, Date.now());
  }, [parsed]);

  const commit = () => {
    const cleaned = draft.trim().replace(/\s+/g, " ");
    if (!isValidCronExpression(cleaned)) {
      setError(
        "error" in parsed
          ? parsed.error
          : "invalid expression",
      );
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
        title="Schedule"
        status={describeCronExpression(draft)}
        actions={
          <IconButton aria-label="Close" title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <div className="rts-kind-form-body inspector-body flex flex-col gap-3">
        <label className="inspector-editor">
          <span>expression</span>
          <input
            aria-label="Cron expression"
            className="font-mono"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
            spellCheck={false}
          />
        </label>

        <div className="grid grid-cols-5 gap-1.5">
          {FIELD_LABELS.map((label, index) => (
            <label key={label} className="inspector-editor" style={{ margin: 0 }}>
              <span className="truncate">{label}</span>
              <input
                aria-label={label}
                className="font-mono"
                value={fieldValues[index] ?? "*"}
                onChange={(event) => setField(index, event.target.value)}
                spellCheck={false}
              />
            </label>
          ))}
        </div>

        <label className="inspector-editor">
          <span>preset</span>
          <Select
            dense
            aria-label="Cron preset"
            value={
              CRON_PRESETS.some((p) => p.expression === draft.trim().replace(/\s+/g, " "))
                ? draft.trim().replace(/\s+/g, " ")
                : ""
            }
            options={[
              { value: "", label: "custom" },
              ...CRON_PRESETS.map((p) => ({
                value: p.expression,
                label: p.label,
              })),
            ]}
            onChange={(value) => {
              if (!value) return;
              setDraft(value);
              setError("");
            }}
          />
        </label>

        <div className="text-[11px]" style={{ color: DIM }}>
          next fire{" "}
          <span className="tabular-nums" style={{ color: INK }}>
            {nextLabel}
          </span>
        </div>

        {error ? (
          <div className="text-[10px]" style={{ color: HUE.crimson }}>
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="chrome" onClick={onClose}>
            cancel
          </Button>
          <Button size="sm" variant="primary" onClick={commit}>
            save schedule
          </Button>
        </div>
      </div>
    </FocusSurface>
  );
}
