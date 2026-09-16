import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import {
  LogicalSequence,
  ProjectRequest,
  ProjectResponse,
  STATION_API_PROTOCOL,
  StationSha256,
  type ProjectRequest as ProjectRequestValue,
  type ProjectionInstallDecision,
} from "../src/shared/station-api";
import {
  installProjectionAndNotify,
  projectionCanvasChanges,
} from "../src/main/junto/station/api";
import { compileStationPortfolioBody } from "../src/main/junto/station/portfolio";
import { stationProjectionContentSha256 } from "../src/main/junto/station/repository";

const installationId = Schema.decodeUnknownSync(InstallationId)("remote-installation");
const sequence = Schema.decodeUnknownSync(LogicalSequence);
const sha256 = Schema.decodeUnknownSync(StationSha256);

const canvas = (overseer: boolean, note = "stable"): CanvasDoc => ({
  nodes: [
    {
      id: "seat",
      type: "text",
      text: "Builder",
      x: 0,
      y: 0,
      width: 220,
      height: 100,
      ether: {
        entity: { kind: "agent", name: "studio:builder" },
        ...(overseer ? { overseer: true } : {}),
        terminal: { bindingId: "seat-1", harness: "codex" },
        host: "studio",
      },
    },
    {
      id: "note",
      type: "text",
      text: note,
      x: 300,
      y: 0,
      width: 180,
      height: 80,
    },
  ],
  edges: [],
});

const request = (
  generation: string,
  documents: ReadonlyMap<string, CanvasDoc>,
): ProjectRequestValue => {
  const body = compileStationPortfolioBody(
    documents,
    new Map([["studio", installationId]]),
  );
  return ProjectRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "project",
    stationInstallationId: installationId,
    projection: {
      scope: "full",
      generation: sequence(generation),
      sourceCanvasGeneration: sequence(generation),
      sourceIntentSha256: sha256("a".repeat(64)),
      body,
      contentSha256: stationProjectionContentSha256(body),
      createdAt: "2026-09-11T09:00:00.000Z",
    },
  });
};

const response = (
  input: ProjectRequestValue,
  decision: ProjectionInstallDecision,
) => ProjectResponse.make({
  protocol: STATION_API_PROTOCOL,
  op: "project",
  stationInstallationId: installationId,
  decision,
  active: {
    generation: input.projection.generation,
    contentSha256: input.projection.contentSha256,
    receivedAt: "2026-09-11T09:00:01.000Z",
  },
});

describe("Station projection canvas change notifications", () => {
  it("retains actual off/on history across rapid projection commits", async () => {
    let current = new Map([["factory", canvas(true)]]);
    const announced: Array<ReturnType<typeof projectionCanvasChanges>> = [];
    const install = async (next: ReadonlyMap<string, CanvasDoc>, generation: string) => {
      const incoming = request(generation, next);
      await Effect.runPromise(installProjectionAndNotify(incoming, {
        currentDocuments: () => Effect.succeed(
          [...current].map(([canvasName, doc]) => ({ canvasName, doc })),
        ),
        install: () => Effect.sync(() => {
          current = new Map(next);
          return response(incoming, "install");
        }),
        announce: (changes) => announced.push(changes),
      }));
    };

    await install(new Map([["factory", canvas(false)]]), "2");
    await install(new Map([["factory", canvas(true)]]), "3");

    expect(announced).toHaveLength(2);
    expect(announced[0]?.[0]?.detail.previous?.nodes[0]?.ether?.overseer).toBe(true);
    expect(announced[0]?.[0]?.detail.next?.nodes[0]?.ether?.overseer).toBeUndefined();
    expect(announced[1]?.[0]?.detail.previous?.nodes[0]?.ether?.overseer).toBeUndefined();
    expect(announced[1]?.[0]?.detail.next?.nodes[0]?.ether?.overseer).toBe(true);
  });

  it("carries an unchanged seat grant through an otherwise changed canvas", () => {
    const previous = canvas(true, "before");
    const next = canvas(true, "after");

    const changes = projectionCanvasChanges(
      [{ canvasName: "factory", doc: previous }],
      new Map([["factory", next]]),
    );

    expect(changes).toEqual([{
      name: "factory",
      detail: { previous, next },
    }]);
    expect(changes[0]?.detail.previous?.nodes[0]?.ether?.overseer).toBe(true);
    expect(changes[0]?.detail.next?.nodes[0]?.ether?.overseer).toBe(true);
  });

  it("emits added and removed canvases while skipping unchanged canvases", () => {
    const stable = canvas(true);
    const removed = canvas(false);
    const added = canvas(false, "added");

    expect(projectionCanvasChanges(
      [
        { canvasName: "removed", doc: removed },
        { canvasName: "stable", doc: stable },
      ],
      new Map([
        ["added", added],
        ["stable", stable],
      ]),
    )).toEqual([
      {
        name: "added",
        detail: { previous: undefined, next: added },
      },
      {
        name: "removed",
        detail: { previous: removed, next: undefined },
      },
    ]);
  });

  it("emits nothing when projection installation fails or is not a commit", async () => {
    const incoming = request("2", new Map([["factory", canvas(false)]]));
    const announce = vi.fn();
    await expect(Effect.runPromise(installProjectionAndNotify(incoming, {
      currentDocuments: () => Effect.succeed([
        { canvasName: "factory", doc: canvas(true) },
      ]),
      install: () => Effect.fail("install failed"),
      announce,
    }))).rejects.toBe("install failed");
    expect(announce).not.toHaveBeenCalled();

    await Effect.runPromise(installProjectionAndNotify(incoming, {
      currentDocuments: () => Effect.succeed([
        { canvasName: "factory", doc: canvas(true) },
      ]),
      install: () => Effect.succeed(response(incoming, "idempotent")),
      announce,
    }));
    expect(announce).not.toHaveBeenCalled();
  });
});
