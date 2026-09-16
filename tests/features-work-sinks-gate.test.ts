import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import { resolveBuildFeatures } from "../scripts/build-features";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  PAD_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
} from "../src/shared/features";
import { contractOf } from "../src/shared/physics";
import {
  admitWorkTarget,
  opsForKind,
} from "../src/main/vellum-command/work/authz";
import { DEFAULT_NODE_CATALOG_ENTRIES } from "../src/renderer/components/node-palette/NodeCatalogGrid";
import {
  makeArtifactsNode,
  makeBoardNode,
  makePadNode,
  makeRequestsNode,
  makeSheetNode,
} from "../src/renderer/lib/node-factories";
import {
  allExamples,
  allSchemas,
  annotateCapabilityInvocations,
  commandCapabilities,
} from "../src/cli/core/discovery";
import {
  liveSeatBlock,
  markSeatBlocked,
  resetSeatBlocks,
} from "../src/main/vellum-command/work/blocked-seat";

/**
 * Product gates for the work-sink extras: Board, Pad, Sheet, Requests, and
 * Artifacts. Each one owns a node kind, its edge ports, and a CLI command
 * group; the gate must close all three together, in both directions:
 * absent when off (ship), present when on (all-on).
 */

const GATED_KINDS = ["board", "pad", "sheet", "requests", "artifacts"] as const;

const catalogIds = (): ReadonlyArray<string> =>
  DEFAULT_NODE_CATALOG_ENTRIES.map((entry) => entry.id);

/** Command ids owned by the gated surfaces. */
const gatedCommand = (commandId: string): boolean =>
  commandId.startsWith("board.") ||
  commandId.startsWith("pad.") ||
  commandId === "sheet.read" ||
  commandId.startsWith("request.") ||
  commandId.startsWith("artifact.");

const ALL_GATED_OFF =
  !BOARD_ENABLED &&
  !PAD_ENABLED &&
  !SHEET_ENABLED &&
  !REQUESTS_ENABLED &&
  !ARTIFACTS_ENABLED;

const ALL_GATED_ON =
  BOARD_ENABLED &&
  PAD_ENABLED &&
  SHEET_ENABLED &&
  REQUESTS_ENABLED &&
  ARTIFACTS_ENABLED;

/** A seat wired to a board, the shape every capability surface resolves. */
const wiredAgentBoard = (verb: "participates" | "messages"): CanvasDoc =>
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
        id: "board-1",
        type: "text",
        x: 200,
        y: 0,
        width: 100,
        height: 40,
        text: "board",
        ether: { entity: { kind: "board", name: "board" } },
      },
    ],
    edges: [
      { id: "edge-1", fromNode: "agent-1", toNode: "board-1", ether: { verb } },
    ],
  }) as CanvasDoc;

describe("work-sink product gates", () => {
  it("defaults every work-sink gate off in the ship profile", () => {
    const features = resolveBuildFeatures({}).features;
    expect(features.board).toBe(false);
    expect(features.pad).toBe(false);
    expect(features.sheet).toBe(false);
    expect(features.requests).toBe(false);
    expect(features.artifacts).toBe(false);
    expect(features.browser).toBe(false);
  });

  it.runIf(ALL_GATED_OFF)(
    "releases the requests stop plane instead of stranding the seat",
    () => {
      markSeatBlocked({
        canvasName: "gate",
        nodeId: "agent-1",
        requestId: "r1",
        target: "requests-1",
        brief: "need an answer",
      });
      const doc = {
        nodes: [
          {
            id: "requests-1",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            text: "requests",
            ether: {
              entity: { kind: "requests" },
              requests: {
                items: [{ id: "r1", state: "input-required", history: [] }],
              },
            },
          },
        ],
        edges: [],
      } as unknown as CanvasDoc;
      expect(liveSeatBlock("gate", "agent-1", doc)).toBeUndefined();
      resetSeatBlocks();
    },
  );

  it.runIf(ALL_GATED_OFF)(
    "removes authoring, wires, work ops, discovery, and CLI dispatch",
    () => {
      for (const kind of GATED_KINDS) {
        expect(catalogIds()).not.toContain(kind);
        expect(opsForKind(kind)).toEqual([]);
        expect(contractOf(kind)?.ports ?? []).toEqual([]);
      }

      // Authoring constructors throw too: no side door can mint the node.
      expect(() => makeRequestsNode(0, 0)).toThrow(/disabled/u);
      expect(() => makeArtifactsNode(0, 0)).toThrow(/disabled/u);
      expect(() => makeBoardNode(0, 0)).toThrow(/disabled/u);
      expect(() => makePadNode(0, 0)).toThrow(/disabled/u);
      expect(() => makeSheetNode(0, 0)).toThrow(/disabled/u);

      // The kernel refuses a wired seat: the edge survives, the capability
      // does not, and the error names the build gate rather than an edge.
      const denied = admitWorkTarget(
        wiredAgentBoard("participates"),
        "agent-1",
        "board-1",
        "board.list",
      );
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied)) {
        expect(denied.failure.message).toMatch(
          /disabled in this Vellum Command build/u,
        );
        expect(denied.failure.details?.missing).toBe(
          "feature enabled in this build",
        );
      }

      expect(allSchemas.filter((s) => gatedCommand(s.command_id))).toEqual([]);
      expect(allExamples.filter((e) => gatedCommand(e.command_id))).toEqual([]);
      expect(commandCapabilities.filter((c) => gatedCommand(c.command_id))).toEqual([]);

      // Even a hand-crafted daemon reply cannot re-advertise the CLI path.
      const annotated = annotateCapabilityInvocations({
        connected: [
          {
            id: "pad-1",
            kind: "pad",
            title: "pad",
            grants: ["pad.read", "pad.patch", "sheet.read"],
          },
        ],
      }) as { connected: ReadonlyArray<{ invocations?: unknown }> };
      expect(annotated.connected[0]?.invocations ?? []).toEqual([]);

      const canvas = readFileSync("src/renderer/components/Canvas.tsx", "utf8");
      expect(canvas).toContain("addBoard: () => {\n    if (!BOARD_ENABLED) return;");
      expect(canvas).toContain("addPad: () => {\n    if (!PAD_ENABLED) return;");
      expect(canvas).toContain("addSheet: () => {\n    if (!SHEET_ENABLED) return;");
      const edgeMutations = readFileSync(
        "src/renderer/lib/edge-mutations.ts",
        "utf8",
      );
      expect(edgeMutations).toContain("productNodeKindEnabled");
      const kinds = readFileSync("src/shared/physics/kinds.ts", "utf8");
      expect(kinds).toContain("BOARD_ENABLED");
      expect(kinds).toContain("PAD_ENABLED");
      expect(kinds).toContain("SHEET_ENABLED");
      expect(kinds).toContain("REQUESTS_ENABLED");
      expect(kinds).toContain("ARTIFACTS_ENABLED");
      const ipc = readFileSync("src/main/vellum-command/ipc.ts", "utf8");
      expect(ipc).toContain("if (BOARD_ENABLED) privilegedIpc.handle(");
      expect(ipc).toContain("if (PAD_ENABLED) privilegedIpc.handle(");
      expect(ipc).toContain("if (ARTIFACTS_ENABLED) privilegedIpc.handle(");
      expect(ipc).toContain("if (REQUESTS_ENABLED) privilegedIpc.handle(");
      const cli = readFileSync("src/cli/main.ts", "utf8");
      expect(cli).toContain("disabledCliGroup");

      for (const group of ["board", "pad", "sheet", "escalate", "artifact"]) {
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

  it.runIf(ALL_GATED_ON)(
    "restores every work sink in the all-on profile",
    () => {
      for (const kind of GATED_KINDS) {
        expect(catalogIds()).toContain(kind);
        expect(opsForKind(kind).length).toBeGreaterThan(0);
        expect((contractOf(kind)?.ports ?? []).length).toBeGreaterThan(0);
      }

      const admitted = admitWorkTarget(
        wiredAgentBoard("participates"),
        "agent-1",
        "board-1",
        "board.list",
      );
      expect(Result.isSuccess(admitted)).toBe(true);

      expect(allSchemas.some((s) => s.command_id === "board.list")).toBe(true);
      expect(allSchemas.some((s) => s.command_id === "pad.read")).toBe(true);
      expect(allSchemas.some((s) => s.command_id === "sheet.read")).toBe(true);
      expect(
        allExamples.some((e) => e.command_id === "artifact.publish"),
      ).toBe(true);
      expect(
        commandCapabilities.some((c) => c.command_id === "pad.patch"),
      ).toBe(true);
    },
  );
});
