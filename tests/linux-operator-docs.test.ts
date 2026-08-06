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

const collapsed = (input: string): string => input.replace(/\s+/gu, " ");

describe("Linux v1 operator documentation", () => {
  it("covers the complete install and recovery lifecycle", async () => {
    const runbook = await readDoc("linux-operator-runbook.md");
    const text = collapsed(runbook);
    for (const heading of [
      "## Before install or update",
      "## State custody boundary",
      "## Fresh install and role selection",
      "## Remote station and user service",
      "## Readiness and Doctor",
      "## Logs and bounded diagnostics",
      "## Upgrade",
      "## Removal",
      "## Browser profile lifecycle",
      "## Disaster recovery",
      "## Prohibited shortcuts",
    ]) {
      expect(runbook).toContain(heading);
    }

    // Rootless ordinary-user lane — not privileged package mutation.
    expect(text).toContain(
      "install and update lane runs entirely as the intended ordinary user",
    );
    expect(text).toContain("owner-local storage");
    expect(text).toContain("canonical rootless lane");
    expect(text).toContain(
      "must not fall back to `.deb`, `apt`, `dpkg`, `/opt`, a release bridge, a root journal, or administrator input",
    );
    expect(runbook).not.toContain("## Before any package mutation");
    expect(runbook).not.toContain("## Remote station and Xvfb");
    expect(runbook).not.toContain("## Post-COMMIT repair");
    expect(runbook).not.toContain("## Uninstall the package");
    expect(runbook).not.toContain("sudo apt-get remove");
    expect(runbook).not.toContain("/var/lib/vellum-release-stage");
    expect(runbook).not.toContain("vellum-linux-verify-x64");
    expect(runbook).not.toContain("/usr/libexec/vellum-release-bridge");
    expect(runbook).not.toContain("/usr/libexec/vellum-release-installer");

    // Displayless Node Remote is core; Xvfb is not required.
    expect(text).toContain(
      "The core Remote executable is a packaged Node process",
    );
    expect(text).toContain(
      "does not require `DISPLAY`, Wayland, X authority, `Xvfb`, `xauth`, or `mcookie`",
    );
    expect(text).toContain(
      "Do not install a display stack to make the core Remote start",
    );

    // Browser unavailable for first Beta; Doctor core readiness independent.
    expect(text).toContain(
      "Browser automation is intentionally unavailable on Linux Remote for the first Beta",
    );
    expect(text).toContain(
      "Browser remains `unavailable` on Linux Remote for the first Beta, while core readiness is independent from browser-side display and security findings",
    );
    expect(text).toContain(
      "Linux Remote browser profiles are not part of the first Beta because browser automation is unavailable",
    );

    // State custody + forward-only repair.
    expect(runbook).toContain("`~/.vellum-command/state/vellum-command.db`");
    expect(text).toContain("repair is forward-only with a newer signed payload");
    expect(text).toContain(
      "An older binary is never activated against advanced state",
    );
    expect(text).toContain(
      "add a `sudoers` rule, setuid helper, file capability, polkit rule",
    );
    expect(text).toContain("add `--no-sandbox`");
  });

  it("documents displayless beta contracts across production, host, and matrix", async () => {
    const production = collapsed(await readDoc("linux-production-contract.md"));
    const host = collapsed(await readDoc("linux-host-preparation.md"));
    const matrix = collapsed(await readDoc("linux-v1-support-matrix.md"));
    const qualification = collapsed(
      await readDoc("linux-package-qualification.md"),
    );

    // Rootless userland / signed owner-local payload (vellum-runtime archive lane).
    expect(production).toContain("one signed rootless Station payload");
    expect(qualification).toContain("rootless userland payload");
    expect(qualification).toContain(
      "exact signed rootless payload",
    );
    expect(matrix).toContain(
      "One exact signed owner-local payload; same ordinary-user transaction for first install and update",
    );

    // Displayless Node Remote; Xvfb not a core prerequisite.
    expect(production).toContain("displayless Node Remote");
    expect(production).toContain(
      "packaged Node runtime under the Station user's service manager, with no Electron, Chromium, or display-server dependency",
    );
    expect(production).toContain(
      "The packaged Node Remote ignores `DISPLAY`, Wayland, and X authority. It starts without `Xvfb`, `xauth`, or `mcookie`",
    );
    expect(host).toContain(
      "The core Linux Remote is a packaged Node process. It does not import Electron or Chromium and does not require `DISPLAY`, Wayland, `Xvfb`, `xauth`, or `mcookie`",
    );
    expect(host).toContain(
      "Do not install `Xvfb`, `xauth`, or `mcookie` to make the current core Remote work",
    );
    expect(matrix).toContain(
      "Packaged Node process; no Electron, Chromium, `DISPLAY`, Xvfb, xauth, or mcookie dependency",
    );

    // Browser unavailable for first Beta; Doctor core readiness independent of display.
    expect(production).toContain(
      "Linux Remote browser automation is unavailable for the first Beta",
    );
    expect(production).toContain(
      "Doctor keeps core Remote readiness independent from browser, display, sandbox, and secret-storage findings, while the first-Beta browser capability remains `unavailable`",
    );
    expect(production).toContain(
      "Browser, display, sandbox, and secret-storage observations are optional and cannot block core Node Remote readiness",
    );
    expect(host).toContain(
      "Browser automation is intentionally unavailable on Linux Remote for the first Beta",
    );
    expect(host).toContain(
      "let display, AppArmor, user-namespace, or secret-storage findings override healthy core Node Remote status",
    );
    expect(matrix).toContain(
      "Intentionally unavailable in first Beta; does not affect core health",
    );
    expect(qualification).toContain(
      "core Doctor status can be `ready` without display tooling",
    );
    expect(qualification).toContain(
      "Linux Remote browser automation remains explicitly `unavailable`",
    );

    // No sudo / deb / /opt product path.
    expect(production).toContain("There is no supported privileged fallback");
    expect(production).toContain(
      "The `.deb`/`/opt` contract and any remaining privileged types, tests, scripts, receipts, or instructions are migration residue",
    );
    expect(host).toContain(
      "Vellum Command never invokes `sudo`, accepts an administrator password",
    );
    expect(host).toContain(
      "write application releases under `/opt`, `/usr`, `/var/lib`, or another system-owned location as part of the canonical lane",
    );
    expect(host).toContain(
      "describe the current privileged `.deb` lane as beta, production, fallback, offline, enterprise, or recovery support",
    );
    expect(matrix).toContain(
      "Privileged `.deb`, `/opt`, release bridge/installer, root journal, administrator credential flow",
    );
    expect(qualification).toContain(
      "fresh install with no `sudo`, `su`, `pkexec`, system package manager",
    );
    expect(qualification).toContain(
      "a system-owned active release path such as `/opt`, `/usr`, or `/var/lib`",
    );
  });

  it("contains no executable unsafe sandbox, root-app, TCP, wipe, or raw-socket guidance", async () => {
    const docs = await readProductDocs();
    const commands = shellBlocks(docs);
    for (const forbidden of [
      /--no-sandbox/u,
      /\baa-disable\b/u,
      /systemctl\s+disable\s+apparmor/u,
      /sysctl\b.*unprivileged_userns/u,
      /sudo\s+(?:\/opt\/[^\n]*vellum|vellum)(?:\s|$)/iu,
      /VELLUM_COMMAND_CONTROL_TCP/u,
      /ssh\s+-[A-Za-z]*L[^\n]*control\.sock/u,
      /socat[^\n]*control\.sock/u,
      /rm\s+-rf[^\n]*\.vellum-command/u,
      /sudo\s+apt-get\s+(?:install|remove|purge)\b[^\n]*vellum/iu,
      /dpkg\s+-i\b/u,
    ]) {
      expect(commands).not.toMatch(forbidden);
    }

    // Prose may name --no-sandbox only as a prohibited path, never as guidance.
    expect(docs).toMatch(/--no-sandbox/u);
    expect(collapsed(docs)).toMatch(
      /(?:never|not|rather than|adds?|adding)\b[^.]{0,80}--no-sandbox/iu,
    );
  });

  it("keeps verified backup export separate from restore and rollback", async () => {
    const docs = await readProductDocs();
    const commands = shellBlocks(docs).replace(/\\\r?\n\s*/gu, " ");
    const prose = collapsed(docs);

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
    expect(prose).toMatch(
      /Settings\s+→\s+Advanced lists verified retained backups and can export one/iu,
    );
    expect(prose).toMatch(
      /There is no restore, import, replacement, or downgrade surface/iu,
    );
    expect(prose).toMatch(
      /Never restore, downgrade, or replace product state as part of repair/u,
    );
  });

  it("publishes one exact support matrix and explicit exclusions", async () => {
    const matrix = await readDoc("linux-v1-support-matrix.md");
    for (const supported of [
      "Ubuntu 24.04 LTS",
      "x86-64 / `amd64` only",
      "glibc 2.39",
      "Packaged Node process",
      "Wayland/XWayland",
      "five verbs only",
      "host-local",
      "`vellum-command-work/v1`",
      "Intentionally unavailable in first Beta",
    ]) {
      expect(matrix).toContain(supported);
    }
    expect(matrix).toContain("no Electron, Chromium, `DISPLAY`, Xvfb");
    expect(matrix).not.toContain("Station-browser protocol");
    // Xvfb is not a supported core Remote display requirement.
    expect(matrix).not.toMatch(/X11\/Xvfb/u);
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
    const normalized = collapsed(qualification);
    expect(normalized).toContain(
      "downgrade only as a rejection: no older build may activate",
    );
  });

  it("documents the exact structured two-installation qualification", async () => {
    const qualification = await readDoc("linux-package-qualification.md");
    const normalized = collapsed(qualification);
    for (const required of [
      "`nativePlatform`",
      "`commandCenterOfflineClaimedTask`",
      "`reportResponseRetry`",
      "`syntheticNoOverlap`",
      "`eventHome`",
      "`entityHome`",
      "`linux` / `ubuntu` / `24.04` / `x64`",
      "`darwin` / `macos`",
      "Only the Remote platform is bound to the exact Linux rootless payload",
      "`station-qualification-evidence.txt`",
      "human/operator attestation",
      "`station-qualification-evidence` entry in the signed release manifest",
      "displayless Node Remote",
      "rootless userland payload",
    ]) {
      expect(normalized).toContain(required);
    }
    expect(qualification).not.toContain("ordered `checks`");
    expect(normalized).not.toContain(
      "Only the Remote platform is bound to the deb",
    );
  });

  it("documents custody, rotation, revocation, and the remaining human ceremony", async () => {
    const policy = await readDoc("linux-release-key-policy.md");
    const text = collapsed(policy);
    expect(text).toContain("CI has read-only repository permission");
    expect(text).toContain("receives no release private key");
    expect(policy).toContain("## Custody and recovery");
    expect(policy).toContain("## Rotation");
    expect(policy).toContain("## Revocation");
    expect(policy).toContain("Revocation is irreversible");
    expect(policy).toContain("## First Linux publication gate");
    expect(text).toContain("explicit GO or NO-GO");
    expect(policy).toContain("CI-evidence-manifest");
    expect(policy).toContain("cross-platform promotion");
    expect(text).toContain(
      "No script in this repository performs the GO or upload steps",
    );
    expect(policy).toContain("release-manifest.json");
    expect(policy).toContain("SHA256SUMS");
    expect(policy).toContain("linux-release-tool.ts");
    expect(text).toContain("canonical rootless payload");
    expect(text).toContain(
      "confirms the privileged `.deb`, `/opt`, release bridge/installer, root journal, and administrator-credential product paths are absent",
    );
    expect(policy).not.toContain("ubuntu-24.04-x64-release");
    // No checked-in privileged signing recipe until rootless inputs exist.
    expect(policy).not.toContain(
      "< /offline/custody/vellum-linux-ed25519.pem",
    );
  });

  it("keeps the checked-in changelog visibly non-publishable", async () => {
    const changelog = await readDoc("linux-release-changelog-template.md");
    expect(changelog).toContain("NOT AUTHORIZED FOR PUBLICATION");
    expect(changelog).toContain("human release authority replaces this file");
  });
});
