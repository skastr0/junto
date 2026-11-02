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

const WORK_HOME = "/Users/operator/.junto/work";

const fakeCodex = (sandboxHelp: string): string => {
  const bin = join(mkdtempSync(join(tmpdir(), "junto-codex-sandbox-")), "codex");
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "sandbox" ] && [ "$2" = "--help" ]; then\ncat <<'HELP'\n${sandboxHelp}\nHELP\nexit 0\nfi\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
};

describe("a Codex seat reaches Junto's work socket from its own sandbox", () => {
  afterEach(() => resetHostProbedFlagCacheForTests());

  it("names a profile that extends :workspace and allows only the work home", () => {
    expect(sandboxSocketAllowArgs(CODEX_TEMPLATE, WORK_HOME)).toEqual([
      "-c",
      "features.network_proxy=true",
      "-c",
      'default_permissions="junto"',
      "-c",
      'permissions.junto.extends=":workspace"',
      "-c",
      "permissions.junto.network.enabled=true",
      "-c",
      `permissions.junto.network.unix_sockets={${JSON.stringify(WORK_HOME)}="allow"}`,
    ]);
  });

  it("keeps the socket root in one inline table, so its dots are not a config key path", () => {
    const args = sandboxSocketAllowArgs(CODEX_TEMPLATE, WORK_HOME);
    expect(args.at(-1)).toBe(
      `permissions.junto.network.unix_sockets={${JSON.stringify(WORK_HOME)}="allow"}`,
    );
  });

  it("emits nothing for a harness with no sandbox of its own, or with no work home", () => {
    expect(sandboxSocketAllowArgs(CLAUDE_TEMPLATE, WORK_HOME)).toEqual([]);
    expect(sandboxSocketAllowArgs(CODEX_TEMPLATE, "  ")).toEqual([]);
  });

  it("probes the sandbox subcommand, so a binary without the capability launches as before", () => {
    const probe = CODEX_TEMPLATE.argvSpec.sandboxSocketAllow!.probeFlag;
    const supported = fakeCodex(
      [
        "Run commands within a Codex-provided sandbox",
        "      --allow-unix-socket <ALLOW_UNIX_SOCKETS>",
        "          Allow the sandboxed command to bind/connect AF_UNIX sockets rooted at this path",
      ].join("\n"),
    );
    expect(supportedHostProbedFlags(supported, [probe], undefined, ["sandbox"])).toEqual([
      probe,
    ]);

    resetHostProbedFlagCacheForTests();
    const older = fakeCodex("Run commands within a Codex-provided sandbox");
    expect(supportedHostProbedFlags(older, [probe], undefined, ["sandbox"])).toEqual([]);
  });

  it("rides a Codex seat's spawn argv with the work home it was given", () => {
    const bin = fakeCodex(
      [
        "Run commands within a Codex-provided sandbox",
        "      --allow-unix-socket <ALLOW_UNIX_SOCKETS>",
      ].join("\n"),
    );
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
      expect(launch.args).toEqual([
        "-c",
        "features.network_proxy=true",
        "-c",
        'default_permissions="junto"',
        "-c",
        'permissions.junto.extends=":workspace"',
        "-c",
        "permissions.junto.network.enabled=true",
        "-c",
        'permissions.junto.network.unix_sockets={"/tmp/junto-work-proof"="allow"}',
        "resume",
        "abc",
      ]);
    } finally {
      if (previous === undefined) delete process.env.JUNTO_WORK_HOME;
      else process.env.JUNTO_WORK_HOME = previous;
    }
  });
});
