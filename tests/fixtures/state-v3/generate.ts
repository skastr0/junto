/**
 * Audit generator for the pre-retirement `escalates` fixture.
 *
 * Writes `escalates-v3.db`: a schema-v3 Command Center whose `factory` canvas
 * was authored while agent -> requests `escalates` was a legal verb. It holds
 * two escalates edges (one masked with the `request.escalate` port), an
 * agent -> agent `messages` edge whose mask also names that retired port, and
 * an unrelated `works` edge that must come through untouched.
 *
 * Never imported by the suite. It only runs against a tree where `escalates`
 * is still in the verb grammar (the commit before its retirement); the
 * migration test pins the committed bytes by SHA-256. To re-run, check out that
 * commit and execute it through a one-off vitest tool file:
 *
 *   import { it } from "vitest";
 *   import { generateEscalatesFixture } from "./fixtures/state-v3/generate";
 *   it("gen", () => generateEscalatesFixture("tests/fixtures/state-v3/escalates-v3.db"));
 *
 * with JUNTO_TEST_FEATURE_PROFILE=all-on.
 */
import { existsSync, unlinkSync } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { CanvasDoc } from "../../../src/shared/canvas";
import { CanvasesLive, CanvasesService } from "../../../src/main/junto/canvases";
import { makeStateEngineLive } from "../../../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../../../src/main/junto/work/repository";
import { StationRepositoryLive } from "../../../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../../../src/main/junto/station/fleet-target-repository";
import { SettingsLive } from "../../../src/main/junto/settings/service";

const agent = (id: string, bindingId: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 240,
  height: 72,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: {
      bindingId,
      launch: { kind: "harness", argv: ["codex"] },
      harness: "codex",
    },
    host: "local",
  },
});

const sink = (id: string, kind: string, x: number) => ({
  id,
  type: "text" as const,
  text: id,
  x,
  y: 200,
  width: 200,
  height: 80,
  ether: { entity: { kind } },
});

export const ESCALATES_FIXTURE_DOC = {
  nodes: [
    agent("agent", "fixture-escalates-agent"),
    agent("peer", "fixture-escalates-peer"),
    sink("tasks", "task", 0),
    sink("requests", "requests", 300),
    sink("requests-2", "requests", 600),
  ],
  edges: [
    { id: "claim-edge", fromNode: "agent", toNode: "tasks", ether: { verb: "works" } },
    { id: "raise", fromNode: "agent", toNode: "requests", ether: { verb: "escalates" } },
    {
      id: "raise-masked",
      fromNode: "peer",
      toNode: "requests-2",
      label: "ask the operator",
      ether: { verb: "escalates", mask: ["request.escalate", "msg.list"] },
    },
    {
      id: "mail",
      fromNode: "agent",
      toNode: "peer",
      ether: { verb: "messages", mask: ["msg.send", "request.escalate"] },
    },
  ],
} as unknown as CanvasDoc;

export const generateEscalatesFixture = async (path: string): Promise<void> => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
  }
  const state = makeStateEngineLive(path);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      CanvasesLive,
      Layer.provideMerge(
        Layer.mergeAll(
          WorkRepositoryLive,
          StationRepositoryLive,
          StationFleetTargetRepositoryLive,
          SettingsLive,
        ),
        state,
      ),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        yield* canvases.create("factory");
        yield* canvases.write("factory", ESCALATES_FIXTURE_DOC);
      }),
    );
  } finally {
    await runtime.dispose();
  }
};
