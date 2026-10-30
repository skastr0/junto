import { existsSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { startCore } from "../src/main/junto/core";
import { canvasControlDir, canvasControlSocketPath } from "../src/main/junto/canvas-control/protocol";

// The core starts once per process, so the desktop core's canvas edits are their own file.
it("serves canvas edits from the desktop core, and closes them with it", async () => {
  const home = await mkdtemp("/tmp/junto-core-");
  const build = "b".repeat(64);
  const canvasPath = canvasControlSocketPath(canvasControlDir(home));
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build, bundles: {}, canvasControl: true });
    expect((await lstat(canvasPath)).mode & 0o777).toBe(0o600);
    await core.close();
    expect(existsSync(canvasPath)).toBe(false);
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
