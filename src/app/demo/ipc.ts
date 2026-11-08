/**
 * Main's handlers of the window's demo group (--junto-demo only; inert
 * otherwise). Always served, so a window's DemoState never waits on a missing
 * handler: the behaviour is the flag's, never the registration's.
 */
import { Effect } from "effect";
import { DemoWindowRpcs } from "../../contract/window/demo";
import { isDemoMode } from "../../node/demo/mode";
import { writeDemoEdl } from "./service";

export const DemoWindowHandlers = DemoWindowRpcs.toLayer({
  DemoState: () =>
    Effect.sync(() =>
      isDemoMode()
        ? {
            active: true,
            autoroll: process.env.JUNTO_DEMO_AUTOROLL === "1",
            ...(process.env.JUNTO_DEMO_SCENARIO === undefined ? {} : { scenarioId: process.env.JUNTO_DEMO_SCENARIO }),
          }
        : { active: false, autoroll: false },
    ),
  DemoWriteEdl: ({ edl }) =>
    isDemoMode() ? Effect.promise(() => writeDemoEdl(edl)) : Effect.succeed({ ok: false, error: "demo mode off" }),
});
