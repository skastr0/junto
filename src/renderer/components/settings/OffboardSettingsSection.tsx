/**
 * Settings -> Cache window, for the machine chosen in the sidebar. Once an
 * agent has been still this long, Junto ends its session by itself and the
 * next message starts a fresh one. The cut happens on the machine the seat
 * runs on, so each machine keeps its own windows: a default, and one per
 * harness that machine has, each following the default or set on its own.
 * Above them, the machine's cache mode: what Junto does once a seat is past
 * its window. A linked machine on a build from before the mode answers
 * without one, and the page offers no choice for it.
 *
 * The page reads and writes through that machine's core
 * (lib/machine-settings-source.ts), and its harnesses come from its
 * inventory (lib/harness-machine-source.ts). A machine that does not answer
 * shows what it last sent, read only. A write the link lost before it
 * answered may have landed: the page says so and reads again.
 */
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import { useEffect, useState } from "react";
import type { MachineInventory } from "@shared/harness-domain";
import {
  machineSettingsRefusal,
  type MachineCacheWindows,
  type MachineSettingsUnavailableError,
} from "@shared/machine-settings";
import { HARNESS_IDS, isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  CACHE_MODES,
  OFFBOARD_MINUTES_MAX,
  OFFBOARD_MINUTES_MIN,
  type CacheMode,
  type OffboardRules,
  type OffboardRulesPatch,
} from "@shared/seat-offboard";
import { formatSeatAwarenessAge } from "../../lib/seat-awareness";
import { harnessMachineSource } from "../../lib/harness-machine-source";
import { machineSettingsSource } from "../../lib/machine-settings-source";
import { parseOffboardMinutes, planOffboardRulesChange, seedHarnessOverride } from "../../lib/seat-offboard";
import { useSettingsMachine } from "../../lib/settings-machine";
import { state$ } from "../../lib/state";
import { Switch } from "../ui";
import { FieldRow } from "./FieldRow";
import { radioGroupKeys, radioTabIndex } from "./radio-keys";
import "./offboard-settings.css";

/** Each cache mode in a word and a line. The names are also the search index's. */
export const CACHE_MODE_COPY: Readonly<Record<CacheMode, { readonly label: string; readonly line: string }>> = {
  off: { label: "Off", line: "Junto never acts on the cache window. Seats always continue." },
  manual: { label: "Manual", line: "A seat past its window shows it, and you start it fresh yourself." },
  auto: { label: "Auto", line: "A seat off screen past its window starts fresh. A seat open in front of you asks first." },
  hybrid: {
    label: "Hybrid",
    line: "Like auto, but a seat open in front of you is never started fresh or asked; it shows the warning.",
  },
};

const harnessName = (harness: string): string => (isHarnessId(harness) ? templateFor(harness).displayName : harness);

/** What each machine last answered, and when: shown read only while it does not answer. */
const lastAnswers = new Map<string, { readonly windows: MachineCacheWindows; readonly receivedAt: number }>();

type WindowsRead =
  | { readonly state: "unread" }
  | { readonly state: "answered"; readonly windows: MachineCacheWindows }
  | { readonly state: "refused"; readonly error: MachineSettingsUnavailableError };

const rulesOf = (windows: MachineCacheWindows): OffboardRules => ({
  cacheWindowMinutes: windows.cacheWindowMinutes,
  ...(windows.cacheMode === undefined ? {} : { cacheMode: windows.cacheMode }),
  harness: Object.fromEntries(Object.entries(windows.harness).map(([id, minutes]) => [id, { cacheWindowMinutes: minutes }])),
});

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
  readonly onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string>();
  // A landed change ends the edit: the stored value is what the field shows.
  useEffect(() => setDraft(undefined), [value]);

  const commit = (): void => {
    if (draft === undefined) return;
    const next = parseOffboardMinutes(draft);
    setDraft(undefined);
    if (next === undefined || next === value) return;
    onCommit(next);
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
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
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
  const machine = useSettingsMachine();
  // The window's own core answers this machine; a change it saved is a reason to read again.
  const own = use$(state$.settings.offboard);
  const [read, setRead] = useState<WindowsRead>({ state: "unread" });
  const [inventory, setInventory] = useState<MachineInventory>();
  const [readCount, setReadCount] = useState(0);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let current = true;
    void machineSettingsSource()
      .cacheWindows(machine.name)
      .then((answer) => {
        if (!current) return;
        if (Result.isSuccess(answer)) {
          lastAnswers.set(machine.name, { windows: answer.success, receivedAt: Date.now() });
          setRead({ state: "answered", windows: answer.success });
        } else {
          setRead({ state: "refused", error: answer.failure });
        }
      });
    return () => {
      current = false;
    };
  }, [machine.name, own, readCount]);

  useEffect(() => {
    let current = true;
    setInventory(undefined);
    void harnessMachineSource()
      .inventory(machine.name)
      .then((answer) => {
        if (!current) return;
        setInventory(Result.isSuccess(answer) ? answer.success : answer.failure.last?.inventory);
      });
    return () => {
      current = false;
    };
  }, [machine.name]);

  const last = read.state === "refused" ? lastAnswers.get(machine.name) : undefined;
  const windows = read.state === "answered" ? read.windows : last?.windows;
  const disabled = read.state !== "answered";

  const change = (patch: OffboardRulesPatch): void => {
    if (windows === undefined) return;
    const plan = planOffboardRulesChange(rulesOf(windows), patch);
    if (!plan.ok) {
      setProblem(`Not saved. ${plan.problem}`);
      return;
    }
    setProblem("");
    void machineSettingsSource()
      .writeCacheWindows(machine.name, plan.patch)
      .then((answer) => {
        if (Result.isSuccess(answer)) {
          lastAnswers.set(machine.name, { windows: answer.success, receivedAt: Date.now() });
          setRead({ state: "answered", windows: answer.success });
          return;
        }
        const { failure, message, reason } = answer.failure;
        if (reason === "unreachable" && failure !== "NoPathToMachine") {
          // The link closed before the answer: the change may have landed. Read what is there; never write again blind.
          setProblem(`May not have been saved on ${machine.label}: the link closed before it answered.`);
          setReadCount((count) => count + 1);
        } else {
          setProblem(`Not saved on ${machine.label}: ${failure ? `${failure}: ${message}` : message}`);
        }
      });
  };

  // One row per harness the machine has, and any harness still set on its own there.
  const installed = new Set(inventory?.harnesses.filter((row) => row.installed).map((row) => row.harness));
  const harnesses = HARNESS_IDS.filter((harness) => installed.has(harness) || windows?.harness[harness] !== undefined);

  return (
    <div className="offboard-settings" data-testid="offboard-settings" data-machine={machine.name}>
      {read.state === "refused" ? (
        <p className="settings-note" role="status" data-testid="offboard-machine-refused">
          {machineSettingsRefusal(machine.label, read.error)}.{" "}
          {last ? `Showing what it sent ${formatSeatAwarenessAge(Date.now() - last.receivedAt)}.` : ""}
        </p>
      ) : null}
      {problem ? (
        <p className="settings-error" role="alert" data-testid="offboard-settings-problem">
          {problem}
        </p>
      ) : null}

      {windows !== undefined && windows.cacheMode === undefined ? (
        <p className="settings-note" role="status" data-testid="offboard-cache-mode-old">
          Update this machine to choose a mode.
        </p>
      ) : windows !== undefined ? (
        <div
          className="offboard-settings__modes"
          role="radiogroup"
          aria-label="Cache mode"
          data-testid="offboard-cache-mode"
          // Arrows only move here: a mode changes what happens to seats.
          onKeyDown={radioGroupKeys(false)}
        >
          {CACHE_MODES.map((mode) => {
            const active = windows.cacheMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={radioTabIndex(active)}
                disabled={disabled}
                data-testid={`offboard-cache-mode-${mode}`}
                className={`offboard-settings__mode${active ? " is-active" : ""}`}
                onClick={() => {
                  if (!active) change({ cacheMode: mode });
                }}
              >
                <span className="offboard-settings__mode-label">{CACHE_MODE_COPY[mode].label}</span>
                <span className="offboard-settings__mode-line">{CACHE_MODE_COPY[mode].line}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <FieldRow
        label="Cache window"
        hint={`How long a seat on ${machine.isThisMachine ? "this machine" : machine.label} can stay still before its cache expires.`}
        group
      >
        <MinutesInput
          label="Cache window, minutes"
          value={windows?.cacheWindowMinutes ?? 0}
          disabled={disabled}
          testId="offboard-cache-window"
          onCommit={(minutes) => change({ cacheWindowMinutes: minutes })}
        />
      </FieldRow>

      <div className="offboard-settings__harnesses" role="group" aria-label="Per harness">
        {inventory === undefined && harnesses.length === 0 ? (
          <p className="settings-note">The harnesses on {machine.label} show once it has listed them.</p>
        ) : null}
        {harnesses.map((harness) => {
          const name = harnessName(harness);
          const minutes = windows?.harness[harness];
          const ownWindow = minutes !== undefined;
          return (
            <div key={harness} className="offboard-settings__harness" data-testid={`offboard-harness-${harness}`}>
              <span className="offboard-settings__harness-name">{name}</span>
              <label>
                <Switch
                  checked={ownWindow}
                  disabled={disabled}
                  aria-label={`${name} has its own window`}
                  onCheckedChange={(on) => {
                    if (windows === undefined) return;
                    change(on ? seedHarnessOverride(rulesOf(windows), harness) : { harness: { [harness]: null } });
                  }}
                />
                <span>{ownWindow ? "its own" : "follows the default"}</span>
              </label>
              {ownWindow ? (
                <MinutesInput
                  label={`${name} cache window, minutes`}
                  value={minutes}
                  disabled={disabled}
                  onCommit={(next) => change({ harness: { [harness]: { cacheWindowMinutes: next } } })}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
