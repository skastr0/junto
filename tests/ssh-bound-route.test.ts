/**
 * A link route bound to its own key reads no SSH config: no Host block can
 * add a key, a jump or a command, and the agent is never asked
 * (docs/machines.md, The link). `ssh -G` resolves a route once, at setup.
 */
import * as Command from "effect/unstable/process/ChildProcess";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { parseSshRoute } from "../src/main/junto/ssh";
import { makeRemoteCommand } from "../src/main/junto/ssh/domain";
import { createSshProgramCompiler, dedicatedStream, resolveSshConfig } from "../src/main/junto/ssh/program";

const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-ssh-bound-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
const argv = (command: Command.Command): ReadonlyArray<string> => {
  if (!Command.isStandardCommand(command)) throw new TypeError("expected StandardCommand");
  return command.args.slice(command.args.indexOf("/usr/bin/ssh") + 1);
};
const bound = {
  endpoint: "ops@100.96.152.41", port: 22, bound: true as const,
  identityFile: "/home/ops/.junto/core/link-keys/vps/id_ed25519",
  knownHostsFile: "/home/ops/.junto/core/link-keys/vps/known_hosts",
};

describe("a key-bound route", () => {
  it("dials with no config file, no agent, its own key and its own known hosts, strictly", async () => {
    const target = await Effect.runPromise(parseSshRoute(bound));
    const args = argv(compiler.stream(dedicatedStream(target, await Effect.runPromise(makeRemoteCommand("/usr/bin/true")))).command);
    expect(args.slice(args.indexOf("-F"), args.indexOf("-F") + 2)).toEqual(["-F", "none"]);
    expect(args).toContain("IdentityAgent=none");
    expect(args).toContain(`IdentityFile=${bound.identityFile}`);
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain(`UserKnownHostsFile=${bound.knownHostsFile}`);
    expect(args).toContain("GlobalKnownHostsFile=/dev/null");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("UpdateHostKeys=no");
    expect(args).not.toContain("StrictHostKeyChecking=accept-new");
    expect(args.indexOf("-F")).toBeLessThan(args.indexOf("ops@100.96.152.41"));
  });

  it.each([
    ["no key of its own", { ...bound, identityFile: undefined }],
    ["no known hosts of its own", { ...bound, knownHostsFile: undefined }],
    ["an alias for an endpoint", { ...bound, endpoint: "mac-mini" }],
    ["a host-key alias", { ...bound, hostKeyAlias: "other" }],
  ])("is refused with %s", async (_what, input) => {
    const route = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    await expect(Effect.runPromise(parseSshRoute(route as typeof bound))).rejects.toMatchObject({ _tag: "SshInputError" });
  });

  it("is never what an operator route compiles to", async () => {
    const target = await Effect.runPromise(parseSshRoute({ endpoint: "mac-mini" }));
    const args = argv(compiler.stream(dedicatedStream(target, await Effect.runPromise(makeRemoteCommand("/usr/bin/true")))).command);
    expect(args).not.toContain("-F");
    expect(args).not.toContain("IdentityAgent=none");
  });
});

describe("resolving a route", () => {
  it("asks ssh -G for the route as this account would dial it, and runs nothing remote", async () => {
    const target = await Effect.runPromise(parseSshRoute({ endpoint: "mac-mini" }));
    const args = argv(compiler.oneShot(resolveSshConfig(target)).command);
    expect(args[0]).toBe("-G");
    expect(args.at(-1)).toBe("mac-mini");
    expect(args).not.toContain("ControlMaster=auto");
  });
});
