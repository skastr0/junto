import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { inspectRemoteCommand } from "../src/main/vellum/ssh/domain";
import {
  remoteCat,
  remoteHermesCli,
  remoteHerdrCli,
  remoteHostProbe,
  remoteLs,
  remoteProductVersion,
  remoteTestFileExists,
  remoteUname,
  remoteVellumBrowserStation,
  remoteVellumStation,
} from "../src/main/vellum/ssh/read-commands";

const run = <A, E>(effect: Effect.Effect<A, E>): A => {
  const result = Effect.runSync(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

describe("ssh read-commands product constructors", () => {
  it("fixes executables for named product CLIs", () => {
    expect(inspectRemoteCommand(run(remoteUname()))).toEqual({
      executable: "uname",
      args: ["-s"],
    });
    expect(inspectRemoteCommand(run(remoteHermesCli(["version"]))).executable).toBe(
      "hermes",
    );
    expect(inspectRemoteCommand(run(remoteHerdrCli(["status", "--json"]))).executable).toBe(
      "herdr",
    );
    expect(inspectRemoteCommand(run(remoteProductVersion("hermes"))).args).toEqual([
      "version",
    ]);
    expect(inspectRemoteCommand(run(remoteProductVersion("herdr"))).args).toEqual([
      "--version",
    ]);
  });

  it("confines cat/ls/test to clean absolute paths", () => {
    const cat = inspectRemoteCommand(run(remoteCat("/home/station/.vellum/settings.json")));
    expect(cat).toEqual({
      executable: "/bin/cat",
      args: ["/home/station/.vellum/settings.json"],
    });
    const ls = inspectRemoteCommand(run(remoteLs("/home/station/.vellum/canvases")));
    expect(ls.executable).toBe("ls");
    expect(ls.args).toEqual(["-1", "/home/station/.vellum/canvases"]);
    const test = inspectRemoteCommand(
      run(remoteTestFileExists("/Users/alice/.vellum/term/token")),
    );
    expect(test).toEqual({
      executable: "/bin/test",
      args: ["-f", "/Users/alice/.vellum/term/token"],
    });

    for (const bad of [
      "relative",
      "/tmp/../etc/passwd",
      "/home/a;rm -rf /",
      "/home/a$(id)",
      "/home/a\0b",
    ]) {
      expect(Either.isLeft(Effect.runSync(Effect.either(remoteCat(bad))))).toBe(true);
      expect(Either.isLeft(Effect.runSync(Effect.either(remoteLs(bad))))).toBe(true);
    }
  });

  it("refuses free-form destructive shell via host probe and product CLIs", () => {
    const shRm = Effect.runSync(
      Effect.either(remoteHostProbe(["/bin/sh", "-c", "rm -rf -- /"])),
    );
    expect(Either.isLeft(shRm)).toBe(true);

    // Probe admits [lsof,-nP,-iTCP,-sTCP:LISTEN,-a,<pidList>]; factory inserts -p.
    const lsof = inspectRemoteCommand(
      run(
        remoteHostProbe([
          "lsof",
          "-nP",
          "-iTCP",
          "-sTCP:LISTEN",
          "-a",
          "12,34",
        ]),
      ),
    );
    expect(lsof.executable).toBe("lsof");
    expect(lsof.args).toEqual([
      "-nP",
      "-iTCP",
      "-sTCP:LISTEN",
      "-a",
      "-p",
      "12,34",
    ]);

    const ts = inspectRemoteCommand(
      run(remoteHostProbe(["tailscale", "serve", "status", "--json"])),
    );
    expect(ts.executable).toBe("tailscale");
  });

  it("mints only the fixed station-browser delegation wrapper", () => {
    expect(inspectRemoteCommand(run(remoteVellumBrowserStation()))).toEqual({
      executable: "vellum-browser",
      args: ["station"],
    });
  });

  it("mints the Station API wrapper without a path or arguments", () => {
    expect(inspectRemoteCommand(run(remoteVellumStation()))).toEqual({
      executable: "vellum-station",
      args: [],
    });
  });
});
