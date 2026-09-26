import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { Kbd } from "./Kbd";

/**
 * HelpMap — instrument chrome for protocol / interaction / shortcut maps.
 *
 * Compose across the app:
 *   HelpMap (shell) → HelpMapGroup → HelpMapKeys | custom body
 *   Kbd for any standalone key chip outside a map
 *
 * Placement is the caller's job (`className` / `style`). Use
 * `help-map--dock-top-right` for the station bar default, or nest
 * inline without a dock modifier.
 */

export type HelpMapKeyRow = {
  readonly keys: string;
  readonly action: string;
};

export type HelpMapTone = "amber" | "cyan";

export function HelpMap({
  eyebrow,
  title,
  onClose,
  closeLabel = "Close",
  tone = "amber",
  children,
  className,
  "aria-label": ariaLabel,
  ...rest
}: {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly onClose?: () => void;
  readonly closeLabel?: string;
  readonly tone?: HelpMapTone;
  readonly children: ReactNode;
  readonly className?: string;
  readonly "aria-label"?: string;
} & Omit<HTMLAttributes<HTMLElement>, "title" | "children">) {
  return (
    <aside
      className={["help-map", tone === "cyan" ? "help-map--cyan" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      role="dialog"
      aria-label={ariaLabel ?? (typeof title === "string" ? title : "Help")}
      {...rest}
    >
      <div className="help-map__header">
        <div className="help-map__heading">
          {eyebrow ? <div className="help-map__eyebrow">{eyebrow}</div> : null}
          <strong className="help-map__title">{title}</strong>
        </div>
        {onClose ? (
          <button type="button" className="help-map__close" aria-label={closeLabel} onClick={onClose}>
            ×
          </button>
        ) : null}
      </div>
      <div className="help-map__body">{children}</div>
    </aside>
  );
}

/** Section label + content block (pointer, keys, adapters, …). */
export function HelpMapGroup({
  label,
  children,
  className,
  "aria-label": ariaLabel,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly "aria-label"?: string;
}) {
  return (
    <section
      className={["help-map__group", className ?? ""].filter(Boolean).join(" ")}
      aria-label={ariaLabel ?? label}
    >
      <div className="help-map__section">{label}</div>
      {children}
    </section>
  );
}

/** Key / gesture → action rows. */
export function HelpMapKeys({
  rows,
  className,
  keyWidth,
}: {
  readonly rows: ReadonlyArray<HelpMapKeyRow>;
  readonly className?: string;
  /** CSS length for the keys column (default 132px). */
  readonly keyWidth?: string;
}) {
  return (
    <div
      className={["help-map__list", className ?? ""].filter(Boolean).join(" ")}
      style={keyWidth ? ({ ["--help-map-key-width" as string]: keyWidth } as CSSProperties) : undefined}
    >
      {rows.map((row) => (
        <div className="help-map__row" key={row.keys}>
          <Kbd>{row.keys}</Kbd>
          <span>{row.action}</span>
        </div>
      ))}
    </div>
  );
}
