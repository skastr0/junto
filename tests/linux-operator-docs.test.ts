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

describe("Linux desktop alpha and gated Fleet operator documentation", () => {
  it("covers managed desktop install, update and forward-only recovery", async () => {
    const runbook = await readDoc("linux-operator-runbook.md");
    const text = collapsed(runbook);
    for (const heading of [
      "## Before first install",
      "## Automatic desktop updates",
      "## State custody",
      "## Troubleshooting",
      "## Removal and repair",
      "## Separate Fleet Remote contract",
    ]) {
      expect(runbook).toContain(heading);
    }

    // First-install admission and app-owned updates retain ordinary-user authority.
    expect(text).toContain(
      "Run everything as the intended ordinary user",
    );
    expect(text).toContain(
      "Verify that SHA-256 before extracting or executing the bundled CLI",
    );
    expect(text).toContain(
      "`desktop-install --release ... --archive ... --sources ...`",
    );
    expect(text).toContain(
      "refuses an existing managed launcher and never launches the app or opens its database",
    );
    expect(text).toContain(
      "`~/.local/opt/vellum-command-alpha/<version>-<archiveSHA256>/`",
    );
    expect(text).toContain("`~/.local/bin/vellum-command-desktop`");
    expect(text).toContain(
      "The app never invokes a package manager, loads AppArmor policy, enables lingering, collects administrator credentials or retries through a privileged fallback",
    );
    expect(text).toContain(
      "Managed official installations automatically check and download the signed alpha feed at `/linux/x64/alpha.json`",
    );
    expect(text).toContain("Choose **Restart** in the app");
    expect(text).toContain(
      "the existing app flushes pending product work and shuts down its owned runtime and database connection",
    );
    expect(text).toContain(
      "schema migration runs during normal app startup through its sole `StateEngine` connection",
    );
    expect(text).toContain(
      "Unmanaged source builds and loose extracted copies do not update themselves through the managed release lane",
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

    // Desktop evidence cannot qualify the gated, displayless Remote.
    expect(text).toContain(
      "Desktop alpha does not enable or qualify Fleet Remote",
    );
    expect(text).toContain(
      "Remote runs the packaged Node runtime under the Station user's service manager, with no Electron, Chromium, display server, Xvfb, xauth or mcookie prerequisite",
    );
    expect(text).toContain(
      "Desktop launch and update receipts do not substitute for those proofs",
    );
    expect(text).toContain(
      "Browser automation remains unavailable in the first Remote Beta",
    );
    expect(text).toContain(
      "Core Node health is independent of a future browser sidecar's display, sandbox and secret-storage requirements",
    );

    // State custody + forward-only repair.
    expect(runbook).toContain("`~/.vellum-command/state/vellum-command.db`");
    expect(text).toContain("There is no sealed clone preflight or second database opener");
    expect(text).toContain(
      "Install/update never copies, replaces, archives or redirects the product database, WAL or shared-memory file",
    );
    expect(text).toContain(
      "Once state advances, repair uses a newer signed release; there is no downgrade or filesystem rollback",
    );
    expect(text).toContain(
      "Do not rerun the first-install command to replace an active installation or switch the launcher to an older generation",
    );
    expect(text).toContain(
      "Never add `--no-sandbox`, disable AppArmor, weaken global user namespaces, run the app as root or install a setuid helper",
    );
  });

  it("documents displayless beta contracts across production, host, and matrix", async () => {
    const production = collapsed(await readDoc("linux-production-contract.md"));
    const host = collapsed(await readDoc("linux-host-preparation.md"));
    const matrix = collapsed(await readDoc("linux-v1-support-matrix.md"));
    const qualification = collapsed(
      await readDoc("linux-package-qualification.md"),
    );

    // Desktop and Fleet share rootless authority but have separate qualification.
    expect(production).toContain(
      "The canonical payload is `vellum-runtime-<version>-linux-x64.tar.gz`",
    );
    expect(production).toContain(
      "Desktop descriptors and the alpha feed live under `/linux/x64/`, separately from the gated Fleet release contract",
    );
    expect(production).toContain(
      "This does not block a separately qualified desktop alpha release",
    );
    expect(qualification).toContain("rootless userland payload");
    expect(qualification).toContain(
      "exact signed rootless payload",
    );
    expect(matrix).toContain(
      "Immutable owner-local generations",
    );

    // Displayless Node Remote; Xvfb not a core prerequisite.
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
    expect(matrix).toContain("Packaged Node, without Electron, Chromium, display server, Xvfb, xauth or mcookie");

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
      "Unavailable in the first Remote Beta | Display/sandbox/secret-storage gaps do not block core Node health",
    );
    expect(qualification).toContain(
      "core Doctor status can be `ready` without display tooling",
    );
    expect(qualification).toContain(
      "Linux Remote browser automation remains explicitly `unavailable`",
    );

    // No sudo / deb / /opt product path.
    expect(production).toContain(
      "The retired `.deb`/`/opt` lane is not a fallback",
    );
    expect(production).toContain(
      "No administrator-password flow, privileged bridge, root journal or parallel system installer is permitted",
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
      "No `/opt` installer, administrator-credential flow, privileged bridge, root journal, setuid helper or package-manager fallback is supported",
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
    const runbook = collapsed(await readDoc("linux-operator-runbook.md"));
    expect(runbook).toContain(
      "Settings → Advanced can list verified retained backups and export one to an explicit new destination",
    );
    expect(runbook).toContain(
      "no restore, import, database replacement or downgrade surface",
    );
    expect(runbook).toContain(
      "Do not reconstruct, replace or delete state files",
    );
  });

  it("publishes one exact support matrix and explicit exclusions", async () => {
    const matrix = await readDoc("linux-v1-support-matrix.md");
    for (const supported of [
      "Ubuntu 24.04 LTS",
      "x86-64",
      "glibc 2.39",
      "Packaged Node",
      "Wayland/XWayland",
      "Five bounded verbs over OpenSSH",
      "Owner-local Unix socket with process-bound identity",
      "Unavailable in the first Remote Beta",
      "Real two-installation qualification required",
      "Desktop alpha evidence grants no Fleet qualification",
      "Signed `/linux/x64/alpha.json`; automatic check/download, explicit Restart",
      "Managed official installations only",
    ]) {
      expect(matrix).toContain(supported);
    }
    expect(matrix).toContain("without Electron, Chromium, display server, Xvfb");
    expect(matrix).not.toContain("Station-browser protocol");
    // Xvfb is not a supported core Remote display requirement.
    expect(matrix).not.toMatch(/X11\/Xvfb/u);
    for (const unsupported of [
      "Linux ARM64",
      "musl/Alpine",
      "AppImage",
      "RPM",
      "Snap",
      "Flatpak",
      "Container-only results do not establish host-kernel qualification",
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

  it("keeps the checked-in changelog visibly non-publishable", async () => {
    const changelog = await readDoc("linux-release-changelog-template.md");
    expect(changelog).toContain("NOT AUTHORIZED FOR PUBLICATION");
    expect(changelog).toContain("human release authority replaces this file");
  });
});
