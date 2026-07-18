import * as Command from "@effect/platform/Command";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  daemonHandoff,
  dedicatedStream,
  makeRemoteCommand,
  oneShot,
  parseSshEndpoint,
  parseUnixSocketPath,
  unixForward,
} from "../src/main/vellum/ssh";
import { compileProgram, inspectProgram } from "../src/main/vellum/ssh/program";

const controlDir = "/tmp/vellum-ssh-policy";

const standard = (command: Command.Command): Command.StandardCommand =>
  Command.flatten(command)[0];

describe("SSH policy compiler", () => {
  it("centralizes the hardened shared baseline and POSIX-quotes every remote token", async () => {
    const endpoint = await Effect.runPromise(parseSshEndpoint("remote-a"));
    const remote = await Effect.runPromise(
      makeRemoteCommand("herdr", ["--session", "team one", "it's", "$(touch /tmp/pwn)"]),
    );
    const compiled = standard(compileProgram(inspectProgram(oneShot(endpoint, remote)), controlDir));
    const args = compiled.args;
    const remoteText = args.at(-1);

    expect(compiled.command).toBe("ssh");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectionAttempts=1");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("RequestTTY=no");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("ForwardX11=no");
    expect(args).toContain("PermitLocalCommand=no");
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain(`ControlPath=${controlDir}/cm-%C`);
    expect(args).toContain("ControlPersist=600");
    expect(args).not.toContain("team one");
    expect(remoteText).toContain("'team one'");
    expect(remoteText).toContain(`'it'"'"'s'`);
    expect(remoteText).toContain("'$(touch /tmp/pwn)'");
  });

  it("makes dedicated streams explicitly opt out of multiplexing", async () => {
    const endpoint = await Effect.runPromise(parseSshEndpoint("remote-a"));
    const remote = await Effect.runPromise(makeRemoteCommand("hermes", ["acp"]));
    const compiled = standard(
      compileProgram(inspectProgram(dedicatedStream(endpoint, remote)), controlDir),
    );

    expect(compiled.args).toContain("ControlMaster=no");
    expect(compiled.args).toContain("ControlPath=none");
    expect(compiled.args).not.toContain("ControlMaster=auto");
  });

  it("allows exactly one explicit Unix forward on a dedicated connection", async () => {
    const endpoint = await Effect.runPromise(parseSshEndpoint("remote-a"));
    const local = await Effect.runPromise(parseUnixSocketPath("/tmp/vellum-local.sock"));
    const remote = await Effect.runPromise(parseUnixSocketPath("/Users/ops/.herdr/herdr.sock"));
    const compiled = standard(
      compileProgram(inspectProgram(unixForward(endpoint, local, remote)), controlDir),
    );

    expect(compiled.args).toContain("ClearAllForwardings=yes");
    expect(compiled.args).toContain("ExitOnForwardFailure=yes");
    expect(compiled.args).toContain("ControlMaster=no");
    expect(compiled.args).toContain("-N");
    expect(compiled.args).toContain("-L");
    expect(compiled.args).toContain(`${local}:${remote}`);
    expect(compiled.args.indexOf("ClearAllForwardings=yes"))
      .toBeLessThan(compiled.args.indexOf("-L"));
  });

  it("builds daemon shell syntax only from quoted command tokens", async () => {
    const endpoint = await Effect.runPromise(parseSshEndpoint("remote-a"));
    const remote = await Effect.runPromise(
      makeRemoteCommand("herdr", ["--session", "red; echo bad", "server"]),
    );
    const compiled = standard(
      compileProgram(inspectProgram(daemonHandoff(endpoint, remote)), controlDir),
    );
    const script = compiled.args.at(-1) ?? "";

    expect(script).toContain("nohup 'herdr' '--session' 'red; echo bad' 'server'");
    expect(script).toContain(`printf '%s\\n' "$!"`);
  });
});
