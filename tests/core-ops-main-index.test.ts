import { Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import type { CoreRunner } from "./support/in-process-core";
import { publishWindowBroadcasts } from "../src/core/ops/main-index";
import { relayWindowPushes } from "../src/app/core-process/main-side/window-pushes";
import { AGENT_SIGNAL_CHANGED, WORK_PREAMBLE } from "../src/contract/core/channels";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { portCore, type CorePort } from "../src/contract/core/port";
import { runHostOp } from "../src/app/core-process/main-side/host-op-bodies";
import { serveCore } from "../src/core/serve";
import { emitAgentSignalChanged } from "../src/core/signals/changes";
import { subscribe } from "../src/app/core-process/main-side/core-pushes";

// The window's broadcasts from a core in its own process reach main through
// the push bus rather than a callback. What index.ts asks the core on a
// request is the main-index group (tests/core-rpc-main-index.test.ts).
describe("index.ts core broadcasts", () => {
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
    const stopRelay = relayWindowPushes(portCore(portOf(port1), runHostOp));
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
});
