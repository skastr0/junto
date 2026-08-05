import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { DemoScenario } from "@shared/demo";
import { demoScenarios } from "./scenarios";
import { demo$, startTake, stopTake } from "./conductor";
import { demoHud$ } from "./ops";

const TRAILER_SCENARIO_ID = "trailer-60";
// Indexed via a Record cast: demoScenarios' exact key type is derived from
// each scenario's own `.id` literal, which this file has no reason to track.
const scenariosById = demoScenarios as Readonly<Record<string, DemoScenario | undefined>>;

// Demo/scripting engine only. Self-gating: checks demoState() once on mount
// and renders null forever when the app wasn't launched with --vellum-demo /
// VELLUM_DEMO=1, so product behavior with demo off is byte-identical.
export function DemoLayer() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const api = window.vellum;
    if (!api) return;
    let cancelled = false;
    let rollTimer: number | undefined;
    void api
      .demoState()
      .then((info) => {
        if (cancelled || !info.active) return;
        setActive(true);
        if (info.autoroll) {
          // Delay past first paint so the camera bridge is mounted before beat 0.
          rollTimer = window.setTimeout(() => {
            const scenario = scenariosById[TRAILER_SCENARIO_ID];
            if (scenario && !demo$.running.peek()) startTake(scenario);
          }, 2_000);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (rollTimer !== undefined) window.clearTimeout(rollTimer);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if (event.key === "F9") {
        event.preventDefault();
        const scenario = scenariosById[TRAILER_SCENARIO_ID];
        if (scenario) startTake(scenario);
        return;
      }
      if (event.key === "Escape" && demo$.running.peek()) {
        event.preventDefault();
        stopTake();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const running = use$(demo$.running);
  const beat = use$(demo$.beat);
  const total = use$(demo$.total);
  const hudVisible = use$(demoHud$);

  if (!active || !hudVisible) return null;

  return (
    <div
      className="pointer-events-none fixed z-[60] font-mono"
      style={{
        left: 12,
        bottom: 12,
        padding: "4px 8px",
        borderRadius: 4,
        background: "color-mix(in oklab, var(--color-ground) 85%, transparent)",
        color: "var(--color-ink)",
        fontSize: 11,
        border: "1px solid var(--color-stroke)",
      }}
    >
      <div>DEMO - F9 to roll - trailer-60</div>
      {running ? <div>beat {beat}/{total}</div> : null}
    </div>
  );
}
