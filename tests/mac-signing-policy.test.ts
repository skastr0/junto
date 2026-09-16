import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compiledMacSigningPolicy,
  parseMacSigningPolicy,
} from "../src/main/vellum-command/mac-signing-policy";
import {
  buildRemoteDeployScript,
  validateLocalBundleProvenance,
} from "../src/main/vellum-command/hosts/deploy-darwin";
import { admitStagedMacApp } from "../src/main/vellum-command/update/admit-mac-app";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const team = "EXAMP12345";
const authority = `Developer ID Application: Example Maintainer (${team})`;

afterEach(() => vi.unstubAllGlobals());

describe("compiled macOS release trust", () => {
  it("pins the supplied team in the Apple Developer ID requirement", () => {
    const policy = parseMacSigningPolicy(team, authority);
    expect(policy.teamIdentifier).toBe(team);
    expect(policy.signingAuthority).toBe(authority);
    expect(policy.developerIdRequirement).toContain('anchor apple generic');
    expect(policy.developerIdRequirement).toContain('identifier "skastr0.vellumcommand"');
    expect(policy.developerIdRequirement).toContain(`certificate leaf[subject.OU] = "${team}"`);
  });

  it.each([
    [undefined, undefined],
    [team, undefined],
    [undefined, authority],
    ["OTHER12345", authority],
    [team, "ad-hoc"],
    ["unsafe\"", authority],
    [team, `Developer ID Application: injected\nname (${team})`],
  ])("refuses absent or mismatched configuration", (candidateTeam, candidateAuthority) => {
    expect(() => parseMacSigningPolicy(candidateTeam, candidateAuthority)).toThrow(/release trust is not configured/);
  });

  it("refuses public-build package admission before reading an artifact or running commands", async () => {
    vi.stubGlobal("__JUNTO_MAC_TEAM_ID__", undefined);
    vi.stubGlobal("__JUNTO_MAC_SIGNING_IDENTITY__", undefined);
    expect(() => compiledMacSigningPolicy()).toThrow(/release trust is not configured/);
    expect(() => validateLocalBundleProvenance({
      appPath: "/missing/Junto.app",
      executablePath: "/missing/Junto.app/Contents/MacOS/Junto",
      bundleIdentifier: "skastr0.vellumcommand",
      bundleExecutable: "Junto",
      bundleVersion: "0.2.0",
      codesignMetadata: `TeamIdentifier=${team}\nAuthority=${authority}`,
    })).toThrow(/release trust is not configured/);
    expect(() => buildRemoteDeployScript("/Users/operator", "a".repeat(40), {
      kind: "app-tar",
      expectedPackageState: "absent",
    })).toThrow(/release trust is not configured/);
    const runCommand = vi.fn();
    await expect(admitStagedMacApp("/missing/Junto.app", { runCommand }))
      .rejects.toThrow(/release trust is not configured/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("binds the signed bundle version to the advertised release", async () => {
    vi.stubGlobal("__JUNTO_MAC_TEAM_ID__", team);
    vi.stubGlobal("__JUNTO_MAC_SIGNING_IDENTITY__", authority);
    const root = await mkdtemp(join(tmpdir(), "vellum-command-mac-admit-"));
    try {
      const appPath = join(root, "Junto.app");
      const executable = join(appPath, "Contents", "MacOS", "Junto");
      await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(executable, "synthetic signed executable");
      await chmod(executable, 0o700);
      await writeFile(join(appPath, "Contents", "Info.plist"), "synthetic signed plist");
      const runCommand = vi.fn(async (_command: string, args: readonly string[]) => ({
        code: 0, stderr: "", stdout: args.includes("CFBundleIdentifier") ? "skastr0.vellumcommand" :
          args.includes("CFBundleExecutable") ? "Junto" : args.includes("CFBundleShortVersionString") ? "0.2.0" : "",
      }));
      await expect(admitStagedMacApp(appPath, { runCommand, expectedVersion: "0.2.1" })).rejects.toThrow(/version does not match/);
      await expect(admitStagedMacApp(appPath, { runCommand, expectedVersion: "0.2.0" })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
