import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishSystemdGenerationReadiness } from "../src/main/vellum-command/work/control";

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

describe("work control systemd readiness", () => {
  it("ignores ambient Linux desktop runtime directories outside a systemd invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-command-work-ready-desktop-"));
    roots.push(root);
    delete process.env.INVOCATION_ID;
    process.env.XDG_RUNTIME_DIR = root;

    expect(() => publishSystemdGenerationReadiness()).not.toThrow();
  });

  it("requires a valid runtime directory once systemd supplies an invocation id", () => {
    process.env.INVOCATION_ID = "a".repeat(32);
    delete process.env.XDG_RUNTIME_DIR;

    expect(() => publishSystemdGenerationReadiness()).toThrow(
      "invalid systemd generation readiness environment",
    );
  });

  it("publishes the exact private generation receipt for a systemd invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-command-work-ready-systemd-"));
    roots.push(root);
    await mkdir(join(root, "vellum-command-remote"));
    const generation = "b".repeat(32);
    process.env.INVOCATION_ID = generation;
    process.env.XDG_RUNTIME_DIR = root;

    publishSystemdGenerationReadiness();

    const receiptPath = join(root, "vellum-command-remote", `ready-${generation}`);
    expect(await readFile(receiptPath, "utf8")).toBe(`${generation}\n`);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
  });

  it("assigns generation publication only to the displayless Remote entry", async () => {
    const workControlSource = await readFile(
      new URL("../src/main/vellum-command/work/control.ts", import.meta.url),
      "utf8",
    );
    const genericStartup = workControlSource.slice(
      workControlSource.indexOf("export const startWorkControlServer"),
    );
    expect(genericStartup).not.toContain(
      "publishSystemdGenerationReadiness();",
    );

    const remoteSource = await readFile(
      new URL("../src/main/vellum-remote.ts", import.meta.url),
      "utf8",
    );
    expect(
      remoteSource.match(/publishSystemdGenerationReadiness\(\);/gu),
    ).toHaveLength(1);
    expect(
      remoteSource.indexOf("publishSystemdGenerationReadiness();"),
    ).toBeGreaterThan(
      remoteSource.indexOf("await termPlane.start({ controlHome });"),
    );
  });
});
