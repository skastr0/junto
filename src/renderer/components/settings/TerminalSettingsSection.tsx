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
import { useEffect, useState } from "react";
import {
  TERMINAL_BOUNDS,
  terminalSettings,
  type TerminalBell,
  type TerminalCursorStyle,
  type TerminalPatch,
} from "@shared/settings";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Select, Switch } from "../ui";
import { FieldRow, SettingGroup } from "./FieldRow";

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
    <FieldRow label={label} hint={hint}>
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
    </FieldRow>
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
    <FieldRow label="Font family" hint="First installed font wins.">
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
    </FieldRow>
  );
}

const CURSOR_STYLES: ReadonlyArray<{
  readonly value: TerminalCursorStyle;
  readonly label: string;
}> = [
  { value: "block", label: "Block" },
  { value: "bar", label: "Bar" },
  { value: "underline", label: "Underline" },
];

const BELLS: ReadonlyArray<{
  readonly value: TerminalBell;
  readonly label: string;
}> = [
  { value: "off", label: "Nothing" },
  { value: "visual", label: "Flash the terminal" },
  { value: "sound", label: "Play a sound" },
];

export function TerminalSettingsSection() {
  const settings = use$(state$.settings);
  const terminal = terminalSettings(settings);
  const patch = (next: TerminalPatch): Promise<boolean> =>
    patchSettings({ terminal: next });

  const range = (bounds: { readonly min: number; readonly max: number }): string =>
    `${bounds.min.toLocaleString("en-US")} to ${bounds.max.toLocaleString("en-US")}`;

  return (
    <div className="settings-section settings-groups">
      <SettingGroup title="Text">
        <FontFamilyRow
          value={terminal.fontFamily}
          onCommit={(next) => patch({ fontFamily: next })}
        />
        <NumberRow
          label="Font size"
          hint={`${range(TERMINAL_BOUNDS.fontSize)} px`}
          value={terminal.fontSize}
          bounds={TERMINAL_BOUNDS.fontSize}
          kind="integer"
          step={1}
          onCommit={(next) => patch({ fontSize: next })}
        />
        <NumberRow
          label="Line height"
          hint={`${range(TERMINAL_BOUNDS.lineHeight)} times the font size`}
          value={terminal.lineHeight}
          bounds={TERMINAL_BOUNDS.lineHeight}
          kind="fractional"
          step={0.05}
          onCommit={(next) => patch({ lineHeight: next })}
        />
        <NumberRow
          label="Letter spacing"
          hint={`${range(TERMINAL_BOUNDS.letterSpacing)} px`}
          value={terminal.letterSpacing}
          bounds={TERMINAL_BOUNDS.letterSpacing}
          kind="fractional"
          step={0.1}
          onCommit={(next) => patch({ letterSpacing: next })}
        />
        <NumberRow
          label="Minimum contrast"
          hint={`Faint text is lifted to this ratio. ${TERMINAL_BOUNDS.minimumContrastRatio.min} leaves colours alone.`}
          value={terminal.minimumContrastRatio}
          bounds={TERMINAL_BOUNDS.minimumContrastRatio}
          kind="fractional"
          step={0.5}
          onCommit={(next) => patch({ minimumContrastRatio: next })}
        />
      </SettingGroup>

      <SettingGroup title="Cursor">
        <FieldRow group label="Cursor style">
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
        </FieldRow>
        <FieldRow label="Cursor blink">
          <Switch
            checked={terminal.cursorBlink}
            aria-label="Cursor blink"
            onCheckedChange={(cursorBlink) => void patch({ cursorBlink })}
          />
        </FieldRow>
      </SettingGroup>

      <SettingGroup title="Scrolling and copying">
        <FieldRow
          label="Scroll sensitivity"
          hint="Lines per wheel notch"
        >
          <span className="settings-field__range">
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
            <span className="settings-field__range-value">{terminal.scrollSensitivity}</span>
          </span>
        </FieldRow>
        <NumberRow
          label="Scrollback"
          hint={`${range(TERMINAL_BOUNDS.scrollback)} lines`}
          value={terminal.scrollback}
          bounds={TERMINAL_BOUNDS.scrollback}
          kind="integer"
          step={100}
          onCommit={(next) => patch({ scrollback: next })}
        />
        <FieldRow
          label="Copy selection automatically"
          hint="Replaces your clipboard."
        >
          <Switch
            checked={terminal.copyOnSelect === true}
            aria-label="Copy selection automatically"
            onCheckedChange={(copyOnSelect) => void patch({ copyOnSelect })}
          />
        </FieldRow>
      </SettingGroup>

      <SettingGroup title="Bell and screen reader">
        <FieldRow group label="Bell">
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
        </FieldRow>
        <FieldRow label="Screen reader mode">
          <Switch
            checked={terminal.screenReaderMode}
            aria-label="Screen reader mode"
            onCheckedChange={(screenReaderMode) => void patch({ screenReaderMode })}
          />
        </FieldRow>
      </SettingGroup>
    </div>
  );
}
