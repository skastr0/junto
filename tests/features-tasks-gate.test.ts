import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import { resolveBuildFeatures } from "../scripts/build-features";
import { TASKS_ENABLED } from "../src/shared/features";
import { contractOf, canvasDocToCapabilityView, pairIsClaimable } from "../src/shared/physics";
import { isClaimableTaskSink } from "../src/shared/factory-tick";
import {
  admitWorkTarget,
  opsForKind,
} from "../src/main/vellum-command/work/authz";
import { DEFAULT_NODE_CATALOG_ENTRIES } from "../src/renderer/components/node-palette/NodeCatalogGrid";
import { makeTasksNode } from "../src/renderer/lib/node-factories";
import {
  allExamples,
  allSchemas,
  commandCapabilities,
} from "../src/cli/core/discovery";
import { OVERSEER_CATALOG } from "../src/shared/overseer-control";
import { NODE_DOCS } from "../src/shared/vellum-docs";

/**
 * Task-surface product gate. The Tasks node, its CLI group, and the
 * task-scoped content access leave the product together while historical task
 * rows stay decodable and inert.
 */

const catalogIds = (): ReadonlyArray<string> =>
  DEFAULT_NODE_CATALOG_ENTRIES.map((entry) => entry.id);

/** Command ids owned by the tasks surface. */
const taskCommand = (commandId: string): boolean =>
  commandId.startsWith("tasks.") || commandId.startsWith("content.");

/** A seat with a `works` edge to a task board, the shape the factory resolves. */
const wiredTaskBoard = (): CanvasDoc =>
  ({
    nodes: [
      {
        id: "agent-1",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        text: "seat",
        ether: { entity: { kind: "agent", name: "seat" } },
      },
      {
        id: "task-1",
        type: "text",
        x: 200,
        y: 0,
        width: 100,
        height: 40,
        text: "tasks",
        ether: {
          entity: { kind: "task", name: "tasks" },
          host: "local",
          tasks: { items: [] },
        },
      },
    ],
    edges: [
      { id: "edge-1", fromNode: "task-1", toNode: "agent-1", ether: { verb: "works" } },
    ],
  }) as CanvasDoc;

const taskNodeOf = (doc: CanvasDoc) => doc.nodes[1]!;

describe("task-surface product gates", () => {
  it("defaults the tasks gate off in the ship profile", () => {
    expect(resolveBuildFeatures({}).features.tasks).toBe(false);
  });

  it.runIf(!TASKS_ENABLED)(
    "removes authoring, wires, claims, work ops, discovery, overseer, and docs",
    () => {
      expect(catalogIds()).not.toContain("tasks");
      expect(opsForKind("task")).toEqual([]);
      expect(contractOf("task")?.ports ?? []).toEqual([]);
      expect(() => makeTasksNode(0, 0, "local")).toThrow(/disabled/u);

      const doc = wiredTaskBoard();
      // The factory tick finds no claimable sink without the offers.
      expect(isClaimableTaskSink(taskNodeOf(doc))).toBe(false);
      expect(pairIsClaimable(canvasDocToCapabilityView(doc), "task-1", "agent-1")).toBe(false);

      // The kernel refuses a wired seat with the build gate, not an edge.
      const denied = admitWorkTarget(doc, "agent-1", "task-1", "tasks.list");
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied)) {
        expect(denied.failure.message).toMatch(
          /disabled in this Vellum Command build/u,
        );
        expect(denied.failure.details?.missing).toBe(
          "feature enabled in this build",
        );
      }

      expect(allSchemas.filter((s) => taskCommand(s.command_id))).toEqual([]);
      expect(allExamples.filter((e) => taskCommand(e.command_id))).toEqual([]);
      expect(commandCapabilities.filter((c) => taskCommand(c.command_id))).toEqual([]);

      const families = OVERSEER_CATALOG.map((entry) => entry.family);
      expect(families).not.toContain("tasks");
      expect(families).not.toContain("content");
      expect(NODE_DOCS.some((doc) => doc.kind === "task")).toBe(false);

      const ipc = readFileSync("src/main/vellum-command/ipc.ts", "utf8");
      expect(ipc).toContain("if (TASKS_ENABLED) privilegedIpc.handle(");
      const preload = readFileSync("src/preload/index.ts", "utf8");
      expect(preload).toContain("...(TASKS_ENABLED ? taskWorkApi : {})");
      const cli = readFileSync("src/cli/main.ts", "utf8");
      expect(cli).toContain('if (!TASKS_ENABLED && group === "tasks")');

      for (const group of ["tasks", "content"]) {
        const runtime = spawnSync(
          "bun",
          ["src/cli/main.ts", group, "smoke"],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        expect(runtime.status, `${group} should refuse`).toBe(2);
        expect(runtime.stderr).toContain(
          "disabled in this Vellum Command build",
        );
      }
    },
  );

  it.runIf(TASKS_ENABLED)("restores the tasks surface in the all-on profile", () => {
    expect(catalogIds()).toContain("tasks");
    expect(opsForKind("task").length).toBeGreaterThan(0);
    expect((contractOf("task")?.ports ?? []).length).toBeGreaterThan(0);

    const doc = wiredTaskBoard();
    expect(isClaimableTaskSink(taskNodeOf(doc))).toBe(true);
    expect(pairIsClaimable(canvasDocToCapabilityView(doc), "task-1", "agent-1")).toBe(true);

    const admitted = admitWorkTarget(doc, "agent-1", "task-1", "tasks.list");
    expect(Result.isSuccess(admitted)).toBe(true);

    expect(allSchemas.some((s) => s.command_id === "tasks.list")).toBe(true);
    expect(
      allExamples.some((e) => e.command_id === "tasks.create"),
    ).toBe(true);
    expect(
      commandCapabilities.some((c) => c.command_id === "tasks.claim"),
    ).toBe(true);
    expect(
      OVERSEER_CATALOG.some((entry) => entry.family === "tasks"),
    ).toBe(true);
    expect(NODE_DOCS.some((doc) => doc.kind === "task")).toBe(true);
  });
});
