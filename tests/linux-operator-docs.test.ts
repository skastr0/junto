import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readDoc = async (name: string): Promise<string> =>
  readFile(new URL(`../docs/${name}`, import.meta.url), "utf8");

const shellBlocks = (input: string): string =>
  [...input.matchAll(/```sh\n([\s\S]*?)```/gu)]
    .map((match) => match[1])
    .join("\n");

describe("Linux v1 operator documentation", () => {
  it("covers the complete install and recovery lifecycle", async () => {
    const runbook = await readDoc("linux-operator-runbook.md");
    for (const heading of [
      "## Before any package mutation",
      "## Preserve station state",
      "## Fresh install",
      "## Remote station and Xvfb",
      "## Readiness and Doctor",
      "## Logs and bounded diagnostics",
      "## Upgrade",
      "## Rollback",
      "## Browser profile lifecycle",
      "## Uninstall while preserving data",
      "## Disaster recovery",
    ]) {
      expect(runbook).toContain(heading);
    }
    expect(runbook).toContain("release-manifest.json");
    expect(runbook).toContain("SHA256SUMS");
    expect(runbook).toContain("vellum-linux-verify-x64");
    expect(runbook).toContain("--keyring /path/to/authenticated/release-keyring.json");
    expect(runbook).toContain("--trusted-key-id AUTHENTICATED_KEY_ID");
    expect(runbook).toContain(
      "--trusted-key-fingerprint-sha256 AUTHENTICATED_KEY_FINGERPRINT",
    );
    expect(runbook).toContain("sha256sum --check --strict");
    expect(runbook).toContain("--peer-station-browser-protocol 1");
    expect(runbook).toContain("--peer-work-control-protocol vellum-work/v1");
    expect(runbook).toContain("systemctl --user enable --now vellum-remote.service");
    expect(runbook).toContain("loginctl enable-linger");
    expect(runbook).toContain("sudo apt-get remove vellum");
    expect(runbook).toMatch(/preserves\s+`~\/\.vellum`/u);
    expect(runbook).toContain("use Vellum's in-app profile wipe");
  });

  it("contains no executable unsafe sandbox, root-app, TCP, wipe, or raw-socket guidance", async () => {
    const commands = shellBlocks(await readDoc("linux-operator-runbook.md"));
    for (const forbidden of [
      /--no-sandbox/u,
      /\baa-disable\b/u,
      /systemctl\s+disable\s+apparmor/u,
      /sysctl\b.*unprivileged_userns/u,
      /sudo\s+(?:\/opt\/[^\n]*vellum|vellum)(?:\s|$)/iu,
      /VELLUM_CONTROL_TCP/u,
      /ssh\s+-[A-Za-z]*L[^\n]*control\.sock/u,
      /socat[^\n]*control\.sock/u,
      /rm\s+-rf[^\n]*\.vellum/u,
    ]) {
      expect(commands).not.toMatch(forbidden);
    }
  });

  it("publishes one exact support matrix and explicit exclusions", async () => {
    const matrix = await readDoc("linux-v1-support-matrix.md");
    for (const supported of [
      "Ubuntu 24.04 LTS",
      "x86-64 / `amd64` only",
      "glibc 2.39",
      "X11/Xvfb",
      "Wayland/XWayland",
      "version `1`",
      "`vellum-work/v1`",
    ]) {
      expect(matrix).toContain(supported);
    }
    for (const unsupported of [
      "Linux arm64 / aarch64",
      "musl / Alpine",
      "AppImage",
      "RPM",
      "Snap",
      "Flatpak",
      "Container-only host",
    ]) {
      expect(matrix).toContain(unsupported);
    }
  });

  it("documents custody, rotation, revocation, and the remaining human ceremony", async () => {
    const policy = await readDoc("linux-release-key-policy.md");
    expect(policy).toContain("CI has read-only repository permission");
    expect(policy).toContain("receives no release private key");
    expect(policy).toContain("## Custody and recovery");
    expect(policy).toContain("## Rotation");
    expect(policy).toContain("## Revocation");
    expect(policy).toContain("Revocation is irreversible");
    expect(policy).toContain("## Exact remaining production ceremony");
    expect(policy).toContain("explicit GO or NO-GO");
    expect(policy).toContain("No script in this repository performs step 8 or step 9");
  });

  it("keeps the checked-in changelog visibly non-publishable", async () => {
    const changelog = await readDoc("linux-release-changelog-template.md");
    expect(changelog).toContain("NOT AUTHORIZED FOR PUBLICATION");
    expect(changelog).toContain("human release authority replaces this file");
  });
});
