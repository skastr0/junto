import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { publishWindowBroadcasts } from "../src/core/ops/main-index";
import { relayWindowPushes } from "../src/app/core-process/main-side/window-pushes";
import { AGENT_SIGNAL_CHANGED, WORK_PREAMBLE } from "../src/contract/core/channels";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { portPushes, type CorePort } from "../src/contract/core/port";
import { serveCore } from "../src/core/serve";
import { emitAgentSignalChanged } from "../src/core/signals/changes";
import { deliverPush, makeCorePushesMain, subscribe } from "../src/app/core-process/main-side/core-pushes";
import { CorePushes } from "../src/core/push";
import type { AgentSignal } from "../src/shared/agent-signals";

/** A whole signal: main decodes each push with its Schema, and refuses a partial one. */
const signal: AgentSignal = { signalId: "s1", canvasName: "factory", nodeId: "seat", kind: "blocked", text: "needs a hand", createdAt: 1, state: "open" };

// The window's broadcasts from a core in its own process reach main through
// the push bus rather than a callback. What index.ts asks the core on a
// request is the main-index group (tests/core-rpc-main-index.test.ts).
describe("index.ts core broadcasts", () => {
  it("publishes the window's broadcasts on their channels until stopped", () => {
    const seen: Array<[string, unknown]> = [];
    const offs = ([WORK_PREAMBLE, AGENT_SIGNAL_CHANGED] as const).map((channel) => subscribe(channel, (payload) => seen.push([channel, payload])));
    const broadcasts = publishWindowBroadcasts(CorePushes.over(deliverPush));
    try {
      const preamble = { preambleId: "p1", canvasName: "factory", nodeId: "seat", text: "hello", expiresAt: 1 };
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
    const served = serveCore(portOf(port2));
    // Main's bus for this boot, as main-boot builds it: the relay is its feed.
    const scope = Scope.makeUnsafe();
    const { pushes, deliver } = Effect.runSync(Scope.provide(makeCorePushesMain, scope));
    const stopRelay = relayWindowPushes(portPushes(portOf(port1)), deliver);
    const seen: Array<[string, unknown]> = [];
    const offs = ([WORK_PREAMBLE, AGENT_SIGNAL_CHANGED] as const).map((channel) => pushes.subscribe(channel, (payload) => seen.push([channel, payload])));
    try {
      const preamble = { preambleId: "p1", canvasName: "factory", nodeId: "seat", text: "hello", expiresAt: 1 };
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
      Effect.runSync(Scope.close(scope, Exit.void));
      port1.close();
    }
  });
});
