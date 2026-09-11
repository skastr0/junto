import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const recoverySource = new URL(
  "../src/main/vellum-command/state/recovery.ts",
  import.meta.url,
);

describe("state recovery architecture", () => {
  it("makes a durable new copy and cleans only the created inode", async () => {
    const source = await readFile(recoverySource, "utf8");
    expect(source).toContain("fsyncSync(destinationDescriptor)");
    expect(source).toContain("constants.O_EXCL");
    expect(source).toContain("linked.dev === expected.dev");
    expect(source).toContain("linked.ino === expected.ino");
    expect(source).toContain(
      "unlinkExactFile(destination, copied.identity)",
    );
  });

  it("checks current-user ownership without inventing it on unsupported platforms", async () => {
    const source = await readFile(recoverySource, "utf8");
    expect(source).toContain('typeof process.getuid === "function"');
    expect(source).toContain(
      "state backup directory is not an owner-only real directory",
    );
    expect(source).toContain("STATE_FILE_MODE = 0o600");
  });
});
