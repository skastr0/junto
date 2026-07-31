import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readDoc = async (name: string): Promise<string> =>
  readFile(new URL(`../docs/${name}`, import.meta.url), "utf8");

const shellBlocks = (input: string): string =>
  [...input.matchAll(/```sh\n([\s\S]*?)```/gu)]
    .map((match) => match[1])
    .join("\n");

const readProductDocs = async (): Promise<string> => {
  const docsDir = new URL("../docs/", import.meta.url);
  const entries = await readdir(docsDir, { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => readFile(new URL(entry.name, docsDir), "utf8")),
    )
  ).join("\n");
};

describe("Linux v1 operator documentation", () => {
  it("covers the complete install and recovery lifecycle", async () => {
    const runbook = await readDoc("linux-operator-runbook.md");
    for (const heading of [
      "## Before any package mutation",
      "## State custody boundary",
      "## Fresh install",
      "## Remote station and Xvfb",
      "## Readiness and Doctor",
      "## Logs and bounded diagnostics",
      "## Upgrade",
      "## Post-COMMIT repair",
      "## Browser profile lifecycle",
      "## Uninstall the package",
      "## Disaster recovery",
    ]) {
      expect(runbook).toContain(heading);
    }
    expect(runbook).toContain("release-manifest.json");
    expect(runbook).toContain("SHA256SUMS");
    expect(runbook).toContain("vellum-linux-verify-x64");
    expect(runbook).toContain("--keyring /path/to/authenticated/release-keyring.json");
    expect(runbook).toContain(
      "--trusted-keyring-revision AUTHENTICATED_KEYRING_REVISION",
    );
    expect(runbook).toContain(
      "--trusted-keyring-sha256 AUTHENTICATED_KEYRING_SHA256",
    );
    expect(runbook).toContain("--trusted-key-id AUTHENTICATED_KEY_ID");
    expect(runbook).toContain(
      "--trusted-key-fingerprint-sha256 AUTHENTICATED_KEY_FINGERPRINT",
    );
    expect(runbook).toContain("sha256sum --check --strict");
    expect(runbook).toContain("/var/lib/vellum-release-stage/X.Y.Z");
    expect(runbook).toContain("--no-preserve=ownership,mode,timestamps");
    expect(runbook).toContain("packageBytes");
    expect(runbook).toContain("packageSha256");
    expect(runbook).toContain(
      "'/var/lib/vellum-release-stage/X.Y.Z/Vellum Command-X.Y.Z-x64-linux.deb'",
    );
    expect(runbook).toContain(
      "Run the staged verifier as the ordinary station user, never with `sudo`",
    );
    expect(runbook).toContain("--peer-station-protocol-preferred 3");
    expect(runbook).toContain(
      "--peer-station-protocol-compatible-from 3",
    );
    expect(runbook).toContain("--peer-station-protocol-warn-below 3");
    expect(runbook).not.toContain("--peer-version");
    expect(runbook).not.toContain("--peer-station-api-protocol");
    expect(runbook).not.toContain("--peer-work-control-protocol");
    expect(runbook).not.toContain("--peer-station-browser-protocol");
    expect(runbook).toContain("systemctl --user enable --now vellum-remote.service");
    expect(runbook).toContain("loginctl enable-linger");
    expect(runbook).toContain("sudo apt-get remove vellum");
    expect(runbook).toMatch(
      /package removes only package-owned files[\s\S]*does not\s+remove Vellum's app-owned state/u,
    );
    expect(runbook).toContain("Use Vellum's in-app profile wipe");
    expect(runbook).toContain(
      "It installs no `sudoers` policy, setuid binary, or",
    );
    expect(runbook).toContain(
      "/usr/libexec/vellum-release-bridge",
    );
    expect(runbook).toContain(
      "/usr/libexec/vellum-release-installer",
    );
    expect(runbook).toContain(
      "Persistent `NOPASSWD` grants are not part of the product contract",
    );
    expect(runbook).toContain(
      "Any unexplained outcome after `COMMIT` is likewise",
    );
    expect(runbook).toContain("exact bound `STAGE_CLEARED` receipt");
    expect(runbook).toMatch(/even if it\s+happens before `COMMIT`/u);
    expect(runbook).toContain(
      "Managed install, update, and forward repair succeed or fail on this gate alone.",
    );
    expect(runbook).not.toContain("Managed install, update, and rollback activation");
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

  it("keeps verified backup export separate from restore and rollback", async () => {
    const docs = await readProductDocs();
    const commands = shellBlocks(docs).replace(/\\\r?\n\s*/gu, " ");
    const prose = docs.replace(/\s+/gu, " ");

    expect(commands).not.toMatch(
      /\b(?:tar|cp|rsync|mv)\b[^\n]*(?:\.vellum|vellum\.db|vellum\.db-wal|vellum\.db-shm)/iu,
    );
    expect(commands).not.toMatch(/\bVACUUM\s+INTO\b/iu);
    expect(commands).not.toMatch(
      /\bsqlite3\b[^\n]*(?:\.vellum|vellum\.db)/iu,
    );
    expect(prose).not.toMatch(
      /restore.{0,160}(?:as|to|into)\s+`?~\/\.vellum\/state\/vellum\.db/iu,
    );
    expect(prose).not.toMatch(
      /(?:create|make|take).{0,160}(?:backup|archive).{0,160}\b`?~\/\.vellum\b/iu,
    );
    expect(docs).not.toContain("vellum-backups");
    expect(docs).toMatch(
      /Settings\s+→\s+Advanced lists verified retained backups and can export one/iu,
    );
    expect(docs).toMatch(
      /There is no restore, import, replacement, or downgrade surface/iu,
    );
    expect(docs).toMatch(
      /Never restore, downgrade, or replace product state as\s+part of repair/u,
    );
  });

  it("publishes one exact support matrix and explicit exclusions", async () => {
    const matrix = await readDoc("linux-v1-support-matrix.md");
    for (const supported of [
      "Ubuntu 24.04 LTS",
      "x86-64 / `amd64` only",
      "glibc 2.39",
      "X11/Xvfb",
      "Wayland/XWayland",
      "five verbs only",
      "host-local",
      "`vellum-work/v1`",
    ]) {
      expect(matrix).toContain(supported);
    }
    expect(matrix).not.toContain("Station-browser protocol");
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

  it("qualifies downgrades only as one-way cutover rejections", async () => {
    const qualification = await readDoc("linux-package-qualification.md");
    const normalized = qualification.replace(/\s+/gu, " ");
    expect(normalized).toContain(
      "Exercise a downgrade only as a rejection: no older build may activate.",
    );
  });

  it("documents the exact structured two-installation qualification", async () => {
    const qualification = await readDoc("linux-package-qualification.md");
    const normalized = qualification.replace(/\s+/gu, " ");
    for (const required of [
      "`nativePlatform`",
      "`commandCenterOfflineClaimedTask`",
      "`reportResponseRetry`",
      "`syntheticNoOverlap`",
      "`eventHome`",
      "`entityHome`",
      "`linux` / `ubuntu` / `24.04` / `x64`",
      "`darwin` / `macos`",
      "Only the Remote platform is bound to the deb",
      "`station-qualification-evidence.txt`",
      "human/operator attestation",
      "`station-qualification-evidence` entry in the signed release manifest",
    ]) {
      expect(normalized).toContain(required);
    }
    expect(qualification).not.toContain("ordered `checks`");
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
    expect(policy).toContain("CI-evidence-manifest");
    expect(policy).toContain("cross-platform promotion");
    expect(policy).toContain("No script in this repository performs step 8 or step 9");
    expect(policy).toContain("linux-release-tool.ts create");
    expect(policy).toContain("linux-release-tool.ts sign");
    expect(policy).toContain("< /offline/custody/vellum-linux-ed25519.pem");
    expect(policy).not.toContain("ubuntu-24.04-x64-release");
  });

  it("keeps the checked-in changelog visibly non-publishable", async () => {
    const changelog = await readDoc("linux-release-changelog-template.md");
    expect(changelog).toContain("NOT AUTHORIZED FOR PUBLICATION");
    expect(changelog).toContain("human release authority replaces this file");
  });
});
