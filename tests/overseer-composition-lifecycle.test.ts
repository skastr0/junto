import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mainAuthoringGate } from "../src/main/vellum-command/main-authoring-gate";

describe("overseer composition lifecycle", () => {
  it("passes AbortSignal into Effect.runPromise and interrupts the fiber", async () => {
    const controller = new AbortController();
    const program = Effect.sleep("2 seconds").pipe(Effect.as("done"));
    const pending = Effect.runPromise(program, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("keeps the authoring gate occupied until the interrupted fiber finishes", async () => {
    const label = "control.overseer";
    let released = false;
    const controller = new AbortController();
    const program = Effect.sleep("50 millis").pipe(
      Effect.ensuring(Effect.sync(() => {
        released = true;
      })),
    );
    const running = mainAuthoringGate.run(label, () =>
      Effect.runPromise(program, { signal: controller.signal }).catch(() => undefined),
    );
    controller.abort();
    await running;
    expect(released).toBe(true);
  });
});
