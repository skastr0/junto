/**
 * Settings -> Offboard: when Junto ends an idle agent's session by itself.
 *
 * Three settings for the installation, and the same three for any harness
 * the operator gives its own (each harness keeps its cache for a different
 * time, and a rule can be on for one harness and off for another):
 *
 *   cache window   how long a still seat stays cheap to give a turn
 *   idle nudge     ask a still seat to offboard and continue (inside the window)
 *   auto offboard  end a still seat's session with no notes (at or past it)
 *
 * A change is saved the moment it is entered, unless it would break that
 * order: then nothing is saved and the line under the section says why.
 */
import { use$ } from "@legendapp/state/react";
import { useEffect, useState } from "react";
import { HARNESS_IDS, isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  OFFBOARD_MINUTES_MAX,
  OFFBOARD_MINUTES_MIN,
  type OffboardRulesPatch,
} from "@shared/seat-offboard";
import { offboardRules } from "@shared/settings";
import { parseOffboardMinutes, planOffboardRulesChange, seedHarnessOverride } from "../../lib/seat-offboard";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Button, Dropdown, Switch } from "../ui";
import { FieldRow } from "./FieldRow";
import "./offboard-settings.css";

const harnessName = (harness: string): string => (isHarnessId(harness) ? templateFor(harness).displayName : harness);

/** A minutes field: commits on blur or Enter, Escape drops the edit. */
function MinutesInput({
  label,
  value,
  disabled,
  testId,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly onCommit: (minutes: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string>();
  // A landed change ends the edit: the stored value is what the field shows.
  useEffect(() => setDraft(undefined), [value]);

  const commit = async (): Promise<void> => {
    if (draft === undefined) return;
    const next = parseOffboardMinutes(draft);
    if (next === undefined || next === value) {
      setDraft(undefined);
      return;
    }
    // Not saved (refused, or the write failed): show the stored value again.
    if (!(await onCommit(next))) setDraft(undefined);
  };

  return (
    <span className="offboard-settings__minutes">
      <input
        type="number"
        inputMode="numeric"
        min={OFFBOARD_MINUTES_MIN}
        max={OFFBOARD_MINUTES_MAX}
        step={1}
        value={draft ?? String(value)}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
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
      <span aria-hidden>min</span>
    </span>
  );
}

export function OffboardSettingsSection() {
  const rules = use$(() => offboardRules(state$.settings.get()));
  const [problem, setProblem] = useState<string>();

  /** Save a change, or say why it cannot be saved. True when it landed. */
  const change = async (patch: OffboardRulesPatch): Promise<boolean> => {
    const plan = planOffboardRulesChange(rules, patch);
    if (!plan.ok) {
      setProblem(plan.problem);
      return false;
    }
    setProblem(undefined);
    return patchSettings({ offboard: plan.patch });
  };

  const overrides = Object.entries(rules.harness ?? {}).filter(([harness]) => isHarnessId(harness));
  const free = HARNESS_IDS.filter((harness) => rules.harness?.[harness] === undefined);

  return (
    <div className="offboard-settings" data-testid="offboard-settings">
      <p className="settings-note">
        A seat counts as idle only while it is completely still: no output, no typing, no mail in or out. These rules
        apply to every agent on this installation.
      </p>

      <FieldRow
        label="Cache window"
        hint="how long a still agent stays cheap to give a turn. Before it ends, asking the agent to offboard is the better call; after it, closing without notes is."
        group
      >
        <MinutesInput
          label="Cache window, minutes"
          value={rules.cacheWindowMinutes}
          testId="offboard-cache-window"
          onCommit={(minutes) => change({ cacheWindowMinutes: minutes })}
        />
      </FieldRow>

      <FieldRow
        label="Idle nudge"
        hint="asks a still agent to offboard and continue, once per idle stretch. The agent writes its notes. Must come before the cache window ends."
        group
      >
        <Switch
          checked={rules.nudge.enabled}
          aria-label="Idle nudge"
          data-testid="offboard-nudge-on"
          onCheckedChange={(on) => void change({ nudge: { enabled: on } })}
        />
        <MinutesInput
          label="Idle nudge after, minutes"
          value={rules.nudge.minutes}
          testId="offboard-nudge-minutes"
          onCommit={(minutes) => change({ nudge: { minutes } })}
        />
      </FieldRow>

      <FieldRow
        label="Auto offboard"
        hint="ends a still agent's session by itself: no agent turn, no notes. The seat rests on a fresh session. Must come at or after the cache window."
        group
      >
        <Switch
          checked={rules.auto.enabled}
          aria-label="Auto offboard"
          data-testid="offboard-auto-on"
          onCheckedChange={(on) => void change({ auto: { enabled: on } })}
        />
        <MinutesInput
          label="Auto offboard after, minutes"
          value={rules.auto.minutes}
          testId="offboard-auto-minutes"
          onCommit={(minutes) => change({ auto: { minutes } })}
        />
      </FieldRow>

      {problem ? (
        <p className="settings-error" role="alert" data-testid="offboard-settings-problem">
          Not saved. {problem}
        </p>
      ) : null}

      <div className="offboard-settings__harnesses" role="group" aria-label="Per harness">
        <p className="settings-note">
          Per harness: a harness can run on its own window, and have each rule on or off and timed by itself. A
          harness with no row here follows the installation.
        </p>
        {overrides.map(([harness, over]) => {
          const name = harnessName(harness);
          const set = {
            window: over.cacheWindowMinutes ?? rules.cacheWindowMinutes,
            nudge: over.nudge?.minutes ?? rules.nudge.minutes,
            nudgeOn: over.nudge?.enabled ?? rules.nudge.enabled,
            auto: over.auto?.minutes ?? rules.auto.minutes,
            autoOn: over.auto?.enabled ?? rules.auto.enabled,
          };
          return (
            <div key={harness} className="offboard-settings__harness" data-testid={`offboard-harness-${harness}`}>
              <span className="offboard-settings__harness-name">{name}</span>
              <label>
                <span>window</span>
                <MinutesInput
                  label={`${name} cache window, minutes`}
                  value={set.window}
                  onCommit={(minutes) => change({ harness: { [harness]: { cacheWindowMinutes: minutes } } })}
                />
              </label>
              <label>
                <span>nudge</span>
                <Switch
                  checked={set.nudgeOn}
                  aria-label={`${name} idle nudge`}
                  data-testid={`offboard-harness-${harness}-nudge-on`}
                  onCheckedChange={(on) => void change({ harness: { [harness]: { nudge: { enabled: on } } } })}
                />
                <MinutesInput
                  label={`${name} idle nudge after, minutes`}
                  value={set.nudge}
                  onCommit={(minutes) => change({ harness: { [harness]: { nudge: { minutes } } } })}
                />
              </label>
              <label>
                <span>auto</span>
                <Switch
                  checked={set.autoOn}
                  aria-label={`${name} auto offboard`}
                  data-testid={`offboard-harness-${harness}-auto-on`}
                  onCheckedChange={(on) => void change({ harness: { [harness]: { auto: { enabled: on } } } })}
                />
                <MinutesInput
                  label={`${name} auto offboard after, minutes`}
                  value={set.auto}
                  onCommit={(minutes) => change({ harness: { [harness]: { auto: { minutes } } } })}
                />
              </label>
              <Button
                size="xs"
                variant="subtle"
                aria-label={`Remove the ${name} override`}
                onClick={() => void change({ harness: { [harness]: null } })}
              >
                Remove
              </Button>
            </div>
          );
        })}
        {free.length > 0 ? (
          <Dropdown
            value=""
            options={free.map((harness) => ({ value: harness, label: harnessName(harness) }))}
            onChange={(harness) => void change(seedHarnessOverride(rules, harness))}
            aria-label="Add an override for a harness"
            placeholder="Add a harness…"
          />
        ) : null}
      </div>
    </div>
  );
}
