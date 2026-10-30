import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { MENTION_IPC_CHANNELS } from "../src/shared/mention-ipc-channels";
import { CORE_PUSHES, CORE_PUSH_CHANNELS } from "../src/main/core-process/channels";
import { relayWindowPushes } from "../src/main/core-process/main-side/window-pushes";
import { subscribe } from "../src/main/core-process/push";
import { portCore, type CorePort } from "../src/main/core-process/port";
import { serveCore } from "../src/main/core-process/serve";
import { MessageChannel } from "node:worker_threads";

/**
 * Every push on the core bus is registered in `CORE_PUSHES`, and main relays
 * exactly the registry. A publish on a channel that is not there does not
 * compile; this window checks the registry itself, then carries each channel
 * across a real port to show main hears it.
 */
const CHANNELS = "src/main/core-process/channels.ts";

const channelValue = (token: string, declared: ReadonlyMap<string, string>): string | undefined => {
  const qualified = /^(IPC_CHANNELS|MENTION_IPC_CHANNELS|RESOURCE_IPC_CHANNELS)\.(\w+)$/u.exec(token);
  if (qualified !== null) {
    const table = qualified[1] === "IPC_CHANNELS"
      ? IPC_CHANNELS
      : qualified[1] === "MENTION_IPC_CHANNELS" ? MENTION_IPC_CHANNELS : undefined;
    if (table === undefined) return undefined;
    return (table as Record<string, string>)[qualified[2]!];
  }
  const quoted = /^"([^"]*)"$/u.exec(token);
  if (quoted !== null) return quoted[1];
  const bare = /^([A-Z][A-Z0-9_]*)$/u.exec(token);
  return bare === null ? undefined : declared.get(bare[1]!);
};

/** Every source that publishes on the core bus: the ops, and any other core file. */
const publishers = (): ReadonlyArray<{ readonly name: string; readonly source: string }> => {
  const found: Array<{ readonly name: string; readonly source: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        const group = path.includes(join("core-process", "ops"));
        if (group || source.includes("core-process/push") || /from "(\\.\\.\/)+push"/u.test(source)) {
          found.push({ name: path, source });
        }
      }
    }
  };
  walk("src/main");
  return found;
};

it("every channel a core publisher names is in the registry", () => {
  const sources = publishers().map((entry) => entry.source);
  const files = publishers().map((entry) => entry.name);
  const declared = new Map<string, string>();
  for (const [, name, value] of readFileSync(CHANNELS, "utf8").matchAll(/export const ([A-Z][A-Z0-9_]*) = "([^"]*)";/gu)) {
    declared.set(name!, value!);
  }
  const registered = new Set<string>(CORE_PUSH_CHANNELS);
  let publishes = 0;
  for (const [index, source] of sources.entries()) {
    for (const match of source.matchAll(/publish(?:Carried)?\(\s*([^,\s)]+)/gu)) {
      const token = match[1]!;
      // A lowercase token is a loop variable over channels the file declares;
      // its names are checked where the list is built, not here.
      if (!/^(IPC_CHANNELS|MENTION_IPC_CHANNELS|RESOURCE_IPC_CHANNELS)\.[\w.]+$|^[A-Z][A-Z0-9_]*$/u.test(token)) continue;
      const value = channelValue(token, declared);
      expect(value, `${files[index]} publishes ${token}, which is not a channel this test can resolve`).toBeTypeOf("string");
      expect(registered.has(value!), `${files[index]} publishes ${token}, which is not in CORE_PUSHES`).toBe(true);
      publishes += 1;
    }
  }
  expect(publishes).toBeGreaterThan(0);
});

it("main relays every registered channel, and a backlink reaches it through the port", async () => {
  const { port1, port2 } = new MessageChannel();
  const portOf = (port: typeof port1): CorePort => ({
    post: (message) => port.postMessage(message),
    listen: (handler) => {
      const on = (message: Parameters<typeof handler>[0]) => handler(message);
      port.on("message", on);
      return () => port.off("message", on);
    },
  });
  const served = serveCore(portOf(port2), { runPromiseExit: () => Promise.reject(new Error("no call in this test")) });
  const client = portCore(portOf(port1));
  const relayed = new Set<string>();
  const heard = new Map<string, unknown>();
  const stop = relayWindowPushes({
    onPush: (channel, listener) => {
      relayed.add(channel);
      return client.onPush(channel, listener);
    },
  });
  const offs = CORE_PUSH_CHANNELS.map((channel) => subscribe(channel, (payload) => heard.set(channel, payload)));
  try {
    // The relay listens for the registry itself, so a new push cannot be missing here.
    expect([...relayed].sort()).toEqual([...CORE_PUSH_CHANNELS].sort());
    const backlink = { canvasName: "factory" };
    served.push(MENTION_IPC_CHANNELS.changed, backlink);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard.get(MENTION_IPC_CHANNELS.changed)).toEqual(backlink);
  } finally {
    stop();
    for (const off of offs) off();
    served.close();
    client.fail("done");
    port1.close();
    port2.close();
  }
});
