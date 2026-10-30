import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import type { CoreRunner } from "./support/in-process-core";
import { portCore, serveCore, type CorePort } from "../src/main/core-process/port";
import { subscribe } from "../src/main/core-process/push";
import { AGENT_SIGNAL_CHANGED, WORK_PREAMBLE } from "../src/main/core-process/channels";
import { SettingsService } from "../src/main/junto/settings/service";

vi.mock("electron", () => ({ utilityProcess: { fork: () => { throw new Error("no utilityProcess in tests"); } } }));
vi.mock("../src/main/core-process/entry?modulePath", () => ({ default: "/core-entry.js" }));
vi.mock("../src/main/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { startCoreProcessForMain } = await import("../src/main/core-process/main-boot");
const { core } = await import("../src/main/core-process/main-client");

const portOf = (port: MessagePort): CorePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: Parameters<typeof handler>[0]) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const BOOT = {
  home: "/home", build: "test", bundlesRoot: "/bundles", operatorCommands: false,
  app: { version: "0.0.0", packaged: false, resourcesPath: "/r", appPath: "/a" },
};

it("hooks main up to a core in its own process: calls go to it, its pushes reach main, its asks are answered", async () => {
  const settings = { machine: { supervisedPreferred: false } };
  const runtime = ManagedRuntime.make(Layer.succeed(SettingsService, { get: Effect.succeed(settings), subscribe: () => () => undefined } as never));
  const { port1, port2 } = new MessageChannel();
  const served = serveCore(portOf(port2), runtime as unknown as CoreRunner);
  let stopped = 0;
  let clip = "";
  const main = startCoreProcessForMain({
    boot: BOOT,
    pages: () => undefined,
    captureApplicationPage: async () => ({ ok: true, png: new Uint8Array([7]) }),
    clipboard: { readText: () => clip, writeText: (text) => { clip = text; }, clear: () => { clip = ""; } },
    start: () => ({ ...portCore(portOf(port1)), stop: () => { stopped += 1; } }),
  });
  const seen: Array<[string, unknown]> = [];
  const offs = [WORK_PREAMBLE, AGENT_SIGNAL_CHANGED].map((channel) => subscribe(channel, (payload) => seen.push([channel, payload])));
  try {
    // Main's call sites reach the core process through the one client.
    expect(await core.call("settings.read", {})).toEqual(settings);
    // The core's window pushes land on main's bus.
    served.push(WORK_PREAMBLE, { preambleId: "p1" });
    served.push(AGENT_SIGNAL_CHANGED, { signalId: "s1" });
    // What the core asks of Electron is answered by main.
    expect(await served.host.call("window.capturePage", {})).toEqual({ ok: true, png: new Uint8Array([7]) });
    expect(await served.host.call("overseer.pages.state", { owner: "o", sessionId: "s" })).toMatchObject({ ok: false, code: "failed" });
    // The phone companion's Copy link writes main's clipboard, and clears it only while it holds that link.
    await served.host.call("clipboard.write", { text: "link-1" });
    await served.host.call("clipboard.clearIf", { text: "link-0" });
    expect(clip).toBe("link-1");
    await served.host.call("clipboard.clearIf", { text: "link-1" });
    expect(clip).toBe("");
    expect(seen).toEqual([[WORK_PREAMBLE, { preambleId: "p1" }], [AGENT_SIGNAL_CHANGED, { signalId: "s1" }]]);
    main.stop();
    expect(stopped).toBe(1);
    // Stopped, main no longer answers for the core.
    await expect(served.host.call("window.capturePage", {})).rejects.toMatchObject({ tag: "UnknownHostOp" });
  } finally {
    for (const off of offs) off();
    port1.close();
    await runtime.dispose();
  }
});
