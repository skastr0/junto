import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditLinuxPtyPlacement } from "../scripts/linux-packaged-pty-smoke";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "vellum-linux-pty-layout-"));
  roots.push(path);
  return path;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Linux packaged PTY layout audit", () => {
  it("requires an unpacked native module and executable spawn helper", async () => {
    const resources = await root();
    const base = join(resources, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "linux-x64");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "pty.node"), "native");
    writeFileSync(join(base, "spawn-helper"), "helper");
    chmodSync(join(base, "spawn-helper"), 0o755);

    expect(auditLinuxPtyPlacement(resources)).toMatchObject({
      nativeModule: join(base, "pty.node"),
      spawnHelper: join(base, "spawn-helper"),
    });
  });

  it("rejects ASAR-only or non-executable helpers", async () => {
    const resources = await root();
    const base = join(resources, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "linux-x64");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "pty.node"), "native");
    writeFileSync(join(base, "spawn-helper"), "helper");
    chmodSync(join(base, "spawn-helper"), 0o644);
    expect(() => auditLinuxPtyPlacement(resources)).toThrow(/spawn-helper/u);
  });
});
