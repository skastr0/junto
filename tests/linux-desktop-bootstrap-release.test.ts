import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_DESKTOP_BOOTSTRAP_NAME,
  prepareLinuxDesktopBootstrapRelease,
} from "../scripts/prepare-linux-desktop-bootstrap-release";
import { itOnLinux } from "./helpers/platform";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const digest = (bytes: Buffer) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

describe("Linux desktop bootstrap corresponding-source publication", () => {
  it("refuses a relink receipt that does not bind the exact commit, Bun, and payload bytes", async () => {
    const dist = await mkdtemp(join(await realpath(tmpdir()), "vellum-command-bootstrap-release-"));
    roots.push(dist);
    const binary = Buffer.from("bootstrap-bytes");
    const payload = Buffer.from("relink-object");
    const notices = Buffer.from("notices");
    await writeFile(join(dist, LINUX_DESKTOP_BOOTSTRAP_NAME), binary);
    await writeFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.js`), payload);
    await writeFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink-notices.txt`), notices);
    await writeFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.json`), JSON.stringify({
      schema: "vellum-command/cli-relink/v1",
      sourceCommit: "a".repeat(40),
      bunVersion: "1.3.13",
      featureProfile: "ship",
      featureFingerprint: "fp",
      payload: digest(payload),
      notices: digest(notices),
      binary: digest(binary),
    }));
    expect(() => prepareLinuxDesktopBootstrapRelease({
      commit: "b".repeat(40),
      bunVersion: "1.3.13",
      distDirectory: dist,
    })).toThrow(/relink receipt/);
    expect(() => prepareLinuxDesktopBootstrapRelease({
      commit: "a".repeat(40),
      bunVersion: "1.3.12",
      distDirectory: dist,
    })).toThrow(/relink receipt/);
    await writeFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.js`), Buffer.from("changed"));
    expect(() => prepareLinuxDesktopBootstrapRelease({
      commit: "a".repeat(40),
      bunVersion: "1.3.13",
      distDirectory: dist,
    })).toThrow(/relink material/);
  });

  // The release script invokes GNU tar with --sort=name; the Linux release
  // host provides that native packaging prerequisite.
  itOnLinux("writes Bun notices, source archive, checksum, and RELINK.md beside matching bytes", async () => {
    const dist = await mkdtemp(join(await realpath(tmpdir()), "vellum-command-bootstrap-release-"));
    roots.push(dist);
    const binary = Buffer.from("bootstrap-bytes");
    const payload = Buffer.from("relink-object");
    const notices = Buffer.from("notices");
    await writeFile(join(dist, LINUX_DESKTOP_BOOTSTRAP_NAME), binary);
    await writeFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.js`), payload);
    await writeFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink-notices.txt`), notices);
    const commit = (await import("node:child_process")).spawnSync(
      "git",
      ["rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).stdout.trim();
    await writeFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.json`), JSON.stringify({
      schema: "vellum-command/cli-relink/v1",
      sourceCommit: commit,
      bunVersion: "1.3.13",
      featureProfile: "ship",
      featureFingerprint: "fp",
      payload: digest(payload),
      notices: digest(notices),
      binary: digest(binary),
    }));
    const prepared = prepareLinuxDesktopBootstrapRelease({
      commit,
      bunVersion: "1.3.13",
      distDirectory: dist,
    });
    expect(prepared.assets).toContain(`${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.js`);
    expect(prepared.assets).toContain(`${LINUX_DESKTOP_BOOTSTRAP_NAME}-bun-notices.tar.gz`);
    expect(await readFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}.sha256`), "utf8"))
      .toContain(digest(binary).sha256);
    expect(await readFile(join(dist, "RELINK.md"), "utf8")).toContain("prepare-runtime-sources.ts");
    const bunNotices = await readFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-bun-notices.tar.gz`));
    expect(bunNotices.length).toBeGreaterThan(1_000);
  });
});
