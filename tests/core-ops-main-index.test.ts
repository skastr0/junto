import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { inProcessCore, type CoreRunner } from "../src/main/core-process/client";
import { AGENT_SIGNAL_CHANGED, SETTINGS_CHANGED, WORK_PREAMBLE, publishWindowBroadcasts, relayWindowPushes } from "../src/main/core-process/ops/main-index";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { portCore, serveCore, type CorePort } from "../src/main/core-process/port";
import { emitAgentSignalChanged } from "../src/main/junto/signals/changes";
import { subscribe } from "../src/main/core-process/push";
import { SettingsService } from "../src/main/junto/settings/service";
import type { Settings } from "../src/shared/settings";

// The index.ts request group: answers cross as data, and a change the core
// watches reaches main through the push bus rather than a callback.
describe("index.ts core operations", () => {
  it("reads the settings, and a watch publishes them as they stand, then each change once, however often it is asked", async () => {
    const listeners: Array<(settings: Settings) => void> = [];
    const first = { machine: { supervisedPreferred: false } } as unknown as Settings;
    const runtime = ManagedRuntime.make(Layer.succeed(SettingsService, {
      get: Effect.succeed(first),
      subscribe: (listener: (settings: Settings) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    } as never));
    const core = inProcessCore(runtime);
    const pushed: Array<unknown> = [];
    const off = subscribe(SETTINGS_CHANGED, (payload) => pushed.push(payload));
    try {
      expect(await core.call("settings.read", {})).toBe(first);
      await core.call("settings.watch", {});
      await core.call("settings.watch", {});
      expect(listeners).toHaveLength(1);
      const next = { machine: { supervisedPreferred: true } } as unknown as Settings;
      listeners[0]!(next);
      // Each watch publishes the settings as they stand; changes follow on the same channel.
      expect(pushed).toEqual([first, first, next]);
    } finally {
      off();
      await runtime.dispose();
    }
  });

  it("refuses a seat's box comment on a page it cannot name before main takes any shot", async () => {
    // A ref that does not parse is refused before any service is asked.
    const runtime = ManagedRuntime.make(Layer.empty);
    const core = inProcessCore(runtime as unknown as CoreRunner);
    try {
      const checked = await core.call("pageBox.check", {
        owner: "o", sessionId: "s", seatNodeId: "seat", pageRef: "not a ref", rect: { x: 0, y: 0, w: 1, h: 1 }, text: "look",
      });
      expect(checked).toMatchObject({ ok: false, code: "invalid" });
    } finally {
      await runtime.dispose();
    }
  });

  it("publishes the window's broadcasts on their channels until stopped", () => {
    const seen: Array<[string, unknown]> = [];
    const offs = [WORK_PREAMBLE, AGENT_SIGNAL_CHANGED].map((channel) => subscribe(channel, (payload) => seen.push([channel, payload])));
    const broadcasts = publishWindowBroadcasts();
    try {
      const preamble = { preambleId: "p1", canvasName: "factory", nodeId: "seat", text: "hello", expiresAt: 1 };
      const signal = { canvasName: "factory", nodeId: "seat", kind: "blocked" } as never;
      broadcasts.onPreamble(preamble);
      emitAgentSignalChanged(signal);
      broadcasts.stop();
      emitAgentSignalChanged(signal);
      expect(seen).toEqual([[WORK_PREAMBLE, preamble], [AGENT_SIGNAL_CHANGED, signal]]);
    } finally {
      for (const off of offs) off();
    }
  });

  it("a preamble and a signal pushed by a core in its own process reach main's subscribers", async () => {
    const portOf = (port: MessagePort): CorePort => ({
      post: (message) => port.postMessage(message),
      listen: (handler) => {
        const on = (message: Parameters<typeof handler>[0]) => handler(message);
        port.on("message", on);
        return () => port.off("message", on);
      },
    });
    const { port1, port2 } = new MessageChannel();
    const runtime = ManagedRuntime.make(Layer.empty);
    const served = serveCore(portOf(port2), runtime as unknown as CoreRunner);
    const stopRelay = relayWindowPushes(portCore(portOf(port1)));
    const seen: Array<[string, unknown]> = [];
    const offs = [WORK_PREAMBLE, AGENT_SIGNAL_CHANGED].map((channel) => subscribe(channel, (payload) => seen.push([channel, payload])));
    try {
      const preamble = { preambleId: "p1", canvasName: "factory", nodeId: "seat", text: "hello", expiresAt: 1 };
      const signal = { signalId: "s1", canvasName: "factory", nodeId: "seat" };
      served.push(WORK_PREAMBLE, preamble);
      served.push(AGENT_SIGNAL_CHANGED, signal);
      await new Promise<void>((resolve) => {
        const wait = () => (seen.length >= 2 ? resolve() : setTimeout(wait, 5));
        wait();
      });
      expect(seen).toEqual([[WORK_PREAMBLE, preamble], [AGENT_SIGNAL_CHANGED, signal]]);
    } finally {
      for (const off of offs) off();
      stopRelay();
      port1.close();
      await runtime.dispose();
    }
  });
});
