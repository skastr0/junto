/**
 * Settings -> Offboard: the cache window, the one offboard setting.
 *
 * A harness's provider keeps a conversation cached for a while; once an agent
 * has been still that long, Junto ends its session by itself and the next
 * message starts a fresh one. One window for the installation, and one per
 * harness the operator gives its own (each provider keeps its cache for a
 * different time). A change is saved the moment it is entered.
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
import { Button, Dropdown } from "../ui";
import { FieldRow } from "./FieldRow";
import "./offboard-settings.css";

const harnessName = (harness: string): string => (isHarnessId(harness) ? templateFor(harness).displayName : harness);

/** A whole number of minutes: commits on blur or Enter, Escape drops the edit. */
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
  readonly onCommit: (next: number) => Promise<boolean>;
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

  const overrides = Object.entries(rules.harness ?? {}).filter(
    ([harness, over]) => isHarnessId(harness) && over.cacheWindowMinutes !== undefined,
  );
  const free = HARNESS_IDS.filter((harness) => rules.harness?.[harness]?.cacheWindowMinutes === undefined);

  return (
    <div className="offboard-settings" data-testid="offboard-settings">
      <FieldRow
        label="Cache window"
        hint="How long a still agent's conversation stays cached. After that, its next message starts fresh."
        group
      >
        <MinutesInput
          label="Cache window, minutes"
          value={rules.cacheWindowMinutes}
          testId="offboard-cache-window"
          onCommit={(minutes) => change({ cacheWindowMinutes: minutes })}
        />
      </FieldRow>

      {problem ? (
        <p className="settings-error" role="alert" data-testid="offboard-settings-problem">
          Not saved. {problem}
        </p>
      ) : null}

      <div className="offboard-settings__harnesses" role="group" aria-label="Per harness">
        <p className="settings-note">Per harness: its own window. A harness not listed follows the one above.</p>
        {overrides.map(([harness, over]) => {
          const name = harnessName(harness);
          return (
            <div key={harness} className="offboard-settings__harness" data-testid={`offboard-harness-${harness}`}>
              <span className="offboard-settings__harness-name">{name}</span>
              <label>
                <span>window</span>
                <MinutesInput
                  label={`${name} cache window, minutes`}
                  value={over.cacheWindowMinutes ?? rules.cacheWindowMinutes}
                  onCommit={(minutes) => change({ harness: { [harness]: { cacheWindowMinutes: minutes } } })}
                />
              </label>
              <Button
                size="xs"
                variant="subtle"
                aria-label={`Remove the ${name} window`}
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
            aria-label="Add a window for a harness"
            placeholder="Add a harness…"
          />
        ) : null}
      </div>
    </div>
  );
}
