/**
 * A Codex seat runs its model's commands inside Codex's own sandbox, and the
 * default `:workspace` permission profile denies every AF_UNIX connect
 * (measured on 0.166.0 and 0.154.0). Without an allowance the seat's `junto`
 * CLI dies with `connect EPERM` on the work control socket, so the seat has no
 * mail, no feedback and no offboard. This locks the argv that opens exactly
 * that one root, and the probe that keeps an older binary launching as before.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxSocketAllowArgs } from "../src/shared/managed-terminal-launch";
import {
  CLAUDE_TEMPLATE,
  CODEX_TEMPLATE,
} from "../src/shared/managed-terminal-templates";
import { resolveLaunch } from "../src/main/junto/term/local-host";
import {
  resetHostProbedFlagCacheForTests,
  supportedHostProbedFlags,
} from "../src/main/junto/term/templates/harness-install";

const WORK_SOCKET = "/Users/operator/.junto/work/control.sock";
const PROFILE = "junto-1a2b3c4d5e6f7a8b";

const fakeCodex = (sandboxHelp: string): string => {
  const bin = join(mkdtempSync(join(tmpdir(), "junto-codex-sandbox-")), "codex");
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "sandbox" ] && [ "$2" = "--help" ]; then\ncat <<'HELP'\n${sandboxHelp}\nHELP\nexit 0\nfi\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
};

const SANDBOX_HELP = [
  "Run commands within a Codex-provided sandbox",
  "      --allow-unix-socket <ALLOW_UNIX_SOCKETS>",
  "          Allow the sandboxed command to bind/connect AF_UNIX sockets rooted at this path",
].join("\n");

describe("a Codex seat reaches Junto's work socket from its own sandbox", () => {
  afterEach(() => resetHostProbedFlagCacheForTests());

  it("names a profile that extends :workspace and allows only the work socket", () => {
    expect(sandboxSocketAllowArgs(CODEX_TEMPLATE, WORK_SOCKET, PROFILE)).toEqual([
      "-c",
      "features.network_proxy=true",
      "-c",
      `default_permissions=${JSON.stringify(PROFILE)}`,
      "-c",
      `permissions.${PROFILE}.extends=":workspace"`,
      "-c",
      `permissions.${PROFILE}.network.enabled=true`,
      "-c",
      `permissions.${PROFILE}.network.unix_sockets={${JSON.stringify(WORK_SOCKET)}="allow"}`,
    ]);
  });

  it("keeps the socket path in one inline table, so its dots are not a config key path", () => {
    const args = sandboxSocketAllowArgs(CODEX_TEMPLATE, WORK_SOCKET, PROFILE);
    expect(args.at(-1)).toBe(
      `permissions.${PROFILE}.network.unix_sockets={${JSON.stringify(WORK_SOCKET)}="allow"}`,
    );
  });

  it("emits nothing for a harness with no sandbox of its own, or with no socket or name", () => {
    expect(sandboxSocketAllowArgs(CLAUDE_TEMPLATE, WORK_SOCKET, PROFILE)).toEqual([]);
    expect(sandboxSocketAllowArgs(CODEX_TEMPLATE, "  ", PROFILE)).toEqual([]);
    expect(sandboxSocketAllowArgs(CODEX_TEMPLATE, WORK_SOCKET, "  ")).toEqual([]);
  });

  it("probes the sandbox subcommand, so a binary without the capability launches as before", () => {
    const probe = CODEX_TEMPLATE.argvSpec.sandboxSocketAllow!.probeFlag;
    const supported = fakeCodex(SANDBOX_HELP);
    expect(supportedHostProbedFlags(supported, [probe], undefined, ["sandbox"])).toEqual([
      probe,
    ]);

    resetHostProbedFlagCacheForTests();
    const older = fakeCodex("Run commands within a Codex-provided sandbox");
    expect(supportedHostProbedFlags(older, [probe], undefined, ["sandbox"])).toEqual([]);
  });

  it("rides a Codex seat's spawn argv with the socket it was given", () => {
    const bin = fakeCodex(SANDBOX_HELP);
    const previous = process.env.JUNTO_WORK_HOME;
    process.env.JUNTO_WORK_HOME = "/tmp/junto-work-proof";
    try {
      const launch = Result.getOrThrow(
        resolveLaunch({
          kind: "agent",
          harness: "codex",
          agentKey: "local:codex",
          launch: { kind: "harness", argv: [bin, "resume", "abc"], cwd: "/tmp" },
        }),
      );
      const profile = /^default_permissions="(junto-[0-9a-f]{16})"$/u.exec(launch.args[3] ?? "")?.[1];
      expect(profile).toBeDefined();
      expect(launch.args).toEqual([
        "-c",
        "features.network_proxy=true",
        "-c",
        `default_permissions="${profile!}"`,
        "-c",
        `permissions.${profile!}.extends=":workspace"`,
        "-c",
        `permissions.${profile!}.network.enabled=true`,
        "-c",
        `permissions.${profile!}.network.unix_sockets={"/tmp/junto-work-proof/control.sock"="allow"}`,
        "resume",
        "abc",
      ]);
    } finally {
      if (previous === undefined) delete process.env.JUNTO_WORK_HOME;
      else process.env.JUNTO_WORK_HOME = previous;
    }
  });

  it("gives every spawn a profile name no config can predefine", () => {
    const bin = fakeCodex(SANDBOX_HELP);
    const spawn = (): readonly string[] =>
      Result.getOrThrow(
        resolveLaunch({
          kind: "agent",
          harness: "codex",
          agentKey: "local:codex",
          launch: { kind: "harness", argv: [bin], cwd: "/tmp" },
        }),
      ).args;
    const first = spawn();
    const second = spawn();
    const profileOf = (args: readonly string[]): string =>
      /^default_permissions="(junto-[0-9a-f]+)"$/u.exec(args[3] ?? "")?.[1] ?? "";
    expect(profileOf(first)).toMatch(/^junto-[0-9a-f]{16}$/u);
    expect(profileOf(second)).toMatch(/^junto-[0-9a-f]{16}$/u);
    expect(profileOf(first)).not.toBe(profileOf(second));
    // Every key names that same profile: a merge target cannot be shared.
    for (const arg of first.filter((value) => value.startsWith("permissions."))) {
      expect(arg).toContain(`.${profileOf(first)}.`);
    }
  });
});
