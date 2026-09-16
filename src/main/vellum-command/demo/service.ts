/**
 * Demo registry: the EDL writer the renderer-side conductor drives. Only
 * reachable outside demo mode via the ipc.ts gate — this module has no flag
 * check of its own so tests can exercise it directly.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolveJuntoHome } from "@shared/junto-home";
import { join } from "node:path";
import type { DemoEdl, DemoWriteEdlResult } from "@shared/demo";

export const writeDemoEdl = async (edl: DemoEdl): Promise<DemoWriteEdlResult> => {
  try {
    const dir = join(resolveJuntoHome(), ".junto", "demo");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `edl-${edl.scenarioId}-${edl.startedAtEpochMs}.json`);
    await writeFile(path, JSON.stringify(edl, null, 2), "utf8");
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
