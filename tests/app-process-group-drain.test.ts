import { describe, expect, it } from "vitest";
import {
  APP_PROCESS_TERM_GRACE_MS,
  createAppProcessPlane,
} from "../src/main/junto/app-process-plane";

// No mocks: a real group that dies on the drain's TERM. Its record retires on
// close plus a verified-empty group, which no event announces; the drain must
// look for it, not sit out the whole TERM grace.
describe("a quit drain retires a group as soon as it is gone", () => {
  it("costs well under the TERM grace when the group dies on TERM", async () => {
    const plane = createAppProcessPlane();
    const lease = plane.spawnGroup({
      source: "test.source",
      purpose: "dies on TERM",
      command: "/bin/sh",
      args: ["-c", "exec sleep 30"],
    });
    lease.io.stdin.end();
    // Let the spawn-time member observation finish before the drain cuts in.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const started = performance.now();
    await expect(plane.drainOnQuit()).resolves.toEqual({ clean: true, stragglers: [] });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(APP_PROCESS_TERM_GRACE_MS / 2);
  });

  it("drains several groups together in about the time of one", async () => {
    const plane = createAppProcessPlane();
    const leases = Array.from({ length: 4 }, (_, index) =>
      plane.spawnGroup({
        source: "test.source",
        purpose: `dies on TERM ${index}`,
        command: "/bin/sh",
        args: ["-c", "exec sleep 30"],
      }));
    for (const lease of leases) lease.io.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const started = performance.now();
    await expect(plane.drainOnQuit()).resolves.toEqual({ clean: true, stragglers: [] });
    expect(performance.now() - started).toBeLessThan(APP_PROCESS_TERM_GRACE_MS / 2);
  });
});
