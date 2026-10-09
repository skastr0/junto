import { describe, expect, it } from "vitest";
import { earlyDispatchFromArgv } from "../src/cli/early-dispatch";

describe("unified CLI early dispatch", () => {
  it("routes browser / content-transfer before Effect CLI", () => {
    expect(earlyDispatchFromArgv(["bun", "junto", "browser", "doctor"])).toEqual({
      kind: "browser",
      args: ["doctor"],
    });
    expect(
      earlyDispatchFromArgv([
        "bun",
        "junto",
        "content-transfer",
        "stat",
        "a".repeat(64),
        "12",
      ]),
    ).toEqual({
      kind: "content-transfer",
      args: ["stat", "a".repeat(64), "12"],
    });
    expect(earlyDispatchFromArgv(["bun", "junto", "station", "status"])).toEqual({
      kind: "cli",
      args: ["station", "status"],
    });
    expect(earlyDispatchFromArgv(["bun", "junto", "content", "path", "{}"])).toEqual({
      kind: "cli",
      args: ["content", "path", "{}"],
    });
  });
});
