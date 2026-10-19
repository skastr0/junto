import { describe, expect, it } from "vitest";
import {
  appProcessBlocksAppExit,
  createAppProcessPlane,
} from "../src/main/junto/app-process-plane";

// No mocks: the real process table and a real child, the case that left an
// update install unable to quit when a fast command beat the first table read.
describe("app process plane with a real fast-exiting command", () => {
  it("drains clean after a group command exited before its members were read", async () => {
    const plane = createAppProcessPlane({ termGraceMs: 500, killGraceMs: 500 });
    const lease = plane.spawnGroup({
      source: "adapter.cli",
      purpose: "fast command",
      command: "/usr/bin/true",
      args: [],
    });
    lease.io.stdin.end();
    await lease.io.closed;
    await expect(plane.drainOnQuit()).resolves.toEqual({ clean: true, stragglers: [] });
  });
});

describe("appProcessBlocksAppExit", () => {
  it("lets a read-only adapter command with no leader left stand", () => {
    expect(appProcessBlocksAppExit([
      { source: "adapter.cli", state: "ownership-unverified" },
      { source: "adapter.cli", state: "leaderless-group" },
    ])).toBe(false);
  });

  it("blocks on a running adapter command and on any other source", () => {
    expect(appProcessBlocksAppExit([{ source: "adapter.cli", state: "running" }])).toBe(true);
    expect(appProcessBlocksAppExit([{ source: "term.host", state: "ownership-unverified" }])).toBe(true);
  });
});
