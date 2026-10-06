import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  linuxReleaseSourceRevisionMain,
  sourceRevisionReceipt,
} from "../scripts/linux-release-source-revision";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

describe("Linux release source revision", () => {
  it("writes the receipt the release bundle reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "junto-source-revision-"));
    try {
      const out = path.join(root, "evidence", "source-revision.json");
      await linuxReleaseSourceRevisionMain([
        "--source-revision", REVISION, "--source-out", out,
      ]);
      expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
        schema: "junto/source-revision/v1",
        revision: REVISION,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses anything but a full commit id", () => {
    expect(() => sourceRevisionReceipt("main")).toThrow(/full lowercase commit id/u);
  });
});
