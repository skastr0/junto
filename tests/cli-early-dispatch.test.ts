import { describe, expect, it } from "vitest";
import { earlyDispatchFromArgv } from "../src/cli/early-dispatch";

describe("unified CLI early dispatch", () => {
  it("routes browser / station-stdio / content-transfer before Effect CLI", () => {
    expect(earlyDispatchFromArgv(["bun", "vellum-command", "browser", "doctor"])).toEqual({
      kind: "browser",
      args: ["doctor"],
    });
    expect(earlyDispatchFromArgv(["bun", "vellum-command", "station-stdio"])).toEqual({
      kind: "station-stdio",
      args: [],
    });
    expect(
      earlyDispatchFromArgv(["bun", "vellum-command", "station", "stdio", "--protocol-preface"]),
    ).toEqual({
      kind: "station-stdio",
      args: ["--protocol-preface"],
    });
    expect(
      earlyDispatchFromArgv([
        "bun",
        "vellum-command",
        "content-transfer",
        "stat",
        "a".repeat(64),
        "12",
      ]),
    ).toEqual({
      kind: "content-transfer",
      args: ["stat", "a".repeat(64), "12"],
    });
    expect(earlyDispatchFromArgv(["bun", "vellum-command", "station", "status"])).toEqual({
      kind: "cli",
      args: ["station", "status"],
    });
    expect(earlyDispatchFromArgv(["bun", "vellum-command", "content", "path", "{}"])).toEqual({
      kind: "cli",
      args: ["content", "path", "{}"],
    });
  });
});
