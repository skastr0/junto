import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_DESKTOP_BOOTSTRAP_NAME,
  prepareLinuxDesktopBootstrapRelease,
} from "../scripts/prepare-linux-desktop-bootstrap-release";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const digest = (bytes: Buffer) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

describe("Linux desktop bootstrap publication", () => {
  it("writes a checksum beside the compiled bootstrap binary", async () => {
    const dist = await mkdtemp(join(await realpath(tmpdir()), "junto-bootstrap-release-"));
    roots.push(dist);
    const binary = Buffer.from("bootstrap-bytes");
    await writeFile(join(dist, LINUX_DESKTOP_BOOTSTRAP_NAME), binary);
    const prepared = prepareLinuxDesktopBootstrapRelease({
      distDirectory: dist,
    });
    expect(prepared.assets).toEqual([
      LINUX_DESKTOP_BOOTSTRAP_NAME,
      `${LINUX_DESKTOP_BOOTSTRAP_NAME}.sha256`,
      `${LINUX_DESKTOP_BOOTSTRAP_NAME}.attestation.jsonl`,
    ]);
    expect(prepared.sha256).toBe(digest(binary).sha256);
    expect(await readFile(join(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}.sha256`), "utf8"))
      .toBe(`${digest(binary).sha256}  ${LINUX_DESKTOP_BOOTSTRAP_NAME}\n`);
  });
});
