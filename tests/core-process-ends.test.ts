import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * Each link between main and the core has two ends, one per process, and a
 * protocol module they share that holds no state. No module switches what it
 * does by which process loaded it, and no end falls back to a default: each
 * core boot (the app's core entry and the windowless core) chooses its own.
 */
const read = (path: string): string => readFileSync(path, "utf8");
const ENTRY = read("src/main/core-process/entry.ts");
const HEADLESS = read("src/main/headless.ts");

/** A module that holds nothing: no `let`, no module-level map or set. */
const holdsNoState = (source: string): boolean =>
  !/^let /mu.test(source) && !/^const \w+ = new (Map|Set|WeakMap)/mu.test(source);

it("pushes: the core publishes, main subscribes, and each core boot chooses the sink", () => {
  expect(ENTRY).toContain("sendPushesTo(served.push)");
  expect(HEADLESS).toContain("sendPushesTo(() => {})");
  expect(read("src/main/core-process/push.ts")).not.toMatch(/subscribe|listeners/u);
  expect(read("src/main/core-process/main-side/core-pushes.ts")).not.toMatch(/\bpublish\b|sendPushesTo/u);
  expect(holdsNoState(read("src/main/core-process/channels.ts"))).toBe(true);
});

it("host operations: main runs the bodies, the core holds the client, the protocol holds nothing", () => {
  expect(ENTRY).toContain("useHostClient(served.host)");
  expect(HEADLESS).toContain("useHostClient(noWindowHost)");
  const protocol = read("src/main/core-process/host-ops.ts");
  expect(holdsNoState(protocol)).toBe(true);
  expect(protocol).not.toMatch(/export const/u);
  expect(read("src/main/core-process/core-host.ts")).not.toMatch(/from "[^"]*host-op-bodies"|\bhostOps\(|runHostOp/u);
  expect(read("src/main/core-process/main-side/host-op-bodies.ts")).not.toMatch(/useHostClient|\bhost\.call/u);
  // The port answers host calls with what its owner hands it, never a registry of its own.
  expect(read("src/main/core-process/port.ts")).not.toMatch(/from "[^"]*host-op-bodies"|runHostOp/u);
});
