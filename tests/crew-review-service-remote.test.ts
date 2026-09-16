import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Result, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import type { MailSenderStamp } from "../src/shared/crew";
import { InstallationId } from "../src/shared/installation-id";
import {
  ConfigureRequest, LogicalSequence, PairRequest, ProjectRequest,
  STATION_API_PROTOCOL, StationHostId,
} from "../src/shared/station-api";
import { IntentFactBasis } from "../src/shared/work-protocol";
import type { CompletionEvidence } from "../src/shared/work-model";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { makeSettingsLive } from "../src/main/vellum-command/settings/service";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum-command/state/engine";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { compileStationPortfolioBody } from "../src/main/vellum-command/station/portfolio";
import {
  StationRepository, StationRepositoryLive, stationProjectionContentSha256,
} from "../src/main/vellum-command/station/repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { CrewRepositoryLive } from "../src/main/vellum-command/work/crew-repository";
import {
  createCurrentProjectedTaskDependencyScopeCapability,
  WorkRepository, WorkRepositoryLive,
} from "../src/main/vellum-command/work/repository";
import { WorkLive, WorkService, type WorkOpResult } from "../src/main/vellum-command/work/service";

const root = join(tmpdir(), `vellum-command-crew-review-remote-${randomUUID()}`);
const repositories = Layer.provideMerge(
  Layer.mergeAll(
    WorkRepositoryLive, CrewRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive,
    makeSettingsLive({ ensureDefaultCommandCenter: false }),
    makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ),
  Layer.mergeAll(
    makeStateEngineLive(join(root, "junto.db")),
    makeInstallOpsLive(join(root, "install-ops.db")),
  ),
);
const runtime = ManagedRuntime.make(Layer.provideMerge(
  WorkLive,
  Layer.mergeAll(Layer.provideMerge(CanvasesLive, repositories), StationLivePeerRegistryLive),
));

const hostId = Schema.decodeUnknownSync(StationHostId)("crew-test-remote");
const commandCenter = Schema.decodeUnknownSync(InstallationId)("crew-test-command-center");
const sequence = Schema.decodeUnknownSync(LogicalSequence);
const PLAIN_CANVAS = "crew-remote-ordinary";
const REVIEW_CANVAS = "crew-remote-review";
const RULE = "requires-independent-review";
const SHA = "c".repeat(40);

const projectedDoc = (canvas: string, requiresReview: boolean): CanvasDoc => Result.getOrThrow(decodeCanvasDoc({
  nodes: [
    ...["author", "reviewer"].map((id) => ({
      id, type: "text" as const, text: id, x: 0, y: 0, width: 200, height: 100,
      ether: {
        entity: { kind: "agent", name: `${hostId}:${canvas}-${id}` },
        host: hostId,
        terminal: {
          bindingId: `${canvas}-${id}`,
          launch: { kind: "harness" as const, argv: ["claude"] },
          harness: "claude" as const,
        },
      },
    })),
    {
      id: "tasks", type: "text", text: "tasks", x: 400, y: 0, width: 200, height: 100,
      ether: {
        entity: { kind: "task" }, host: hostId,
        tasks: {
          items: [],
          contract: {
            incoming: { admission: "auto" },
            ...(requiresReview ? {
              rules: [{ id: RULE, text: "Independent review is green", kind: "requires-review" as const }],
            } : {}),
          },
        },
      },
    },
  ],
  edges: [
    { id: "claim", fromNode: "tasks", toNode: "author", ether: { verb: "works" } },
    { id: "review", fromNode: "reviewer", toNode: "author", ether: { verb: "reviews" } },
  ],
}));

let work: Context.Service.Shape<typeof WorkService>;
let canvases: Context.Service.Shape<typeof CanvasesService>;
let repository: Context.Service.Shape<typeof WorkRepository>;
let station: Context.Service.Shape<typeof StationRepository>;
let state: Context.Service.Shape<typeof StateEngine>;
let local: typeof InstallationId.Type;

beforeAll(async () => {
  station = await runtime.runPromise(StationRepository);
  local = await runtime.runPromise(station.installationId);
  await runtime.runPromise(station.pair(PairRequest.make({
    protocol: STATION_API_PROTOCOL, op: "pair", commandCenterInstallationId: commandCenter,
    stationInstallationId: local, stationLabel: "Crew test Remote", appVersion: "test",
  })));
  await runtime.runPromise(station.configureRemote(ConfigureRequest.make({
    protocol: STATION_API_PROTOCOL, op: "configure", installationId: local,
    configuration: {
      role: "remote", hostId, agentHostId: hostId,
      commandCenterInstallationId: commandCenter, supervisedPreferred: true,
    },
    host: { id: hostId, label: "Crew test Remote", kind: "remote", capabilities: ["terminal"] },
  })));
  const body = compileStationPortfolioBody(new Map([
    [PLAIN_CANVAS, projectedDoc(PLAIN_CANVAS, false)],
    [REVIEW_CANVAS, projectedDoc(REVIEW_CANVAS, true)],
  ]), new Map([[hostId, local]]));
  await runtime.runPromise(station.installProjection(ProjectRequest.make({
    protocol: STATION_API_PROTOCOL, op: "project", stationInstallationId: local,
    projection: {
      scope: "full", generation: sequence("1"), sourceCanvasGeneration: sequence("1"),
      sourceIntentSha256: stationProjectionContentSha256("crew Remote review source"),
      body, contentSha256: stationProjectionContentSha256(body), createdAt: "2026-09-15T00:00:00.000Z",
    },
  })));
  work = await runtime.runPromise(WorkService);
  canvases = await runtime.runPromise(CanvasesService);
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
  expect((await runtime.runPromise(station.configuration))?.configuration.role).toBe("remote");
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const applied = <T>(result: WorkOpResult<T>): T => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.disposition).toBe("applied");
  return result.data;
};

const claimedTask = async (canvas: string) => {
  const read = await runtime.runPromise(canvases.read(canvas));
  const author = read.actorRefs.find((actor) => actor.nodeId === "author");
  if (author === undefined) throw new Error("Missing projected Remote author");
  const projection = await runtime.runPromise(station.projection);
  if (projection === undefined) throw new Error("Missing Remote projection");
  const witness = await runtime.runPromise(canvases.activeIntentWitness());
  const basis = Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
    kind: "projected-intent", ...witness,
  });
  const sink = { canvasName: canvas, nodeId: "tasks" };
  const dependencyScope = createCurrentProjectedTaskDependencyScopeCapability({
    rawBody: projection.body, generation: projection.generation,
    contentSha256: projection.contentSha256, authoringSink: sink,
  });
  const taskId = `${canvas}-task`;
  await runtime.runPromise(repository.createTask({
    sink, basis, dependencyScope,
    task: {
      id: taskId, state: "submitted", admission: "auto", metadata: { details: "Prove Remote task behavior" },
      history: [{
        messageId: `${taskId}-brief`, role: "agent", taskId, contextId: canvas,
        parts: [{ kind: "text", text: "Review Remote task behavior" }],
      }],
    },
  }));
  await runtime.runPromise(repository.claimLocalTask({ sink, taskId, actor: author, basis, dependencyScope }));
  expect(await runtime.runPromise(work.workTaskHome(canvas, "tasks", taskId))).toBe(local);
  const snapshot = async () => {
    const rows = await runtime.runPromise(repository.readSnapshot(canvas, "tasks"));
    const task = rows.tasks.items.find((item) => item.id === taskId);
    if (task === undefined) throw new Error("Missing Remote task");
    return task;
  };
  const sender: MailSenderStamp = {
    fromSeat: author.seatId, senderNodeId: author.nodeId,
    senderGeneration: "remote-test-generation", senderHarness: "claude",
  };
  const durableCounts = () => runtime.runPromise(state.read("test.crew-remote-counts", (reader) => ({
    facts: reader.get<{ count: number }>("SELECT count(*) AS count FROM work_facts")!.count,
    events: reader.get<{ count: number }>("SELECT count(*) AS count FROM work_events")!.count,
    commands: reader.get<{ count: number }>("SELECT count(*) AS count FROM work_commands")!.count,
    receipts: reader.get<{ count: number }>("SELECT count(*) AS count FROM work_review_receipts")!.count,
    messages: reader.get<{ count: number }>("SELECT count(*) AS count FROM work_messages")!.count,
  })));
  return { canvas, taskId, author, sender, snapshot, durableCounts };
};

describe("crew review boundaries on a real projected Remote", () => {
  it("preserves ordinary Remote updates and completion without creating review mail", async () => {
    const f = await claimedTask(PLAIN_CANVAS);
    const evidence: CompletionEvidence = { artifacts: [], git: { commits: [SHA] } };
    const updated = applied(await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "working", "Commit ready", evidence, undefined, f.sender,
    )));
    expect(updated).toMatchObject({ state: "working", claimedBy: f.author.seatId, completionEvidence: evidence });
    expect(await f.snapshot()).toMatchObject({ state: "working", completionEvidence: evidence });
    const completed = applied(await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "completed", undefined, evidence, undefined, f.sender,
    )));
    expect(completed).toMatchObject({ state: "completed", completionEvidence: evidence });
    expect(await f.snapshot()).toMatchObject({ state: "completed", completionEvidence: evidence });
    expect(await f.durableCounts()).toMatchObject({ receipts: 0, messages: 0, commands: 0 });
    expect((await runtime.runPromise(repository.readSnapshot(f.canvas, "reviewer"))).messages.items).toEqual([]);
  });

  it("refuses requires-review Remote completion before mutating local work", async () => {
    const f = await claimedTask(REVIEW_CANVAS);
    const evidence: CompletionEvidence = {
      artifacts: [], git: { commits: [SHA] },
      claims: [{ ruleId: RULE, text: "The ordinary rule answer is supplied" }],
    };
    applied(await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "working", undefined, evidence, undefined, f.sender,
    )));
    const before = await f.snapshot();
    const counts = await f.durableCounts();
    const refused = await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "completed", undefined, evidence, undefined, f.sender,
    ));
    expect(refused).toMatchObject({
      ok: false, code: "scope_error", details: { reason: "crew-command-center-only", retryable: false },
    });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.durableCounts()).toEqual(counts);
    expect(counts).toMatchObject({ receipts: 0, messages: 0, commands: 0 });
  });
});
