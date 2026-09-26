import { useEffect, useState, type CSSProperties } from "react";

/**
 * A level from 0 to 1 on the native range input (keyboard, focus and
 * accessibility stay the browser's). The track fills with the accent up to
 * the thumb. The value is held locally while it moves and committed once
 * when the drag or key press ends, so a drag is one write, not a hundred.
 */
export function Slider({
  value,
  onCommit,
  label,
  disabled,
  className,
}: {
  /** 0..1 */
  readonly value: number;
  readonly onCommit: (value: number) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const [draft, setDraft] = useState<number>();
  useEffect(() => setDraft(undefined), [value]);
  const shown = draft ?? value;
  const percent = Math.round(shown * 100);

  const commit = (): void => {
    if (draft === undefined || draft === value) return;
    onCommit(draft);
  };

  return (
    <input
      type="range"
      min={0}
      max={100}
      step={1}
      value={percent}
      aria-label={label}
      aria-valuetext={`${percent}%`}
      disabled={disabled}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) setDraft(Math.min(1, Math.max(0, next / 100)));
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      style={{ "--fill": `${percent}%` } as CSSProperties}
      className={[
        "h-4 w-full min-w-0 cursor-pointer appearance-none bg-transparent outline-none",
        "disabled:cursor-default disabled:opacity-40",
        "[&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full",
        "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-amber)_var(--fill),var(--color-stroke)_var(--fill))]",
        "[&::-webkit-slider-thumb]:mt-[-5px] [&::-webkit-slider-thumb]:size-[13px] [&::-webkit-slider-thumb]:appearance-none",
        "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-ground",
        "[&::-webkit-slider-thumb]:bg-amber [&::-webkit-slider-thumb]:transition-transform",
        "hover:[&::-webkit-slider-thumb]:scale-110",
        "focus-visible:[&::-webkit-slider-thumb]:outline-2 focus-visible:[&::-webkit-slider-thumb]:outline-offset-2",
        "focus-visible:[&::-webkit-slider-thumb]:outline-amber",
        "motion-reduce:[&::-webkit-slider-thumb]:transition-none",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
