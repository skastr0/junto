import type {
  ComponentPropsWithRef,
  ReactNode,
} from "react";
import { Dropdown, type DropdownOption } from "./Dropdown";

/**
 * House form fields — one treatment for every text input and select:
 * inset fill, hairline stroke, cyan focus ring, mono at 12px.
 */
const FIELD_CLASS = [
  "w-full rounded-[5px] border border-stroke bg-inset px-2 py-1.5",
  "text-[12px] text-ink placeholder:text-faint outline-none transition-colors",
  "focus:border-cyan/60 focus:shadow-[0_0_0_3px_var(--color-focus-ring)]",
].join(" ");

/** Form-field trigger chrome shared by Select (design-system Dropdown). */
export const FIELD_SELECT_TRIGGER_CLASS = [
  FIELD_CLASS,
  "cursor-pointer min-h-[34px]",
  "aria-expanded:border-cyan/60 aria-expanded:shadow-[0_0_0_3px_var(--color-focus-ring)]",
].join(" ");

/** Compact inspector/settings chrome for Dropdown triggers. */
export const INSPECTOR_SELECT_TRIGGER_CLASS = [
  "w-full min-h-[30px] rounded-[4px] border border-stroke bg-inset px-2 py-1.5",
  "text-[10px] text-ink outline-none transition-colors cursor-pointer",
  "focus:border-cyan/60 focus:shadow-[0_0_0_3px_var(--color-focus-ring)]",
  "aria-expanded:border-cyan/60 aria-expanded:shadow-[0_0_0_3px_var(--color-focus-ring)]",
].join(" ");

export function Input({
  className,
  ...rest
}: ComponentPropsWithRef<"input">) {
  return <input className={[FIELD_CLASS, className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: ComponentPropsWithRef<"textarea">) {
  return (
    <textarea
      className={[
        FIELD_CLASS,
        "min-h-24 resize-y leading-relaxed",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

/**
 * Form select — design-system Dropdown with field chrome.
 * Never a native &lt;select&gt; (OS menus break the theme and overflow parents).
 */
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  className,
  triggerClassName,
  placeholder = "select…",
  emptyLabel = "no options",
  uppercase = false,
  dense = false,
}: {
  readonly value: string;
  readonly options: ReadonlyArray<DropdownOption>;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly "aria-label": string;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly placeholder?: string;
  readonly emptyLabel?: string;
  readonly uppercase?: boolean;
  /** Smaller inspector/settings density. */
  readonly dense?: boolean;
}) {
  return (
    <Dropdown
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      placeholder={placeholder}
      emptyLabel={emptyLabel}
      uppercase={uppercase}
      className={["w-full", className ?? ""].filter(Boolean).join(" ")}
      triggerClassName={[
        dense ? INSPECTOR_SELECT_TRIGGER_CLASS : FIELD_SELECT_TRIGGER_CLASS,
        triggerClassName ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

/** Field label — the faint uppercase caption above an input. */
export function FieldLabel({ children }: { readonly children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-[9px] uppercase tracking-[0.14em] text-dim">
      {children}
    </label>
  );
}
