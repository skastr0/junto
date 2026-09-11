/**
 * Portable contract tests for Linux userland generation readiness.
 * Privileged installer/bridge readiness receipts are retired.
 */
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLinuxRemotePreflightScript,
} from "../src/main/vellum-command/hosts/deploy-linux";
import {
  compileLinuxUserlandPreflightSource,
  compileLinuxUserlandDeploySource,
} from "../src/main/vellum-command/ssh/remote-plan";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

const validateGenerationReadinessReceipt = (
  raw: string,
  generation: string,
): boolean =>
  raw === `${generation}\n` &&
  !raw.includes("\u0000") &&
  raw.endsWith("\n") &&
  raw.indexOf("\n") === raw.length - 1;

describe("Linux generation readiness contract", () => {
  it("userland preflight/deploy scripts carry no privileged readiness machinery", () => {
    expect(buildLinuxRemotePreflightScript()).toBe("userland runtime preflight");
    const preflight = compileLinuxUserlandPreflightSource();
    const deploy = compileLinuxUserlandDeploySource();
    for (const source of [preflight, deploy]) {
      expect(source).not.toContain("station_ready_receipt");
      expect(source).not.toContain("sudo");
      expect(source).not.toContain("dpkg");
      expect(source).not.toContain("/opt/");
      expect(source).not.toContain("vellum-release-bridge");
      expect(source).not.toContain("vellum-release-installer");
    }
    expect(preflight).not.toContain("python3");
    expect(deploy).toContain("/usr/bin/python3");
    expect(deploy).toContain('"op": "ping"');
    expect(deploy).not.toMatch(/s\.connect\([^)]+\);\s*s\.close\(\)/u);
    expect(preflight).toContain("systemctl --user");
    expect(deploy).toContain('ROOT="$HOME/.vellum-command/runtime"');
    expect(deploy).toContain("$ROOT/releases");
  });

  it("installer path convention matches work-control under runtimeRoot/uid", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-ready-path-"));
    roots.push(root);
    const generation = "11111111111111111111111111111111";
    const dir = join(root, "vellum-command-remote");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `ready-${generation}`);
    await writeFile(path, `${generation}\n`, { mode: 0o600 });
    expect(validateGenerationReadinessReceipt(
      await readFile(path, "utf8"),
      generation,
    )).toBe(true);
  });
});
