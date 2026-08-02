import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  inspectRemoteCommand,
  SshEndpoint,
} from "../src/main/vellum/ssh/domain";
import {
  DARWIN_PACKAGED_STATION_EXECUTABLE,
  DARWIN_PACKAGED_APP_EXECUTABLE,
  RemotePlatformProbeError,
  STATION_PROTOCOL_NEGOTIATION_ARG,
  bindLinuxRemoteUserland,
  remoteCat,
  remoteHermesCli,
  remoteHerdrCli,
  remoteHostProbe,
  remoteProductVersion,
  remoteTestFileExists,
  remoteDarwinPackageExists,
  remoteUname,
  remoteVellumStation,
  remoteVellumStationNegotiation,
  remoteLinuxUserlandVellumStation,
  resolveRemotePackagedPlatform,
} from "../src/main/vellum/ssh/read-commands";
import type { SshTransport } from "../src/main/vellum/ssh/service";

const run = <A, E>(effect: Effect.Effect<A, E>): A => {
  const result = Effect.runSync(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const ENDPOINT = Schema.decodeUnknownSync(SshEndpoint)("remote");

const observedPlatform = (stdout: string) =>
  run(
    resolveRemotePackagedPlatform(
      {
        run: () => Effect.succeed({ stdout, stderr: "" }),
      } as unknown as typeof SshTransport.Service,
      ENDPOINT,
    ),
  );

describe("ssh read-commands product constructors", () => {
  it("fixes executables for named product CLIs", () => {
    expect(inspectRemoteCommand(run(remoteUname()))).toEqual({
      executable: "/usr/bin/uname",
      args: ["-s"],
    });
    expect(
      inspectRemoteCommand(run(remoteHermesCli(["version"]))).executable,
    ).toBe("hermes");
    expect(
      inspectRemoteCommand(run(remoteHerdrCli(["status", "--json"])))
        .executable,
    ).toBe("herdr");
    expect(
      inspectRemoteCommand(run(remoteProductVersion("hermes"))).args,
    ).toEqual(["version"]);
    expect(
      inspectRemoteCommand(run(remoteProductVersion("herdr"))).args,
    ).toEqual(["--version"]);
  });

  it("confines cat/test to clean absolute paths", () => {
    const cat = inspectRemoteCommand(
      run(remoteCat("/run/user/501/vellum-remote/ready-aabbccdd")),
    );
    expect(cat).toEqual({
      executable: "/bin/cat",
      args: ["/run/user/501/vellum-remote/ready-aabbccdd"],
    });
    const test = inspectRemoteCommand(
      run(remoteTestFileExists("/Users/alice/.vellum/term/token")),
    );
    expect(test).toEqual({
      executable: "/bin/test",
      args: ["-f", "/Users/alice/.vellum/term/token"],
    });
    expect(inspectRemoteCommand(run(remoteDarwinPackageExists()))).toEqual({
      executable: "/bin/test",
      args: ["-f", DARWIN_PACKAGED_APP_EXECUTABLE],
    });

    for (const bad of [
      "relative",
      "/tmp/../etc/passwd",
      "/home/a;rm -rf /",
      "/home/a$(id)",
      "/home/a\0b",
    ]) {
      expect(Result.isFailure(Effect.runSync(Effect.result(remoteCat(bad))))).toBe(
        true,
      );
    }
  });

  it("refuses free-form destructive shell via host probe and product CLIs", () => {
    const shRm = Effect.runSync(
      Effect.result(remoteHostProbe(["/bin/sh", "-c", "rm -rf -- /"])),
    );
    expect(Result.isFailure(shRm)).toBe(true);

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

  it("mints Darwin packaged Station wrappers and refuses fixed Linux /opt paths", () => {
    const darwin = observedPlatform("Darwin\n");
    const linux = observedPlatform("Linux\n");

    expect(inspectRemoteCommand(run(remoteVellumStation(darwin)))).toEqual({
      executable: DARWIN_PACKAGED_STATION_EXECUTABLE,
      args: [],
    });
    expect(
      inspectRemoteCommand(run(remoteVellumStationNegotiation(darwin))),
    ).toEqual({
      executable: DARWIN_PACKAGED_STATION_EXECUTABLE,
      args: [STATION_PROTOCOL_NEGOTIATION_ARG],
    });
    expect(
      Result.isFailure(Effect.runSync(Effect.result(remoteVellumStation(linux)))),
    ).toBe(true);
    expect(
      Result.isFailure(
        Effect.runSync(Effect.result(remoteVellumStationNegotiation(linux))),
      ),
    ).toBe(true);
  });

  it("binds Linux helpers to an observed owner home, never a release pointer", () => {
    const userland = run(bindLinuxRemoteUserland(
      observedPlatform("Linux\n"),
      "/home/remote station",
    ));
    expect(inspectRemoteCommand(run(remoteLinuxUserlandVellumStation(userland)))).toEqual({
      executable: "/home/remote station/.local/bin/vellum-station",
      args: [],
    });
    expect(Result.isFailure(Effect.runSync(Effect.result(bindLinuxRemoteUserland(
      observedPlatform("Darwin\n"),
      "/Users/remote",
    ))))).toBe(true);
  });

  it("refuses malformed/unsupported platform evidence and forged witnesses without a PATH fallback", () => {
    for (const output of [
      "Darwin",
      "Darwin\nextra\n",
      " darwin\n",
      "FreeBSD\n",
      "",
    ]) {
      const result = Effect.runSync(
        Effect.result(
          resolveRemotePackagedPlatform(
            {
              run: () => Effect.succeed({ stdout: output, stderr: "" }),
            } as unknown as typeof SshTransport.Service,
            ENDPOINT,
          ),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(RemotePlatformProbeError);
      }
    }

    expect(
      Result.isFailure(
        Effect.runSync(
          Effect.result(remoteVellumStation({} as never)),
        ),
      ),
    ).toBe(true);
  });
});
