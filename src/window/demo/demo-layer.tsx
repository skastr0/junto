import { useCallback, useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { DemoScenario } from "@shared/demo";
import { DemoWindow, type DemoEdl } from "../../contract/window/demo";
import { useWindowRuntime, useWindowService } from "../rpc/runtime";
import { demoScenarios } from "./scenarios";
import { demo$, startTake, stopTake } from "./conductor";
import { demoHud$ } from "./ops";
import { isOperatorTyping } from "../lib/focus-ownership";

const DEFAULT_SCENARIO_ID = "trailer-60";
// Indexed via a Record cast: demoScenarios' exact key type is derived from
// each scenario's own `.id` literal, which this file has no reason to track.
const scenariosById = demoScenarios as Readonly<Record<string, DemoScenario | undefined>>;

// Demo/scripting engine only. Self-gating: checks demoState() once on mount
// and renders null forever when the app wasn't launched with --junto-demo /
// JUNTO_DEMO=1, so product behavior with demo off is byte-identical.
export function DemoLayer() {
  const runtime = useWindowRuntime();
  const demo = useWindowService(DemoWindow);
  // A finished take's EDL goes to main, which writes it under ~/.junto/demo.
  const writeEdl = useCallback(
    (edl: DemoEdl): void => {
      void runtime.runPromise(demo.DemoWriteEdl({ edl })).catch(() => undefined);
    },
    [runtime, demo],
  );
  const [active, setActive] = useState(false);
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO_ID);

  useEffect(() => {
    let cancelled = false;
    let rollTimer: number | undefined;
    void runtime
      .runPromise(demo.DemoState())
      .then((info) => {
        if (cancelled || !info.active) return;
        setActive(true);
        const requested =
          info.scenarioId !== undefined && scenariosById[info.scenarioId] !== undefined
            ? info.scenarioId
            : DEFAULT_SCENARIO_ID;
        setScenarioId(requested);
        if (info.autoroll) {
          // Delay past first paint so the camera bridge is mounted before beat 0.
          rollTimer = window.setTimeout(() => {
            const scenario = scenariosById[requested];
            if (scenario && !demo$.running.peek()) startTake(scenario, writeEdl);
          }, 2_000);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (rollTimer !== undefined) window.clearTimeout(rollTimer);
    };
  }, [runtime, demo, writeEdl]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isOperatorTyping(event.target)) return;
      if (event.key === "F9") {
        event.preventDefault();
        const scenario = scenariosById[scenarioId];
        if (scenario) startTake(scenario, writeEdl);
        return;
      }
      if (event.key === "Escape" && demo$.running.peek()) {
        event.preventDefault();
        stopTake();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, scenarioId, writeEdl]);

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
      <div>DEMO - F9 to roll - {scenarioId}</div>
      {running ? <div>beat {beat}/{total}</div> : null}
    </div>
  );
}
