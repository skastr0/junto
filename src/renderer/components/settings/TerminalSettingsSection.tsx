/**
 * Settings → Terminal: durable terminal preferences.
 *
 * Every row writes through settingsPatch, so the StateEngine row stays the only
 * copy of these values — nothing here is renderer-local and nothing is read
 * back from storage. Values are read through terminalSettings(), which resolves
 * an installation that predates the fragment to today's terminal.
 *
 * Typing is the one place a control holds text of its own: a half-typed "1." or
 * an emptied field is not a value, so it stays in the row until the edit ends
 * and is then either clamped into the schema bounds or dropped for the durable
 * value. Nothing partial is ever sent.
 */
import { use$ } from "@legendapp/state/react";
import { useEffect, useState, type ReactNode } from "react";
import {
  TERMINAL_BOUNDS,
  terminalSettings,
  type TerminalBell,
  type TerminalCursorStyle,
  type TerminalPatch,
} from "@shared/settings";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Select } from "../ui";

/** Row chrome — the panel's FieldRow shape (label, hint, control). */
function Row({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">
        <span>{label}</span>
        <span className="settings-field__hint">{hint}</span>
      </span>
      <span className="settings-field__control">{children}</span>
    </label>
  );
}

/**
 * Typed text → the number to persist, or undefined when the text is not yet a
 * number the operator could have meant ("", "-", "1.e", "abc"). Clamps to the
 * schema bounds rather than letting the write fail, and rounds: whole lines or
 * px for integer rows, 2dp for fractional ones so no float artefact lands in a
 * durable row.
 */
export const nextNumericValue = (
  raw: string,
  bounds: { readonly min: number; readonly max: number },
  kind: "integer" | "fractional",
): number | undefined => {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const bounded = Math.min(bounds.max, Math.max(bounds.min, parsed));
  return kind === "integer"
    ? Math.round(bounded)
    : Math.round(bounded * 100) / 100;
};

/**
 * Numeric row. Change only tracks what is typed; the write happens on blur or
 * Enter, Escape abandons the edit, and a rejected write drops back to the
 * durable value so the row can never show something that was not stored.
 */
function NumberRow({
  label,
  hint,
  value,
  bounds,
  kind,
  step,
  onCommit,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: number;
  readonly bounds: { readonly min: number; readonly max: number };
  readonly kind: "integer" | "fractional";
  readonly step: number;
  readonly onCommit: (next: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string>();
  // A landed patch ends the edit: the durable value is what the row shows.
  useEffect(() => setDraft(undefined), [value]);

  const commit = async (): Promise<void> => {
    if (draft === undefined) return;
    const next = nextNumericValue(draft, bounds, kind);
    if (next === undefined) {
      setDraft(undefined);
      return;
    }
    // Show the clamped value at once; drop it if the write does not land.
    setDraft(String(next));
    if (next !== value && !(await onCommit(next))) setDraft(undefined);
  };

  return (
    <Row label={label} hint={hint}>
      <input
        type="number"
        inputMode="decimal"
        min={bounds.min}
        max={bounds.max}
        step={step}
        value={draft ?? String(value)}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            setDraft(undefined);
          }
        }}
      />
    </Row>
  );
}

/** Font stack row. Same commit rule; an emptied field keeps the stored stack. */
function FontFamilyRow({
  value,
  onCommit,
}: {
  readonly value: string;
  readonly onCommit: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string>();
  useEffect(() => setDraft(undefined), [value]);

  const commit = async (): Promise<void> => {
    if (draft === undefined) return;
    const next = draft.trim();
    if (next.length < TERMINAL_BOUNDS.fontFamily.minLength) {
      setDraft(undefined);
      return;
    }
    setDraft(next);
    if (next !== value && !(await onCommit(next))) setDraft(undefined);
  };

  return (
    <Row label="Font family" hint="font stack for terminal cells, monospace first">
      <input
        type="text"
        value={draft ?? value}
        maxLength={TERMINAL_BOUNDS.fontFamily.maxLength}
        spellCheck={false}
        autoComplete="off"
        aria-label="Font family"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            setDraft(undefined);
          }
        }}
      />
    </Row>
  );
}

const CURSOR_STYLES: ReadonlyArray<{
  readonly value: TerminalCursorStyle;
  readonly label: string;
}> = [
  { value: "block", label: "block" },
  { value: "bar", label: "bar" },
  { value: "underline", label: "underline" },
];

const BELLS: ReadonlyArray<{
  readonly value: TerminalBell;
  readonly label: string;
}> = [
  { value: "off", label: "ignore" },
  { value: "visual", label: "flash the surface" },
  { value: "sound", label: "play a sound" },
];

export function TerminalSettingsSection() {
  const settings = use$(state$.settings);
  const terminal = terminalSettings(settings);
  const patch = (next: TerminalPatch): Promise<boolean> =>
    patchSettings({ terminal: next });

  return (
    <div className="settings-section">
      <Row
        label="Scroll sensitivity"
        hint={`lines per wheel notch (${TERMINAL_BOUNDS.scrollSensitivity.min}–${TERMINAL_BOUNDS.scrollSensitivity.max})`}
      >
        <input
          type="range"
          min={TERMINAL_BOUNDS.scrollSensitivity.min}
          max={TERMINAL_BOUNDS.scrollSensitivity.max}
          step={1}
          value={terminal.scrollSensitivity}
          aria-label="Scroll sensitivity"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            void patch({ scrollSensitivity: Math.round(next) });
          }}
        />
        <span className="settings-field__hint" style={{ marginLeft: 8 }}>
          {terminal.scrollSensitivity}
        </span>
      </Row>

      <NumberRow
        label="Font size"
        hint={`cell size in px (${TERMINAL_BOUNDS.fontSize.min}–${TERMINAL_BOUNDS.fontSize.max})`}
        value={terminal.fontSize}
        bounds={TERMINAL_BOUNDS.fontSize}
        kind="integer"
        step={1}
        onCommit={(next) => patch({ fontSize: next })}
      />

      <FontFamilyRow
        value={terminal.fontFamily}
        onCommit={(next) => patch({ fontFamily: next })}
      />

      <Row label="Cursor style" hint="how the cursor is drawn">
        <Select
          dense
          value={terminal.cursorStyle}
          aria-label="Cursor style"
          options={CURSOR_STYLES.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          onChange={(value) => {
            const choice = CURSOR_STYLES.find((option) => option.value === value);
            if (choice) void patch({ cursorStyle: choice.value });
          }}
        />
      </Row>

      <NumberRow
        label="Scrollback"
        hint={`lines kept above the viewport (${TERMINAL_BOUNDS.scrollback.min.toLocaleString("en-US")}–${TERMINAL_BOUNDS.scrollback.max.toLocaleString("en-US")})`}
        value={terminal.scrollback}
        bounds={TERMINAL_BOUNDS.scrollback}
        kind="integer"
        step={100}
        onCommit={(next) => patch({ scrollback: next })}
      />

      <div
        className="settings-profile-list"
        role="group"
        aria-label="Terminal accessibility"
      >
        <div className="settings-profile-list__head">
          <span>Accessibility</span>
          <span>contrast, spacing, and how output is announced</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Row label="Cursor blink" hint="blink while the terminal is visible">
            <input
              type="checkbox"
              checked={terminal.cursorBlink}
              aria-label="Cursor blink"
              onChange={(event) =>
                void patch({ cursorBlink: event.target.checked })
              }
            />
          </Row>

          <NumberRow
            label="Minimum contrast"
            hint={`ratio enforced per cell (${TERMINAL_BOUNDS.minimumContrastRatio.min} keeps agent colours)`}
            value={terminal.minimumContrastRatio}
            bounds={TERMINAL_BOUNDS.minimumContrastRatio}
            kind="fractional"
            step={0.5}
            onCommit={(next) => patch({ minimumContrastRatio: next })}
          />

          <NumberRow
            label="Line height"
            hint={`multiple of font size (${TERMINAL_BOUNDS.lineHeight.min}–${TERMINAL_BOUNDS.lineHeight.max})`}
            value={terminal.lineHeight}
            bounds={TERMINAL_BOUNDS.lineHeight}
            kind="fractional"
            step={0.05}
            onCommit={(next) => patch({ lineHeight: next })}
          />

          <NumberRow
            label="Letter spacing"
            hint={`extra px per cell (${TERMINAL_BOUNDS.letterSpacing.min}–${TERMINAL_BOUNDS.letterSpacing.max})`}
            value={terminal.letterSpacing}
            bounds={TERMINAL_BOUNDS.letterSpacing}
            kind="fractional"
            step={0.1}
            onCommit={(next) => patch({ letterSpacing: next })}
          />

          <Row
            label="Screen reader mode"
            hint="expose terminal output to the screen reader"
          >
            <input
              type="checkbox"
              checked={terminal.screenReaderMode}
              aria-label="Screen reader mode"
              onChange={(event) =>
                void patch({ screenReaderMode: event.target.checked })
              }
            />
          </Row>

          <Row label="Bell" hint="what happens when a program rings the bell">
            <Select
              dense
              value={terminal.bell}
              aria-label="Bell"
              options={BELLS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(value) => {
                const choice = BELLS.find((option) => option.value === value);
                if (choice) void patch({ bell: choice.value });
              }}
            />
          </Row>
        </div>
      </div>
    </div>
  );
}
