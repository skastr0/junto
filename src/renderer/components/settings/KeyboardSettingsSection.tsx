/**
 * Settings -> Keyboard shortcuts: every key in the key table, listed by
 * where it works. A shortcut can be changed; a key a screen handles itself
 * is shown as it is. Only what the operator changed
 * is stored; the table holds the defaults and is the one source the
 * dispatcher, the menu bar and this page all read.
 */
import { use$ } from "@legendapp/state/react";
import { RotateCcw } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { clearChords, isRebound, proposeRebind, resetChords, type RebindVerdict } from "@shared/key-rebind";
import {
  KEY_TABLE,
  SHORTCUT_AREAS,
  chordKeyCaps,
  chordOfKey,
  chordSpoken,
  chordsFor,
  type KeyOverrides,
  type ShortcutDef,
  type ShortcutId,
} from "@shared/key-table";
import { holdKeyDispatch } from "../../lib/key-dispatcher";
import { isMac } from "../../lib/platform";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Button, Eyebrow, IconButton, Input, KeyChord } from "../ui";
import { FieldRow } from "./FieldRow";

type Problem = {
  readonly id: ShortcutId;
  readonly verdict: Exclude<RebindVerdict, { readonly kind: "ok" }>;
};

const NO_OVERRIDES: KeyOverrides = {};

const save = (overrides: KeyOverrides): Promise<boolean> => patchSettings({ keyboard: { overrides } });

const nameOf = (id: ShortcutId): string => KEY_TABLE.find((def) => def.id === id)?.name ?? id;

/** True when the filter text names this shortcut or one of its keys. */
export const shortcutMatches = (
  def: ShortcutDef,
  chords: ReadonlyArray<string>,
  mac: boolean,
  filter: string,
): boolean => {
  const wanted = filter.trim().toLowerCase();
  if (wanted.length === 0) return true;
  const keys = chords.flatMap((chord) => [chordKeyCaps(chord, mac).join(" "), chordSpoken(chord), chord]);
  return [def.name, def.does, ...keys].some((text) => text.toLowerCase().includes(wanted));
};

function Chords({
  chords,
  mac,
  shown,
}: {
  readonly chords: ReadonlyArray<string>;
  readonly mac: boolean;
  /** Key caps a row asks to show in place of its chords. */
  readonly shown?: ReadonlyArray<ReadonlyArray<string>>;
}) {
  const steps = shown
    ? shown.map((caps) => ({ id: caps.join(" "), caps, label: caps.join(" ") }))
    : chords.map((chord) => ({ id: chord, caps: chordKeyCaps(chord, mac), label: chordSpoken(chord) }));
  if (steps.length === 0) return <span className="text-body text-faint">none</span>;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5 normal-case tracking-normal">
      {steps.map((step, index) => (
        <span key={step.id} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span className="text-label text-faint">or</span> : null}
          <KeyChord size="md" steps={[step.caps]} label={step.label} />
        </span>
      ))}
    </span>
  );
}

function ShortcutRow({
  def,
  mac,
  overrides,
  recording,
  problem,
  onRecord,
  onProblem,
}: {
  readonly def: ShortcutDef;
  readonly mac: boolean;
  readonly overrides: KeyOverrides;
  readonly recording: boolean;
  readonly problem: Problem["verdict"] | undefined;
  readonly onRecord: (id: ShortcutId | undefined) => void;
  readonly onProblem: (problem: Problem | undefined) => void;
}) {
  const chords = chordsFor(def, mac, overrides);
  const problemId = useId();

  // Every key pressed while recording belongs to this button: none reaches
  // the Settings shell, the canvas, a terminal or another shortcut.
  const onRecordKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return;
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
    // Tab still leaves the button, so the keyboard is never trapped here.
    if (bare && event.key === "Tab") {
      onRecord(undefined);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || event.nativeEvent.isComposing) return;
    if (bare && !event.shiftKey && event.key === "Escape") {
      onRecord(undefined);
      return;
    }
    if (bare && !event.shiftKey && event.key === "Backspace") {
      onRecord(undefined);
      onProblem(undefined);
      void save(clearChords(def.id, mac, overrides));
      return;
    }
    const chord = chordOfKey(event);
    if (chord === null) return;
    const verdict = proposeRebind(def.id, chord, mac, overrides);
    onRecord(undefined);
    if (verdict.kind === "ok") {
      onProblem(undefined);
      void save(verdict.overrides);
    } else {
      onProblem({ id: def.id, verdict });
    }
  };

  return (
    <>
      <FieldRow
        group
        label={def.name}
        hint={recording ? "Press the new keys. Backspace for none, Escape to cancel." : def.fixed}
      >
        <span className="flex items-center justify-end gap-1.5">
          {def.fixed !== undefined ? (
            <Chords chords={chords} mac={mac} shown={def.shown} />
          ) : (
            <Button
              size="sm"
              variant={recording ? "armed" : "chrome"}
              aria-describedby={problem ? problemId : undefined}
              aria-label={recording ? `Press keys for ${def.name}` : `Change the keys for ${def.name}`}
              aria-pressed={recording}
              onClick={() => {
                onProblem(undefined);
                onRecord(recording ? undefined : def.id);
              }}
              onKeyDown={onRecordKey}
              onBlur={() => {
                if (recording) onRecord(undefined);
              }}
            >
              {recording ? (
                <span className="text-body normal-case tracking-normal text-dim">Press keys</span>
              ) : (
                <Chords chords={chords} mac={mac} />
              )}
            </Button>
          )}
          {isRebound(def.id, overrides) ? (
            <IconButton
              size="sm"
              title="Reset to default"
              aria-label={`Reset ${def.name} to its default keys`}
              onClick={() => {
                onProblem(undefined);
                void save(resetChords(def.id, overrides));
              }}
            >
              <RotateCcw size={13} aria-hidden />
            </IconButton>
          ) : null}
        </span>
      </FieldRow>
      {problem ? (
        <div
          id={problemId}
          className="flex flex-wrap items-center justify-end gap-2 text-label text-amber-fg"
          role="status"
        >
          {problem.kind === "taken" ? (
            <>
              <span>Already used by {nameOf(problem.by)}</span>
              <Button
                size="xs"
                onClick={() => {
                  onProblem(undefined);
                  void save(problem.overrides);
                }}
              >
                Replace
              </Button>
              <Button size="xs" variant="subtle" onClick={() => onProblem(undefined)}>
                Cancel
              </Button>
            </>
          ) : (
            <span>{problem.why}</span>
          )}
        </div>
      ) : null}
    </>
  );
}

export function KeyboardSettingsSection() {
  // Only the keyboard section: another setting changing does not redraw the list.
  const overrides = use$(state$.settings.keyboard)?.overrides ?? NO_OVERRIDES;
  const mac = isMac();
  const [filter, setFilter] = useState("");
  const [recording, setRecording] = useState<ShortcutId>();
  const [problem, setProblem] = useState<Problem>();

  // While a chord is being recorded the dispatcher stands down, so the keys
  // pressed reach the recorder and nothing else.
  useEffect(() => (recording === undefined ? undefined : holdKeyDispatch()), [recording]);

  const groups = SHORTCUT_AREAS.map((area) => ({
    area,
    rows: KEY_TABLE.filter(
      (def) => def.area === area && shortcutMatches(def, chordsFor(def, mac, overrides), mac, filter),
    ),
  })).filter((group) => group.rows.length > 0);

  return (
    <div className="settings-section" data-testid="settings-keyboard-section">
      <Input
        type="search"
        value={filter}
        placeholder="Filter shortcuts"
        aria-label="Filter shortcuts"
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          // Escape empties the filter first; only an empty one lets it close Settings.
          if (event.key !== "Escape" || filter.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          setFilter("");
        }}
      />
      {groups.length === 0 ? <p className="m-0 text-body text-faint">No shortcut matches.</p> : null}
      {groups.map((group, index) => (
        <section
          key={group.area}
          aria-label={group.area}
          className={`flex flex-col gap-3 ${index > 0 ? "border-t border-stroke pt-3" : ""}`}
        >
          <Eyebrow>{group.area}</Eyebrow>
          {group.rows.map((def) => (
            <ShortcutRow
              key={def.id}
              def={def}
              mac={mac}
              overrides={overrides}
              recording={recording === def.id}
              problem={problem?.id === def.id ? problem.verdict : undefined}
              onRecord={setRecording}
              onProblem={setProblem}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
