import { useEffect, useState } from "react";
import {
  TOKEN_PRESSURE_BOUNDS,
  type TokenPressureThreshold,
} from "@shared/token-pressure";
import { Input, Select } from "../ui";

// One threshold: a kind (percent of the window, or tokens) and its number.
// The number commits on Enter or when the field loses focus, clamped to its
// bounds; Escape drops the typing. Settings and the agent editor both use it.

export const THRESHOLD_KIND_OPTIONS = [
  { value: "percent", label: "% of window" },
  { value: "tokens", label: "tokens" },
] as const;

/** Where a kind starts when the operator switches to it. */
export const thresholdStart = (kind: TokenPressureThreshold["kind"]): TokenPressureThreshold =>
  kind === "percent" ? { kind: "percent", percent: 75 } : { kind: "tokens", tokens: 150_000 };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

/** "150k", "150,000" or "150000" → 150000; "1.5m" → 1500000. */
export const parseTokenCount = (text: string): number | undefined => {
  const match = /^\s*([\d.,_\s]+?)\s*([km])?\s*$/i.exec(text);
  if (!match) return undefined;
  const base = Number(match[1]!.replace(/[,_\s]/g, ""));
  if (!Number.isFinite(base)) return undefined;
  const unit = match[2]?.toLowerCase();
  return base * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1);
};

const shown = (threshold: TokenPressureThreshold): string =>
  threshold.kind === "percent" ? String(threshold.percent) : threshold.tokens.toLocaleString("en-US");

export function ThresholdFields({
  threshold,
  onChange,
  disabled = false,
  label,
  kindPicker = true,
}: {
  readonly threshold: TokenPressureThreshold;
  readonly onChange: (next: TokenPressureThreshold) => void;
  readonly disabled?: boolean;
  /** Names both controls for assistive tech, e.g. "Default limit". */
  readonly label: string;
  /** False when a picker beside it already chose the kind: show the unit only. */
  readonly kindPicker?: boolean;
}) {
  const [draft, setDraft] = useState<string>();
  useEffect(() => setDraft(undefined), [threshold]);

  const commit = (): void => {
    if (draft === undefined) return;
    setDraft(undefined);
    if (threshold.kind === "percent") {
      const value = Number(draft.replace("%", "").trim());
      if (!Number.isFinite(value)) return;
      const { min, max } = TOKEN_PRESSURE_BOUNDS.percent;
      const percent = clamp(value, min, max);
      if (percent !== threshold.percent) onChange({ kind: "percent", percent });
      return;
    }
    const value = parseTokenCount(draft);
    if (value === undefined) return;
    const { min, max } = TOKEN_PRESSURE_BOUNDS.tokens;
    const tokens = clamp(value, min, max);
    if (tokens !== threshold.tokens) onChange({ kind: "tokens", tokens });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-2">
      <Input
        value={draft ?? shown(threshold)}
        inputMode="numeric"
        disabled={disabled}
        aria-label={`${label}, ${threshold.kind === "percent" ? "percent" : "tokens"}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape" && draft !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(undefined);
          }
        }}
      />
      {kindPicker ? (
        <Select
          value={threshold.kind}
          options={THRESHOLD_KIND_OPTIONS}
          disabled={disabled}
          aria-label={`${label}, measured in`}
          dense
          onChange={(kind) => {
            if (kind === threshold.kind) return;
            onChange(thresholdStart(kind === "percent" ? "percent" : "tokens"));
          }}
        />
      ) : (
        <span className="text-[12px] text-dim">{threshold.kind === "percent" ? "% of the context window" : "tokens"}</span>
      )}
    </div>
  );
}
