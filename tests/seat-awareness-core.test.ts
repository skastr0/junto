/**
 * Seat awareness runs in the core. Its ports are the seat-state runtime and the
 * terminal observer plane, which live in the core process alone: main used to
 * start the plane over empty copies of both, so it observed no seats at all
 * (0.11.7). This holds the core to it: the plane starts from the settings as the
 * core finds them, follows the gate as they change, publishes each event as a
 * core push, and answers the window's snapshot and the collaboration gate from
 * the operation `seats.awareness`.
 */
import { readFileSync } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEAT_AWARENESS_COMPILED } from "../src/shared/features";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { defaultSettings, type Settings, type SettingsError } from "../src/shared/settings";
import type { SeatAwarenessEvent } from "../src/renderer/lib/seat-awareness-contract";
import { inProcessCore, type CoreRunner } from "../src/main/core-process/client";
import "../src/main/core-process/ops/seat-awareness";
import { subscribe } from "../src/main/core-process/push";
import { SettingsService } from "../src/main/junto/settings/service";
import {
  SEAT_AWARENESS_ENV,
  type SeatAwarenessPlane,
  type SeatAwarenessPlaneStartOptions,
} from "../src/main/junto/term/seat-awareness";
import { makeSeatAwarenessLive } from "../src/main/junto/term/seat-awareness-live";

const source = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const WINDOW: SeatAwarenessEvent = {
  kind: "window",
  bindingId: "seat",
  windowDigest: "digest",
  windowCapturedAt: 1,
  at: 2,
};

const fakePlane = () => {
  const listeners = new Set<(event: SeatAwarenessEvent) => void>();
  let running = false;
  const start = vi.fn((options: SeatAwarenessPlaneStartOptions) => {
    running = options.enabled;
  });
  const stop = vi.fn(() => {
    running = false;
  });
  const plane: SeatAwarenessPlane = {
    start,
    stop,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentEvents: () => [WINDOW],
    isEnabled: () => running,
  };
  return {
    plane,
    start,
    stop,
    emit: (event: SeatAwarenessEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
};

const fakeSettings = () => {
  const listeners = new Set<(next: Settings) => void>();
  const stored = defaultSettings();
  const storedSettings: Effect.Effect<Settings, SettingsError> = Effect.succeed(stored);
  const settings = {
    get: storedSettings,
    subscribe: (listener: (next: Settings) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    settings,
    change: (next: Settings) => {
      for (const listener of listeners) listener(next);
    },
  };
};

const overlay = process.env[SEAT_AWARENESS_ENV];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (overlay === undefined) delete process.env[SEAT_AWARENESS_ENV];
  else process.env[SEAT_AWARENESS_ENV] = overlay;
});

describe("the seat awareness plane in the core", () => {
  it("answers the window's snapshot and the collaboration gate from the core", () => {
    const ipc = source("src/main/junto/ipc.ts");
    // Main asks; it never holds a plane it has no seats to feed.
    expect(ipc).toContain('core.call("seats.awareness", {})');
    expect(ipc).not.toContain("seatAwarenessPlane");
    // The core starts it: entry.ts boots startCore, which builds the product layer.
    expect(source("src/main/core-process/entry.ts")).toContain("startCore(");
    expect(source("src/main/junto/core.ts")).toContain("makeCoreRuntime(");
    expect(source("src/main/core-runtime.ts")).toContain("makeCoreProductLayer(options.home)");
    expect(source("src/main/core-product.ts")).toContain("Layer.provide(SeatAwarenessLive, settings)");
  });

  it.runIf(SEAT_AWARENESS_COMPILED)(
    "starts from the settings, follows the gate, and publishes each event as a core push",
    async () => {
      process.env[SEAT_AWARENESS_ENV] = "on";
      const { plane, start, emit } = fakePlane();
      const { settings, change } = fakeSettings();
      const heard: unknown[] = [];
      const stopHearing = subscribe(IPC_CHANNELS.seatAwarenessChanged, (payload) => heard.push(payload));
      const runtime = ManagedRuntime.make(
        Layer.provide(
          makeSeatAwarenessLive({ plane }),
          Layer.succeed(SettingsService, settings as never),
        ),
      );
      const core = inProcessCore(runtime as unknown as CoreRunner);
      try {
        expect(await core.call("seats.awareness", {})).toEqual({ enabled: true, events: [WINDOW] });
        expect(start).toHaveBeenCalledTimes(1);

        emit(WINDOW);
        await vi.waitFor(() => expect(heard).toEqual([WINDOW]));

        // The operator turns it off: the plane stops, and the gate says so.
        process.env[SEAT_AWARENESS_ENV] = "off";
        change(defaultSettings());
        await vi.waitFor(async () => expect((await core.call("seats.awareness", {})).enabled).toBe(false));
        expect(plane.isEnabled()).toBe(false);

        // Turned on again, it starts again.
        process.env[SEAT_AWARENESS_ENV] = "on";
        change(defaultSettings());
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
        expect(await core.call("seats.awareness", {})).toMatchObject({ enabled: true });
      } finally {
        stopHearing();
        await runtime.dispose();
      }
      // The layer's scope is the plane's life: disposing the core stops it.
      expect(plane.isEnabled()).toBe(false);
    },
  );
});
