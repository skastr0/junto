import { describe, expect, it } from "vitest";
import { earlyDispatchFromArgv } from "../src/cli/early-dispatch";
import { OWNER_COMMAND_REFUSAL } from "../src/cli/core/owner-access";

describe("unified CLI early dispatch", () => {
  it.each(["", "malformed", "seat-generation"])("refuses owner and machine entry before dispatch when the seat variable is present (%j)", (token) => {
    for (const args of [
      ["machine", "install-local", "{}"],
      ["machine", "uninstall-local", "{}"],
      ["machine", "status", "{}"],
      ["link"],
      ["companion-stdio"],
    ]) {
      expect(earlyDispatchFromArgv(["bun", "junto", ...args], { JUNTO_WORK_TOKEN: token }))
        .toEqual({ kind: "owner-refused", message: OWNER_COMMAND_REFUSAL });
    }
    expect(earlyDispatchFromArgv(["bun", "junto", "msg", "list"], { JUNTO_WORK_TOKEN: token }))
      .toEqual({ kind: "cli", args: ["msg", "list"] });
  });

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
