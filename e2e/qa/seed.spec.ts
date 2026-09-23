/**
 * Seeds the registry scene into a throwaway HOME's junto.db for the packaged
 * app tiers (qa:t1, qa:explore). Runs under Playwright only because the
 * fixture writer needs node:sqlite and the Babel transform; it launches
 * nothing. The seeded database is the same one the packaged app opens when
 * started with HOME and JUNTO_HOME pointed at QA_SEED_HOME.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "@playwright/test";
import { writeFixtureCanvas, type Sandbox } from "../harness/sandbox";
import { QA_CANVAS, qaScene } from "./registry";

const home = process.env.QA_SEED_HOME;

test("seed the qa scene", async () => {
  test.skip(!home, "run through qa:t1 or qa:explore, which set QA_SEED_HOME");
  const root = dirname(home!);
  const sandbox: Sandbox = {
    root,
    homeDir: home!,
    canvasesDir: join(home!, ".junto", "canvases"),
    userDataDir: join(root, "user-data"),
  };
  await mkdir(join(home!, ".junto", "state"), { recursive: true });
  await mkdir(sandbox.canvasesDir, { recursive: true });
  await writeFixtureCanvas(sandbox, QA_CANVAS, qaScene());
});
