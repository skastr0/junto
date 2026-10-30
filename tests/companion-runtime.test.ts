import { Effect } from "effect";
import { expect, it } from "vitest";
import { CompanionRuntime, bindCompanionHost, showCompanionSignal } from "../src/main/junto/companion/runtime";

// The phone companion runs on the core it is bound to, in main or the core process alike.
it("runs on the core it is bound to, and shows a signal through it", async () => {
  await expect(CompanionRuntime.runPromise(Effect.succeed(1))).rejects.toThrow("the phone companion has no core");
  const ran: unknown[] = [];
  const shown: unknown[] = [];
  const unbind = bindCompanionHost({
    runPromise: (effect) => Effect.runPromise(effect as Effect.Effect<never>).then((value) => (ran.push(value), value)),
    showSignal: (signal) => shown.push(signal),
  });
  expect(await CompanionRuntime.runPromise(Effect.succeed(2))).toBe(2);
  showCompanionSignal({ signalId: "s1" } as never);
  unbind();
  showCompanionSignal({ signalId: "s2" } as never);
  expect(ran).toEqual([2]);
  expect(shown).toEqual([{ signalId: "s1" }]);
});
