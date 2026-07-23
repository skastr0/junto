import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * House form fields — one treatment for every text input and select:
 * inset fill, hairline stroke, cyan focus ring, mono at 12px.
 */
const FIELD_CLASS = [
  "w-full rounded-[5px] border border-stroke bg-inset px-2 py-1.5",
  "text-[12px] text-ink placeholder:text-faint outline-none transition-colors",
  "focus:border-cyan/60 focus:shadow-[0_0_0_3px_rgba(57,198,214,0.1)]",
].join(" ");

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={[FIELD_CLASS, className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: {
  readonly className?: string;
  readonly children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={[FIELD_CLASS, "cursor-pointer", className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </select>
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
