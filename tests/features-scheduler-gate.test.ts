import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CRON_ENABLED,
  RELAY_ENABLED,
  TASKS_ENABLED,
} from "../src/shared/features";
import {
  DEFAULT_NODE_CATALOG_ENTRIES,
  catalogWireLines,
} from "../src/renderer/components/node-palette/NodeCatalogGrid";
import { opsForKind } from "../src/main/vellum-command/work/authz";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __setDocsForTest,
  manualSchedulerFire,
} from "../src/main/vellum-command/kernel/cycle";

const catalogIds = (): ReadonlyArray<string> =>
  DEFAULT_NODE_CATALOG_ENTRIES.map((entry) => entry.id);

describe("scheduler product gates", () => {
  it.runIf(!CRON_ENABLED && !RELAY_ENABLED)(
    "removes scheduler authoring, copy, capability discovery, and IPC in ship builds",
    () => {
      expect(catalogIds()).not.toContain("cron");
      expect(catalogIds()).not.toContain("relay");
      // The tasks gate owns its wire lines; the scheduler gate only removes
      // watch and effect here.
      expect(catalogWireLines("tasks").map((line) => line.family)).toEqual(
        TASKS_ENABLED ? ["access"] : [],
      );
      expect(opsForKind("relay")).toEqual([]);

      const preload = readFileSync("src/preload/index.ts", "utf8");
      const main = readFileSync("src/main/vellum-command/ipc.ts", "utf8");
      const cycle = readFileSync("src/main/vellum-command/kernel/cycle.ts", "utf8");
      expect(preload).toContain(
        "...(CRON_ENABLED || RELAY_ENABLED ? schedulerApi : {})",
      );
      expect(main).toContain(
        "if (CRON_ENABLED || RELAY_ENABLED) privilegedIpc.handle(",
      );
      expect(cycle).toContain("if (!RELAY_ENABLED) continue;");
      expect(cycle).toContain("if (!CRON_ENABLED) {");
    },
  );

  it.runIf(!CRON_ENABLED && !RELAY_ENABLED)(
    "refuses execution for decoded historical scheduler nodes",
    async () => {
      const doc = {
        nodes: [
          {
            id: "old-cron",
            type: "text",
            x: 0,
            y: 0,
            width: 220,
            height: 84,
            text: "old cron",
            ether: { entity: { kind: "cron", name: "old cron" } },
          },
        ],
        edges: [],
      } as CanvasDoc;
      __setDocsForTest(new Map([["board", doc]]));

      await expect(
        manualSchedulerFire({
          canvasName: "board",
          sourceNodeId: "old-cron",
        }),
      ).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/disabled/u) });
    },
  );

  it.runIf(CRON_ENABLED && RELAY_ENABLED)(
    "restores each scheduler surface independently in the all-on profile",
    () => {
      expect(catalogIds()).toContain("cron");
      expect(catalogIds()).toContain("relay");
      expect(catalogWireLines("tasks").map((line) => line.family)).toEqual([
        "access",
        "watch",
        "effect",
      ]);
      expect(opsForKind("relay")).toEqual(["relay.trigger"]);
    },
  );
});
