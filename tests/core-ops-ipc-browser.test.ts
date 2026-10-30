import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { inProcessCore, type CoreRunner } from "../src/main/core-process/client";
import "../src/main/core-process/ops/ipc-browser";
import { SettingsService } from "../src/main/junto/settings/service";

// Main draws the box and takes the shot; the core holds the staged shots and the store.
it("answers the browser's pool limits and box comments in the core, refusing what it never staged", async () => {
  const runtime = ManagedRuntime.make(Layer.succeed(SettingsService, {
    get: Effect.succeed({ browser: { maxVisibleSurfaces: 3, maxWarmSessions: 5 } }),
  } as never));
  const core = inProcessCore(runtime as unknown as CoreRunner);
  const page = { canvasName: "factory", nodeId: "page" };
  try {
    expect(await core.call("browser.poolLimits", {})).toEqual({ maxVisibleSurfaces: 3, maxWarmSessions: 5 });
    // A shot whose address cannot be named on a comment is refused before anything is stored.
    expect(await core.call("pageBox.stage", {
      sessionId: "s", page, shot: { png: new Uint8Array([1]), url: "not a url", scroll: { x: 0, y: 0 }, rect: { x: 0, y: 0, w: 1, h: 1 } } as never,
    })).toMatchObject({ ok: false, code: "invalid" });
    expect(await core.call("pageBox.operatorPost", { page, sessionId: "s", shotId: "01J00000000000000000000000", text: "look" }))
      .toMatchObject({ ok: false, code: "invalid" });
    await expect(core.call("pageBox.discard", { sessionId: "s", shotId: "01J00000000000000000000000" })).resolves.toBeUndefined();
    await expect(core.call("pageBox.releaseSession", { sessionId: "s" })).resolves.toBeUndefined();
  } finally {
    await runtime.dispose();
  }
});
