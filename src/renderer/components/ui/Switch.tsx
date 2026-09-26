import type { ComponentPropsWithRef } from "react";

/**
 * An on/off switch, drawn on the native checkbox so it keeps keyboard,
 * focus and form behaviour. Off is a quiet track; on takes the one accent.
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  ...rest
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (on: boolean) => void;
  readonly className?: string;
} & Omit<ComponentPropsWithRef<"input">, "type" | "role" | "checked" | "onChange" | "className">) {
  return (
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      aria-checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      className={[
        "relative m-0 h-5 w-[34px] flex-none cursor-pointer appearance-none rounded-full",
        "border border-stroke bg-shadow-2",
        "transition-colors duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        "after:absolute after:top-[2px] after:left-[2px] after:size-[14px] after:rounded-full after:bg-dim after:content-['']",
        "after:transition-[transform,background-color] after:duration-[180ms] after:ease-[cubic-bezier(0.22,1,0.36,1)]",
        "hover:border-amber/45 checked:border-amber checked:bg-amber/[0.28]",
        "checked:after:translate-x-[14px] checked:after:bg-amber",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber",
        "disabled:cursor-default disabled:opacity-40",
        "motion-reduce:transition-none motion-reduce:after:transition-none",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}
