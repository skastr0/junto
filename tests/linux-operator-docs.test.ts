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

describe("Linux desktop alpha operator documentation", () => {
  it("hosts independently authenticated first-install bootstrap instructions", async () => {
    const bootstrap = await readDoc("linux-desktop-bootstrap.md");
    const commands = shellBlocks(bootstrap);
    expect(bootstrap).toContain("independently hosted first-install approval record");
    expect(bootstrap).toContain("The packaged application CLI does not install Linux desktop");
    expect(bootstrap).toContain("That procedure is withdrawn");
    expect(commands).toContain("gh attestation verify");
    expect(commands).toContain("bun scripts/install-linux-desktop.ts");
    expect(commands).toContain("junto-desktop-bootstrap-linux-x64");
    expect(commands).not.toMatch(/^\s*tar\s+-xzf\b/mu);
    expect(commands).not.toContain("desktop-install");
    expect(commands).not.toContain("resources/bin/junto");
    expect(commands).not.toContain("sha256sum");
  });

  it("covers managed desktop install, update and forward-only recovery", async () => {
    const runbook = await readDoc("linux-operator-runbook.md");
    const text = collapsed(runbook);
    for (const heading of [
      "## Before first install",
      "## Automatic desktop updates",
      "## State custody",
      "## Troubleshooting",
      "## Removal and repair",
    ]) {
      expect(runbook).toContain(heading);
    }

    // First-install admission and app-owned updates retain ordinary-user authority.
    expect(text).toContain(
      "Run everything as the intended ordinary user",
    );
    expect(text).toContain(
      "Authenticate first install with an independently obtained bootstrap or a reviewed source checkout before any candidate-archive code runs",
    );
    expect(text).toContain(
      "Do not extract the archive or execute its bundled CLI",
    );
    expect(text).toContain(
      "`--release ... --archive ...`",
    );
    expect(text).toContain(
      "refuses an existing managed launcher and never launches the app or opens its database",
    );
    expect(text).toContain(
      "`~/.local/opt/junto-alpha/<version>-<archiveSHA256>/`",
    );
    expect(text).toContain("`~/.local/bin/junto-desktop`");
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
    expect(runbook).not.toContain("## Post-COMMIT repair");
    expect(runbook).not.toContain("## Uninstall the package");
    expect(runbook).not.toContain("sudo apt-get remove");
    expect(runbook).not.toContain("/var/lib/junto-release-stage");
    expect(runbook).not.toContain("junto-linux-verify-x64");
    expect(runbook).not.toContain("/usr/libexec/junto-release-bridge");
    expect(runbook).not.toContain("/usr/libexec/junto-release-installer");


    // State custody + forward-only repair.
    expect(runbook).toContain("`~/.junto/state/junto.db`");
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
      "The managed layout keeps the launcher-selected generation and one live staged candidate",
    );
    expect(text).toContain(
      "Activation itself still does not retire generations or roll back",
    );
    expect(text).toContain(
      "Existing managed installations are not retroactively authenticated by a later bootstrap release",
    );
    expect(text).toContain(
      "Never add `--no-sandbox`, disable AppArmor, weaken global user namespaces, run the app as root or install a setuid helper",
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
      /sudo\s+(?:\/opt\/[^\n]*junto|junto)(?:\s|$)/iu,
      /JUNTO_CONTROL_TCP/u,
      /ssh\s+-[A-Za-z]*L[^\n]*control\.sock/u,
      /socat[^\n]*control\.sock/u,
      /rm\s+-rf[^\n]*\.junto/u,
      /sudo\s+apt-get\s+(?:install|remove|purge)\b[^\n]*junto/iu,
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
      /\b(?:tar|cp|rsync|mv)\b[^\n]*(?:\.junto|junto\.db|junto\.db-wal|junto\.db-shm)/iu,
    );
    expect(commands).not.toMatch(/\bVACUUM\s+INTO\b/iu);
    expect(commands).not.toMatch(
      /\bsqlite3\b[^\n]*(?:\.junto|junto\.db)/iu,
    );
    expect(prose).not.toMatch(
      /restore.{0,160}(?:as|to|into)\s+`?~\/\.junto\/state\/junto\.db/iu,
    );
    expect(prose).not.toMatch(
      /(?:create|make|take).{0,160}(?:backup|archive).{0,160}\b`?~\/\.junto\b/iu,
    );
    expect(docs).not.toContain("junto-backups");
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
      "Wayland/XWayland",
      "Signed `/linux/x64/alpha.json`; automatic check/download, explicit Restart",
      "Managed official installations only",
    ]) {
      expect(matrix).toContain(supported);
    }
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
});
