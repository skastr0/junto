import { useId, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";

/** The one row in Settings: a label and hint on the left, its control on the right. */
export function FieldRow({
  label,
  hint,
  help,
  group = false,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  /** Longer explanation shown on the ? control (native title tooltip). */
  readonly help?: string;
  /**
   * The row holds a button, a menu or a plain value, not a form field. A
   * label would rename a button after the row and pass it the row's clicks,
   * so the row is a named group instead.
   */
  readonly group?: boolean;
  readonly children: ReactNode;
}) {
  const labelId = useId();
  const Row = group ? "div" : "label";
  return (
    <Row className="settings-field" data-setting={label} {...(group ? { role: "group", "aria-labelledby": labelId } : {})}>
      <span className="settings-field__label">
        <span className="settings-field__label-row">
          <span id={labelId}>{label}</span>
          {help ? (
            <span
              className="settings-field__help"
              title={help}
              role="img"
              aria-label={help}
            >
              <CircleHelp size={12} aria-hidden />
            </span>
          ) : null}
        </span>
        {hint ? <span className="settings-field__hint">{hint}</span> : null}
      </span>
      <span className="settings-field__control">{children}</span>
    </Row>
  );
}

/**
 * A setting whose control needs the full width (a row of choices, a list):
 * its name and what it does on top, the control underneath.
 */
export function SettingBlock({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  /** Receives the ids of the name and the hint, to name and describe the control. */
  readonly children: (ids: { readonly labelId: string; readonly hintId: string | undefined }) => ReactNode;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="settings-block" data-setting={label}>
      <div className="settings-block__head">
        <span id={labelId} className="settings-block__label">
          {label}
        </span>
        {hint ? (
          <span id={hintId} className="settings-block__hint">
            {hint}
          </span>
        ) : null}
      </div>
      {children({ labelId, hintId: hint ? hintId : undefined })}
    </div>
  );
}

/** Related rows under one plain title, a rule between each. */
export function SettingGroup({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const titleId = useId();
  return (
    <section className="settings-group" aria-labelledby={titleId}>
      <h3 id={titleId} className="settings-group__title">
        {title}
      </h3>
      <div className="settings-group__rows">{children}</div>
    </section>
  );
}
