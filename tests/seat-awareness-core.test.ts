/**
 * Seat awareness runs in the core. Its ports are the seat-state runtime and the
 * terminal observer plane, which live in the core process alone: main used to
 * start the plane over empty copies of both, so it observed no seats at all
 * (0.11.7). This holds the core to it: the plane starts from the settings as the
 * core finds them, follows the gate as they change, publishes each event as a
 * core push, and answers the window's snapshot and the collaboration gate from
 * the awareness group (src/contract/core/seat-awareness.ts).
 */
import { readFileSync } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import { RpcTest } from "effect/rpc";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEAT_AWARENESS_COMPILED } from "../src/shared/features";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { defaultSettings, type Settings, type SettingsError } from "../src/shared/settings";
import type { SeatAwarenessEvent } from "../src/shared/seat-awareness-contract";
import { SeatAwarenessCore, SeatAwarenessRpcs } from "../src/contract/core/seat-awareness";
import { SeatAwarenessHandlers } from "../src/core/ops/seat-awareness";
import { subscribe } from "../src/app/core-process/main-side/core-pushes";
import { SettingsService } from "../src/core/settings/service";
import {
  SEAT_AWARENESS_ENV,
  type SeatAwarenessPlane,
  type SeatAwarenessPlaneStartOptions,
} from "../src/core/term/seat-awareness";
import { makeSeatAwarenessLive } from "../src/core/term/seat-awareness-live";

vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { registerSeatAwarenessIpc } = await import("../src/app/term/seat-awareness-ipc");

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
    const ipc = source("src/app/ipc.ts");
    // Main asks; it never holds a plane it has no seats to feed.
    expect(ipc).toContain("registerSeatAwarenessIpc(privilegedIpc, boot.core)");
    expect(ipc).toContain("await seatAwareness.enabled()");
    expect(ipc).not.toContain("seatAwarenessPlane");
    // The core starts it: entry.ts boots startCore, which builds the product layer.
    expect(source("src/core/entry.ts")).toContain("startCore(");
    expect(source("src/core/core.ts")).toContain("makeCoreRuntime(");
    expect(source("src/core/core-runtime.ts")).toContain("makeCoreProductLayer(options.home, options.log)");
    expect(source("src/core/core-product.ts")).toContain("Layer.provide(SeatAwarenessLive, settings)");
  });

  it.runIf(SEAT_AWARENESS_COMPILED)(
    "starts from the settings, follows the gate, and publishes each event as a core push",
    async () => {
      process.env[SEAT_AWARENESS_ENV] = "on";
      const { plane, start, emit } = fakePlane();
      const { settings, change } = fakeSettings();
      const heard: unknown[] = [];
      const stopHearing = subscribe(IPC_CHANNELS.seatAwarenessChanged, (payload) => heard.push(payload));
      // The core's side of the group, in this process: main's client reaches its handlers.
      const runtime = ManagedRuntime.make(
        Layer.effect(SeatAwarenessCore, RpcTest.makeClient(SeatAwarenessRpcs)).pipe(
          Layer.provide(SeatAwarenessHandlers),
          Layer.provide(makeSeatAwarenessLive({ plane })),
          Layer.provide(Layer.succeed(SettingsService, settings as never)),
        ),
      );
      const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
      const ipc = {
        handle: (channel: string, listener: (event: IpcMainInvokeEvent) => unknown) => {
          handlers.set(channel, listener);
        },
      } as unknown as Pick<IpcMain, "handle">;
      try {
        const gate = registerSeatAwarenessIpc(ipc, await runtime.context());
        const snapshot = () => handlers.get(IPC_CHANNELS.seatAwarenessSnapshot)?.({} as IpcMainInvokeEvent);
        expect(await snapshot()).toEqual([WINDOW]);
        expect(await gate.enabled()).toBe(true);
        expect(start).toHaveBeenCalledTimes(1);

        emit(WINDOW);
        await vi.waitFor(() => expect(heard).toEqual([WINDOW]));

        // The operator turns it off: the plane stops, and the gate says so.
        process.env[SEAT_AWARENESS_ENV] = "off";
        change(defaultSettings());
        await vi.waitFor(async () => expect(await gate.enabled()).toBe(false));
        expect(plane.isEnabled()).toBe(false);

        // Turned on again, it starts again.
        process.env[SEAT_AWARENESS_ENV] = "on";
        change(defaultSettings());
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
        expect(await gate.enabled()).toBe(true);
      } finally {
        stopHearing();
        await runtime.dispose();
      }
      // The layer's scope is the plane's life: disposing the core stops it.
      expect(plane.isEnabled()).toBe(false);
    },
  );
});
