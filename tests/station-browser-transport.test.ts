import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  dispatchStationBrowser,
} from "../src/main/vellum/browser/station-transport";
import { admitOperatorUiDelegation, mintStationBrowserEnvelope } from "../src/main/vellum/browser/station-delegation";
import { createSshProgramCompiler } from "../src/main/vellum/ssh/program";
import {
  DARWIN_PACKAGED_BROWSER_EXECUTABLE,
} from "../src/main/vellum/ssh/read-commands";
import type { SshTransport } from "../src/main/vellum/ssh/service";
import { InstallationId } from "../src/shared/station-api";

const keys = generateKeyPairSync("ed25519");
const commandInstallationId =
  Schema.decodeUnknownSync(InstallationId)("command-a");
const hosts = [{ id: "remote-a", label: "Remote A", kind: "remote" as const, endpoint: "remote-a", capabilities: ["browser"] as const }];
const envelope = () => mintStationBrowserEnvelope(admitOperatorUiDelegation(commandInstallationId), {
  version: 1, requestId: "request-1", targetStationId: "remote-a", action: "doctor", issuedAt: 1_700_000_000_000, expiresAt: 1_700_000_030_000, nonce: "nonce-1",
}, "fleet-1", keys.privateKey);
const reply = JSON.stringify({ version: 1, requestId: "request-1", action: "doctor", ok: true, hostId: "remote-a", data: { role: "remote", browserReady: true }, error: null });

const fakeSsh = (
  stdout = reply,
  platform = "Darwin\n",
): { readonly ssh: typeof SshTransport.Service; readonly programs: unknown[] } => {
  const programs: unknown[] = [];
  return {
    programs,
    ssh: {
      run: (program: unknown) => {
        programs.push(program);
        return Effect.succeed({
          stdout: programs.length === 1 ? platform : stdout,
          stderr: "",
        });
      },
    } as unknown as typeof SshTransport.Service,
  };
};

describe("station browser restricted SSH transport", () => {
  it("derives the remote endpoint from the signed target and invokes only the fixed wrapper with bounded stdin", async () => {
    const { ssh, programs } = fakeSsh();
    await expect(Effect.runPromise(dispatchStationBrowser(ssh, hosts, envelope()))).resolves.toMatchObject({ ok: true, hostId: "remote-a" });
    expect(programs).toHaveLength(2);
    const compiler = createSshProgramCompiler({
      controlDir: "/tmp/vellum-ssh",
      envExecutable: "/usr/bin/env",
      sshExecutable: "/usr/bin/ssh",
      environment: { PATH: "/tmp/attacker" },
    });
    const probe = compiler.oneShot(programs[0] as never);
    const compiled = compiler.oneShot(programs[1] as never);
    expect(String(probe.command)).toContain("/usr/bin/uname");
    expect(probe.input).toBeUndefined();
    expect(String(compiled.command)).toContain("BatchMode=yes");
    expect(String(compiled.command)).toContain("ClearAllForwardings=yes");
    expect(String(compiled.command)).toContain(
      DARWIN_PACKAGED_BROWSER_EXECUTABLE,
    );
    expect(String(compiled.command)).not.toMatch(
      /(?:^|[ '"])vellum-browser(?:[ '"]|$)/u,
    );
    expect(new TextDecoder().decode(compiled.input)).toContain('"targetStationId":"remote-a"');
  });

  it("rejects unavailable or non-browser targets before any SSH operation", async () => {
    const unavailable = fakeSsh();
    await expect(Effect.runPromise(dispatchStationBrowser(unavailable.ssh, [], envelope()))).rejects.toThrow("browser target is not an available remote station");
    expect(unavailable.programs).toEqual([]);
    const unsupported = fakeSsh();
    await expect(Effect.runPromise(dispatchStationBrowser(unsupported.ssh, [{ ...hosts[0], capabilities: ["hermes"] }], envelope()))).rejects.toThrow("browser target does not advertise browser capability");
    expect(unsupported.programs).toEqual([]);
  });

  it("fails closed on malformed, wrong-host, wrong-action, and wrong-request replies", async () => {
    for (const stdout of ["not-json", reply.replace("remote-a", "other"), reply.replace("doctor", "list"), reply.replace("request-1", "other")]) {
      const { ssh } = fakeSsh(stdout);
      await expect(Effect.runPromise(dispatchStationBrowser(ssh, hosts, envelope()))).rejects.toThrow("remote browser station returned an invalid response");
    }
  });

  it("never sends a signed delegation when platform evidence is unsupported", async () => {
    const { ssh, programs } = fakeSsh(reply, "FreeBSD\n");

    await expect(
      Effect.runPromise(dispatchStationBrowser(ssh, hosts, envelope())),
    ).rejects.toThrow(
      "remote platform does not have a Vellum packaged executable",
    );

    expect(programs).toHaveLength(1);
    const probe = createSshProgramCompiler({
      controlDir: "/tmp/vellum-ssh",
      envExecutable: "/usr/bin/env",
      sshExecutable: "/usr/bin/ssh",
      environment: { PATH: "/tmp/attacker" },
    }).oneShot(programs[0] as never);
    expect(probe.input).toBeUndefined();
  });
});
