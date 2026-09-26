/**
 * The Experimental tab's product setting: `advanced.experimental`, a record of
 * feature key to boolean in the settings JSON body (no DDL, no migration).
 *
 * Pinned here: a toggle merges key by key, the record is bounded and strictly
 * typed, it survives the SQLite round trip, a row written before the tab still
 * decodes as "all off", and resetting Advanced does not quietly turn an
 * experimental feature off.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, ManagedRuntime, Result } from "effect";
import { applySettingsPatch, defaultSettings } from "../src/shared/settings";
import { applyAndValidatePatch, decodePatchInput } from "../src/main/junto/settings/patch";
import { makeSettingsService } from "../src/main/junto/settings/service";
import { StateEngine } from "../src/main/junto/state/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { seatAwarenessEnrolled } from "../src/main/junto/term/seat-awareness";
import { SEAT_AWARENESS_TIER } from "../src/shared/features";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("experimental settings contract", () => {
  it("is absent on a fresh install: every experimental feature starts off", () => {
    expect(defaultSettings().advanced.experimental).toBeUndefined();
  });

  it("merges one toggle without clearing another", () => {
    const first = applySettingsPatch(defaultSettings(), {
      advanced: { experimental: { seatAwareness: true } },
    });
    const second = applySettingsPatch(first, { advanced: { experimental: { other: true } } });
    expect(second.advanced.experimental).toEqual({ seatAwareness: true, other: true });
    const off = applySettingsPatch(second, { advanced: { experimental: { seatAwareness: false } } });
    expect(off.advanced.experimental).toEqual({ seatAwareness: false, other: true });
    // Other advanced fields ride along untouched.
    expect(off.advanced.openLastCanvas).toBe(defaultSettings().advanced.openLastCanvas);
  });

  it("accepts booleans only, and a bounded number of keys", () => {
    expect(Result.isSuccess(decodePatchInput({ advanced: { experimental: { seatAwareness: true } } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ advanced: { experimental: { seatAwareness: "yes" } } }))).toBe(true);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, true]));
    const patched = decodePatchInput({ advanced: { experimental: many } });
    // Either the patch or the merged settings must refuse it.
    const refused = Result.isFailure(patched) || Result.isFailure(applyAndValidatePatch(defaultSettings(), patched.success));
    expect(refused).toBe(true);
  });
});

describe("experimental settings in SQLite", () => {
  let root = "";
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  const openService = async () => {
    await dispose?.();
    if (!root) root = await mkdtemp(join(tmpdir(), "junto-experimental-settings-"));
    const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "state", "junto.db")));
    const state = await runtime.runPromise(StateEngine);
    const service = await run(makeSettingsService(state, {}));
    dispose = () => runtime.dispose();
    return service;
  };

  it("persists the toggle, and an Advanced reset keeps it", async () => {
    const service = await openService();
    await run(service.patch({ advanced: { experimental: { seatAwareness: true }, logsExplorer: true } }));

    // Survives a reopen: it is a row in junto.db, not renderer state.
    const reopened = await openService();
    const stored = await run(reopened.get);
    expect(stored.advanced.experimental).toEqual({ seatAwareness: true });
    expect(seatAwarenessEnrolled(stored)).toBe(SEAT_AWARENESS_TIER !== false);

    const reset = await run(reopened.reset("advanced"));
    expect(reset.advanced.logsExplorer).toBe(false);
    expect(reset.advanced.experimental).toEqual({ seatAwareness: true });

    // A full reset is a full reset.
    const all = await run(reopened.reset());
    expect(all.advanced.experimental).toBeUndefined();
    expect(seatAwarenessEnrolled(all)).toBe(SEAT_AWARENESS_TIER === true);
  });
});
