/**
 * Settings -> Context: when Junto asks an agent to hand off a full context.
 * The default limit applies to every seat without one of its own (set in the
 * seat's Customize, context section). Each control writes one field through
 * settingsPatch.
 */
import { use$ } from "@legendapp/state/react";
import { useEffect, useState } from "react";
import { HARNESS_IDS, templateFor } from "@shared/managed-terminal-templates";
import {
  HARNESS_CONTEXT_SUPPORT,
  TOKEN_PRESSURE_BOUNDS,
  tokenPressureSettings,
  type TokenPressurePatch,
} from "@shared/token-pressure";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Input, Switch } from "../ui";
import { ThresholdFields } from "./ThresholdFields";

const save = (patch: TokenPressurePatch): void => {
  void patchSettings({ tokenPressure: patch });
};

const names = (ids: ReadonlyArray<string>): string => {
  const list = ids.map((id) => templateFor(id as (typeof HARNESS_IDS)[number]).displayName);
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
};

/** Which harnesses each kind of limit can apply to, read off the support table. */
export const contextSupportLines = (): { readonly tokens: string; readonly percent: string; readonly none: string } => {
  const agents = HARNESS_IDS.filter((id) => id !== "junto-overseer");
  const readable = agents.filter((id) => Object.hasOwn(HARNESS_CONTEXT_SUPPORT, id));
  const windowed = readable.filter((id) => HARNESS_CONTEXT_SUPPORT[id]?.window !== undefined);
  const none = agents.filter((id) => !readable.includes(id));
  return { tokens: names(readable), percent: names(windowed), none: names(none) };
};

function Row({ title, hint, children }: { readonly title: string; readonly hint: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(200px,260px)] items-center gap-x-6 border-b border-stroke py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[14px] font-semibold text-ink">{title}</span>
        <p className="m-0 max-w-[58ch] text-[12px] leading-[1.5] text-dim">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ContextSettingsSection() {
  const prefs = use$(() => tokenPressureSettings(state$.settings.get()));
  const [grace, setGrace] = useState<string>();
  useEffect(() => setGrace(undefined), [prefs.graceMinutes]);
  const support = contextSupportLines();

  const commitGrace = (): void => {
    if (grace === undefined) return;
    setGrace(undefined);
    const value = Number(grace.trim());
    if (!Number.isFinite(value)) return;
    const { min, max } = TOKEN_PRESSURE_BOUNDS.graceMinutes;
    const minutes = Math.min(max, Math.max(min, Math.round(value)));
    if (minutes !== prefs.graceMinutes) save({ graceMinutes: minutes });
  };

  return (
    <div className="flex flex-col" data-testid="context-settings">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-b border-stroke py-3.5">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="context-offboard" className="cursor-pointer text-[14px] font-semibold text-ink">
            Ask agents to offboard when their context fills
          </label>
          <p className="m-0 max-w-[58ch] text-[12px] leading-[1.5] text-dim">
            Past the limit, Junto tells the agent to write down where it is and offboard, once, between turns. A seat
            that has not offboarded when the grace period ends is rotated into a fresh session.
          </p>
        </div>
        <Switch id="context-offboard" checked={prefs.enabled} onCheckedChange={(on) => save({ enabled: on })} />
      </div>
      <Row
        title="Default limit"
        hint="For every seat without a limit of its own. Keep a percent under the harness's own compaction point so the agent still has room to write its handoff."
      >
        <ThresholdFields
          label="Default limit"
          threshold={prefs.threshold}
          disabled={!prefs.enabled}
          onChange={(threshold) => save({ threshold })}
        />
      </Row>
      <Row title="Grace period" hint="Minutes an agent has to offboard after it is asked, before Junto rotates it.">
        <div className="flex items-center gap-2">
          <Input
            value={grace ?? String(prefs.graceMinutes)}
            inputMode="numeric"
            disabled={!prefs.enabled}
            aria-label="Grace period in minutes"
            onChange={(event) => setGrace(event.target.value)}
            onBlur={commitGrace}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitGrace();
              } else if (event.key === "Escape" && grace !== undefined) {
                event.preventDefault();
                event.stopPropagation();
                setGrace(undefined);
              }
            }}
          />
          <span className="text-[12px] text-dim">minutes</span>
        </div>
      </Row>
      <div className="flex flex-col gap-1.5 py-3.5 text-[12px] leading-[1.5] text-dim">
        <p className="m-0 max-w-[70ch]">A token limit works for {support.tokens}.</p>
        <p className="m-0 max-w-[70ch]">A percent limit works for {support.percent}, whose context window Junto knows.</p>
        {support.none ? (
          <p className="m-0 max-w-[70ch]">
            {support.none} do not write their context use where Junto can read it, so no limit applies to them.
          </p>
        ) : null}
      </div>
    </div>
  );
}
