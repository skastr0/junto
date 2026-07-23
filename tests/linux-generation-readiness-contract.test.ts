/**
 * Portable contract tests for the single Linux boot readiness receipt.
 * Full privileged installer suite still requires root-owned bridge staging
 * (Linux); these tests lock the receipt shape that work-control, launcher,
 * preflight, and installer must agree on.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishSystemdGenerationReadiness } from "../src/main/vellum/work/control";
import { buildLinuxRemotePreflightScript } from "../src/main/vellum/hosts/deploy-linux";

const roots: string[] = [];
const originalInvocationId = process.env.INVOCATION_ID;
const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;

const restoreEnvironment = (): void => {
  if (originalInvocationId === undefined) delete process.env.INVOCATION_ID;
  else process.env.INVOCATION_ID = originalInvocationId;
  if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
};

afterEach(async () => {
  restoreEnvironment();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

/** Installer validation rule — kept in lockstep with scripts/linux-release-installer.ts */
const validateGenerationReadinessReceipt = (
  raw: string,
  generation: string,
): boolean => raw === `${generation}\n`;

describe("Linux generation readiness contract", () => {
  it("work-control publishes plain generation body under vellum-remote/ready-$GEN", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-gen-ready-"));
    roots.push(root);
    await mkdir(join(root, "vellum-remote"), { mode: 0o700 });
    const generation = "c".repeat(32);
    process.env.INVOCATION_ID = generation;
    process.env.XDG_RUNTIME_DIR = root;

    publishSystemdGenerationReadiness();

    const path = join(root, "vellum-remote", `ready-${generation}`);
    const body = await readFile(path, "utf8");
    expect(body).toBe(`${generation}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(validateGenerationReadinessReceipt(body, generation)).toBe(true);
  });

  it("rejects deep JSON and wrong-path station-ready shape", async () => {
    const generation = "d".repeat(32);
    const deep = `${JSON.stringify({
      version: 1,
      generation,
      state: "ready",
      components: { work: "ready" },
    })}\n`;
    expect(validateGenerationReadinessReceipt(deep, generation)).toBe(false);
    expect(validateGenerationReadinessReceipt(generation, generation)).toBe(
      false,
    );
    expect(
      validateGenerationReadinessReceipt(`${generation}\n`, generation),
    ).toBe(true);
  });

  it("preflight script no longer embeds deep station_ready_receipt or term/browser boot gates", () => {
    const script = buildLinuxRemotePreflightScript();
    expect(script).not.toContain("station_ready_receipt");
    expect(script).not.toContain("station-ready.json");
    expect(script).not.toContain("python3");
    expect(script).toContain(
      'READY_RECEIPT="/run/user/$UID_VALUE/vellum-remote/ready-$INVOCATION"',
    );
    expect(script).toContain(
      '[ "$(/usr/bin/wc -c < "$READY_RECEIPT" 2>/dev/null | /usr/bin/tr -d \' \')" = 33 ]',
    );
    expect(script).toContain(
      '[ "$(/usr/bin/cat "$READY_RECEIPT" 2>/dev/null || true)" = "$INVOCATION" ]',
    );
    expect(script).toContain('private_socket "$HOME/.vellum/work/control.sock"');
    expect(script).toContain('private_file "$HOME/.vellum/work/token"');
    // Terminal/browser remain Doctor observations — not CURRENT_READY.
    expect(script).not.toContain('private_socket "$HOME/.vellum/term/control.sock"');
    expect(script).not.toContain(
      'private_socket "$HOME/.vellum/browser/control.sock"',
    );
  });

  it("installer path convention matches work-control under runtimeRoot/uid", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-installer-ready-path-"));
    roots.push(root);
    const uid = 1000;
    const generation = "e".repeat(32);
    const dir = join(root, String(uid), "vellum-remote");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `ready-${generation}`);
    await writeFile(path, `${generation}\n`, { mode: 0o600 });
    expect(await readFile(path, "utf8")).toBe(`${generation}\n`);
    // Orphan path must not be the contract.
    expect(path).not.toContain("station-ready.json");
    expect(path.endsWith(`vellum-remote/ready-${generation}`)).toBe(true);
  });
});
