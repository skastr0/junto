/**
 * Settings → Experimental: features that are built and ship in this build,
 * compiled in but off until the operator turns them on.
 *
 * The list is the build's own: every feature whose tier is experimental, with
 * the catalog's plain description, anything it needs beyond the toggle, and
 * when the toggle takes effect. Each toggle writes `advanced.experimental`
 * through settingsPatch; main folds it into the one resolved predicate every
 * consumer reads. Nothing here is renderer-local.
 */
import { use$ } from "@legendapp/state/react";
import { experimentalFeatureSpec, type FeatureKey } from "@shared/feature-catalog";
import { experimentalFeatureKeys, featureOn } from "@shared/features";
import { setExperimentalFeature } from "../../lib/experimental-features";
import { seatAwareness$ } from "../../lib/seat-awareness";
import { state$ } from "../../lib/state";
import { StatusDot, Switch, type StatusTone } from "../ui";
import "./experimental-settings.css";

type Requirement = { readonly tone: StatusTone; readonly line: string };

/**
 * What the running feature has told us about its requirement. Only seat
 * awareness has one today, and its own readings are the witness: a seat that
 * reports the missing key, or one that was actually assessed. Before either,
 * the catalog's plain sentence stands alone.
 */
const useSeatAwarenessKeyState = (on: boolean, fallback: string): Requirement => {
  const readings = use$(seatAwareness$.byBindingId);
  if (!on) return { tone: "dim", line: fallback };
  const assessments = Object.values(readings ?? {});
  if (assessments.some((a) => a?.unavailableReason === "missing_key")) {
    return { tone: "amber", line: "No provider key found. Set TYPESAFE_API_KEY and restart Junto." };
  }
  if (assessments.some((a) => a?.availability === "current")) {
    return { tone: "green", line: "Provider key found; seats are being read." };
  }
  return { tone: "dim", line: fallback };
};

function ExperimentalFeatureRow({ featureKey }: { readonly featureKey: FeatureKey }) {
  const spec = experimentalFeatureSpec(featureKey);
  const on = use$(() =>
    featureOn(featureKey, state$.settings.advanced.experimental.get()),
  );
  const requirementFallback = spec?.requirement?.label ?? "";
  const keyState = useSeatAwarenessKeyState(
    featureKey === "seatAwareness" && on,
    requirementFallback,
  );
  if (spec === undefined) return null;
  const id = `experimental-${featureKey}`;
  const requirement: Requirement | undefined =
    spec.requirement === undefined
      ? undefined
      : featureKey === "seatAwareness"
        ? keyState
        : { tone: "dim", line: spec.requirement.label };

  return (
    <div className="experimental-feature" data-feature={featureKey} data-on={on ? "true" : "false"}>
      <div className="experimental-feature__text">
        <label className="experimental-feature__title" htmlFor={id}>
          {spec.title}
        </label>
        <p className="experimental-feature__description" id={`${id}-description`}>
          {spec.description}
        </p>
        <ul className="experimental-feature__facts">
          {requirement !== undefined ? (
            <li>
              <span className="experimental-feature__dot">
                <StatusDot tone={requirement.tone} />
              </span>
              <span>{requirement.line}</span>
            </li>
          ) : null}
          <li className="experimental-feature__applies">
            {spec.applies === "live"
              ? "Applies at once, no restart."
              : "Applies after you restart Junto."}
          </li>
        </ul>
      </div>
      <Switch
        id={id}
        className="mt-px"
        checked={on}
        aria-describedby={`${id}-description`}
        onCheckedChange={(next) => void setExperimentalFeature(featureKey, next)}
      />
    </div>
  );
}

export function ExperimentalSettingsSection() {
  const keys = experimentalFeatureKeys();
  return (
    <div className="settings-section">
      <p className="experimental-lead">
        Each one stays off until you turn it on here, and you can turn it off again at any time.
      </p>
      <div className="experimental-list">
        {keys.map((key) => (
          <ExperimentalFeatureRow key={key} featureKey={key} />
        ))}
      </div>
    </div>
  );
}
