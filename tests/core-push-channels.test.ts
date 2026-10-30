import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { WINDOW_CHANNELS } from "../src/main/core-process/main-side/window-pushes";

/**
 * A core operation that publishes on a channel main does not relay is a push
 * the window never sees once the core runs in its own process. Every
 * `publish(...)` in an ops group must therefore name a channel in
 * WINDOW_CHANNELS: the port relays exactly those (relayWindowPushes).
 */
const OPS = "src/main/core-process/ops";
/** Where the channel names live now: a publisher names one, it does not define it. */
const CHANNELS = "src/main/core-process/channels.ts";

const channelValue = (token: string, declared: ReadonlyMap<string, string>): string | undefined => {
  const ipc = /^IPC_CHANNELS\.(\w+)$/u.exec(token);
  if (ipc !== null) return (IPC_CHANNELS as Record<string, string>)[ipc[1]!];
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
        // Every ops group publishes through "../push", which the old filter
        // missed; each group is scanned, and any other file that imports the bus.
        const group = path.includes(join("core-process", "ops"));
        if (group || source.includes("core-process/push") || /from "(\.\.\/)+push"/u.test(source)) {
          found.push({ name: path, source });
        }
      }
    }
  };
  walk("src/main");
  return found;
};

it("every channel a core publisher publishes is a window channel", () => {
  const sources = publishers().map((entry) => entry.source);
  const files = publishers().map((entry) => entry.name);
  // Channel constants a group or this suite declares, by name.
  const declared = new Map<string, string>();
  for (const source of [...sources, readFileSync(CHANNELS, "utf8")]) {
    for (const [, name, value] of source.matchAll(/export const ([A-Z][A-Z0-9_]*) = "([^"]*)";/gu)) {
      declared.set(name!, value!);
    }
  }
  const published = new Map<string, string>();
  for (const [index, source] of sources.entries()) {
    for (const match of source.matchAll(/[A-Za-z]*[Pp]ublish\(\s*([^,\s)]+)/gu)) {
      const token = match[1]!;
      // A lowercase token is a loop variable over channels the file declares;
      // its names are checked where the list is built, not here.
      if (!/^(IPC_CHANNELS\.\w+|[A-Z][A-Z0-9_]*)$/u.test(token)) continue;
      const value = channelValue(token, declared);
      expect(value, `${files[index]} publishes ${token}, which is not a channel this test can resolve`).toBeTypeOf("string");
      published.set(token, value!);
    }
  }
  expect(published.size).toBeGreaterThan(0);
  for (const [token, value] of published) {
    expect(WINDOW_CHANNELS as ReadonlyArray<string>, `${token} (${value}) must be in WINDOW_CHANNELS`).toContain(value);
  }
});
