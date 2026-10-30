import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { inProcessCore, type CoreRunner } from "./support/in-process-core";
import { publishWindowBroadcasts } from "../src/main/core-process/ops/main-index";
import { relayWindowPushes } from "../src/main/core-process/main-side/window-pushes";
import { AGENT_SIGNAL_CHANGED, CANVAS_CHANGED, SETTINGS_CHANGED, WORK_PREAMBLE } from "../src/main/core-process/channels";
import { ModelService } from "../src/main/junto/model/service";
import { PausePlane } from "../src/main/junto/pause-plane";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { portCore, type CorePort } from "../src/main/core-process/port";
import { serveCore } from "../src/main/core-process/serve";
import { emitAgentSignalChanged } from "../src/main/junto/signals/changes";
import { subscribe } from "../src/main/core-process/push";
import { SettingsService } from "../src/main/junto/settings/service";
import { redactProvidersForIpc, type Settings } from "../src/shared/settings";

// The index.ts request group: answers cross as data, and a change the core
// watches reaches main through the push bus rather than a callback.
describe("index.ts core operations", () => {
  it("reads the settings, and a watch publishes them as they stand, then each change once, however often it is asked, never with a secret", async () => {
    const listeners: Array<(settings: Settings) => void> = [];
    const first = { machine: { supervisedPreferred: false }, providers: { openai: { apiKey: "sk-first" } } } as unknown as Settings;
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
      const read = await core.call("settings.read", {});
      expect(read).toEqual(redactProvidersForIpc(first));
      expect(JSON.stringify(read)).not.toContain("sk-");
      await core.call("settings.watch", {});
      await core.call("settings.watch", {});
      expect(listeners).toHaveLength(1);
      const next = { machine: { supervisedPreferred: true }, providers: { openai: { apiKey: "sk-next" } } } as unknown as Settings;
      listeners[0]!(next);
      // Each watch publishes the settings as they stand; changes follow on the same channel, masked.
      expect(pushed).toEqual([redactProvidersForIpc(first), redactProvidersForIpc(first), redactProvidersForIpc(next)]);
      expect(JSON.stringify(pushed)).not.toContain("sk-");
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
    const offs = ([WORK_PREAMBLE, AGENT_SIGNAL_CHANGED] as const).map((channel) => subscribe(channel, (payload) => seen.push([channel, payload])));
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
    const offs = ([WORK_PREAMBLE, AGENT_SIGNAL_CHANGED] as const).map((channel) => subscribe(channel, (payload) => seen.push([channel, payload])));
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

  it("publishes canvas changes for the browser, subscribed once however often asked, and reads a play state as it is now", async () => {
    const changes: Array<(event: { canvas: string }, next: unknown) => void> = [];
    const removals: Array<(event: { _tag: string; canvas: string }) => void> = [];
    const pause = { playing: true };
    const runtime = ManagedRuntime.make(Layer.mergeAll(
      Layer.succeed(ModelService, {
        subscribeChanges: (listener: never) => (changes.push(listener), () => undefined),
        subscribeCanvasesChanges: (listener: never) => (removals.push(listener), () => undefined),
      } as never),
      Layer.succeed(PausePlane, { stateFor: () => ({ playing: pause.playing, everPlayed: true }) } as never),
    ));
    const core = inProcessCore(runtime as unknown as CoreRunner);
    const seen: unknown[] = [];
    const off = subscribe(CANVAS_CHANGED, (payload) => seen.push(payload));
    try {
      await core.call("model.watchCanvases", {});
      await core.call("model.watchCanvases", {});
      expect([changes.length, removals.length]).toEqual([1, 1]);
      changes[0]!({ canvas: "factory" }, { name: "factory" });
      removals[0]!({ _tag: "Removed", canvas: "lab" });
      removals[0]!({ _tag: "Added", canvas: "new" });
      expect(seen).toEqual([{ canvas: "factory", next: { name: "factory" } }, { canvas: "lab", next: undefined }]);
      expect(await core.call("pause.playing", { canvas: "factory" })).toBe(true);
      pause.playing = false;
      expect(await core.call("pause.playing", { canvas: "factory" })).toBe(false);
    } finally {
      off();
      await runtime.dispose();
    }
  });
});
