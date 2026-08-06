import { Effect, Result, Schema } from "effect";
import {
  HostId,
  type HostId as HostIdValue,
} from "@shared/remote-hosts";
import {
  type OperatorErrorType,
  type OperatorQualificationWorkPrepareData,
  type OperatorQualificationWorkProgressData,
  type OperatorQualificationWorkRunArgs,
  type OperatorQualificationWorkTargetArgs,
  type OperatorQualificationWorkVerifyData,
} from "@shared/operator-control";
import {
  serializeCanvas,
  type CanvasDoc,
  type CanvasNode,
  type Task,
  type WorkMetadata,
} from "@shared/canvas";
import type { CanvasReadResult } from "@shared/ipc";
import type {
  InstallationId,
} from "@shared/installation-id";
import type {
  ActorRef,
  LogicalSequence,
} from "@shared/work-protocol";
import type { ReportRequest } from "@shared/station-api";
import {
  CanvasesService,
} from "../canvases";
import {
  deriveActorSeatId,
} from "../station/actor-seat-compiler";
import {
  StationApiService,
} from "../station/api";
import {
  StationFleetPropagation,
  type StationFleetPropagationResult,
} from "../station/fleet-propagation";
import {
  StationFleetTargetRepository,
} from "../station/fleet-target-repository";
import {
  StationRepository,
} from "../station/repository";
import {
  WorkService,
  type WorkOpResult,
} from "../work/service";

export const QUALIFICATION_WORK_PROTOCOL =
  "vellum-command/operator-qualification-work/v1" as const;
export const QUALIFICATION_WORK_MARKER_KEY =
  "vellumQualificationWork" as const;
export const QUALIFICATION_WORK_SINK_NODE_ID =
  "qualification-work-sink" as const;
export const QUALIFICATION_WORK_ACTOR_NODE_ID =
  "qualification-remote-actor" as const;
export const QUALIFICATION_WORK_ACTOR_BINDING_ID =
  "station-qualification-remote-v1" as const;
export const QUALIFICATION_WORK_EDGE_ID =
  "qualification-remote-to-work" as const;
export const QUALIFICATION_WORK_BRIEF =
  "Complete this Vellum Command Station qualification task while Command Center is offline." as const;
export const QUALIFICATION_WORK_COMPLETION_NOTE =
  "Completed the Vellum Command Station qualification task while Command Center was offline." as const;

export class OperatorQualificationWorkError extends Error {
  constructor(
    readonly type: OperatorErrorType,
    message: string,
  ) {
    super(message);
    this.name = "OperatorQualificationWorkError";
  }
}

const qualificationFailure = (
  type: OperatorErrorType,
  message: string,
): Effect.Effect<never, OperatorQualificationWorkError> =>
  Effect.fail(new OperatorQualificationWorkError(type, message));

export const qualificationCanvasName = (runId: string): string =>
  `station-qual-${runId}`;

const qualificationMarker = (
  runId: string,
  hostId: HostIdValue,
): WorkMetadata => ({
  // Required on every task create — brief doubles as description for this probe.
  details: QUALIFICATION_WORK_BRIEF,
  [QUALIFICATION_WORK_MARKER_KEY]: {
    protocol: QUALIFICATION_WORK_PROTOCOL,
    runId,
    hostId,
  },
});

export const qualificationWorkDocument = (
  runId: string,
  hostId: HostIdValue,
): CanvasDoc => {
  void runId;
  return {
    nodes: [
      {
        id: QUALIFICATION_WORK_SINK_NODE_ID,
        type: "text",
        x: 0,
        y: 0,
        width: 280,
        height: 100,
        text: "Station qualification work",
        ether: {
          entity: { kind: "task" },
          host: "local",
        },
      },
      {
        id: QUALIFICATION_WORK_ACTOR_NODE_ID,
        type: "text",
        x: 360,
        y: 0,
        width: 280,
        height: 100,
        text: "Remote qualification actor",
        ether: {
          entity: { kind: "agent", name: `${hostId}:codex` },
          host: hostId,
          terminal: {
            bindingId: QUALIFICATION_WORK_ACTOR_BINDING_ID,
            harness: "codex",
            launch: { kind: "harness", argv: ["codex"] },
          },
        },
      },
    ],
    edges: [
      {
        id: QUALIFICATION_WORK_EDGE_ID,
        fromNode: QUALIFICATION_WORK_ACTOR_NODE_ID,
        toNode: QUALIFICATION_WORK_SINK_NODE_ID,
        ether: {
          ports: ["tasks.claim"],
        },
      },
    ],
  };
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const markerRecord = (
  task: Task,
): Record<string, unknown> | undefined =>
  record(task.metadata?.[QUALIFICATION_WORK_MARKER_KEY]);

const isMarkerCandidate = (task: Task, runId: string): boolean => {
  const marker = markerRecord(task);
  return (
    marker?.protocol === QUALIFICATION_WORK_PROTOCOL &&
    marker.runId === runId
  );
};

const decodeHostId = Schema.decodeUnknownResult(HostId, {
  onExcessProperty: "error",
});

const exactMarkerHost = (
  task: Task,
  runId: string,
): Effect.Effect<HostIdValue, OperatorQualificationWorkError> => {
  const metadata = record(task.metadata);
  const marker = markerRecord(task);
  if (
    metadata === undefined ||
    !exactKeys(metadata, [QUALIFICATION_WORK_MARKER_KEY]) ||
    marker === undefined ||
    !exactKeys(marker, ["protocol", "runId", "hostId"]) ||
    marker.protocol !== QUALIFICATION_WORK_PROTOCOL ||
    marker.runId !== runId
  ) {
    return qualificationFailure(
      "conflict",
      "qualification task metadata does not exactly match the fixed marker",
    );
  }
  const hostId = decodeHostId(marker.hostId);
  return Result.isSuccess(hostId)
    ? Effect.succeed(hostId.success)
    : qualificationFailure(
      "conflict",
      "qualification task marker contains an invalid Remote host identity",
    );
};

const textMessageMatches = (
  task: Task,
  index: number,
  role: "user" | "agent",
  text: string,
  canvasName: string,
): boolean => {
  const message = task.history[index];
  return (
    message !== undefined &&
    message.role === role &&
    message.taskId === task.id &&
    message.contextId === canvasName &&
    message.parts.length === 1 &&
    message.parts[0]?.kind === "text" &&
    message.parts[0].text === text &&
    message.referenceTaskIds === undefined &&
    message.metadata === undefined
  );
};

const baseTaskMatches = (
  task: Task,
  runId: string,
  hostId: HostIdValue,
  canvasName: string,
): boolean =>
  task.reason === undefined &&
  task.response === undefined &&
  task.artifactIds === undefined &&
  textMessageMatches(
    task,
    0,
    "user",
    QUALIFICATION_WORK_BRIEF,
    canvasName,
  ) &&
  JSON.stringify(task.metadata) ===
    JSON.stringify(qualificationMarker(runId, hostId));

const taskMatchesSubmitted = (
  task: Task,
  runId: string,
  hostId: HostIdValue,
  canvasName: string,
): boolean =>
  baseTaskMatches(task, runId, hostId, canvasName) &&
  task.state === "submitted" &&
  task.claimedBy === undefined &&
  task.history.length === 1;

const taskMatchesWorking = (
  task: Task,
  actor: ActorRef,
  runId: string,
  hostId: HostIdValue,
  canvasName: string,
): boolean =>
  baseTaskMatches(task, runId, hostId, canvasName) &&
  task.state === "working" &&
  task.claimedBy === actor.seatId &&
  task.history.length === 1;

const taskMatchesCompleted = (
  task: Task,
  actor: ActorRef,
  runId: string,
  hostId: HostIdValue,
  canvasName: string,
): boolean =>
  baseTaskMatches(task, runId, hostId, canvasName) &&
  task.state === "completed" &&
  task.claimedBy === actor.seatId &&
  task.history.length === 2 &&
  textMessageMatches(
    task,
    1,
    "agent",
    QUALIFICATION_WORK_COMPLETION_NOTE,
    canvasName,
  );

const stripRuntimeWork = (
  node: CanvasNode,
): CanvasNode => {
  const ether = node.ether;
  if (ether === undefined) return node;
  const {
    tasks: _tasks,
    requests: _requests,
    messages: _messages,
    artifacts: _artifacts,
    ...authorial
  } = ether;
  return {
    ...node,
    ...(node.id === QUALIFICATION_WORK_SINK_NODE_ID
      ? { text: "Station qualification work" }
      : {}),
    ether: authorial,
  } as CanvasNode;
};

const projectionMatchesFixedDocument = (
  doc: CanvasDoc,
  runId: string,
  hostId: HostIdValue,
): boolean =>
  serializeCanvas({
    nodes: doc.nodes.map(stripRuntimeWork),
    edges: doc.edges,
  }) === serializeCanvas(qualificationWorkDocument(runId, hostId));

const requireExactlyOneMarkerTask = (
  doc: CanvasDoc,
  runId: string,
): Effect.Effect<
  { readonly task: Task; readonly hostId: HostIdValue },
  OperatorQualificationWorkError
> => {
  const sink = doc.nodes.filter(
    (node) => node.id === QUALIFICATION_WORK_SINK_NODE_ID,
  );
  if (
    sink.length !== 1 ||
    sink[0]?.ether?.entity?.kind !== "task"
  ) {
    return qualificationFailure(
      "conflict",
      "qualification canvas does not contain the exact fixed task sink",
    );
  }
  const candidates = (sink[0].ether.tasks?.items ?? []).filter((task) =>
    isMarkerCandidate(task, runId)
  );
  if (candidates.length === 0) {
    return qualificationFailure(
      "not_found",
      "qualification marker task does not exist",
    );
  }
  if (candidates.length !== 1) {
    return qualificationFailure(
      "conflict",
      "qualification canvas contains more than one marker task",
    );
  }
  const task = candidates[0]!;
  return exactMarkerHost(task, runId).pipe(
    Effect.map((hostId) => ({ task, hostId })),
  );
};

const requireActor = (
  actorRefs: ReadonlyArray<ActorRef>,
  canvasName: string,
  stationInstallationId: InstallationId,
): Effect.Effect<ActorRef, OperatorQualificationWorkError> => {
  const exact = actorRefs.filter(
    (actor) =>
      actor.canvasName === canvasName &&
      actor.nodeId === QUALIFICATION_WORK_ACTOR_NODE_ID,
  );
  if (exact.length !== 1) {
    return qualificationFailure(
      "conflict",
      "qualification canvas does not compile exactly one Remote actor reference",
    );
  }
  const actor = exact[0]!;
  if (
    actor.seatId !==
      deriveActorSeatId(
        stationInstallationId,
        QUALIFICATION_WORK_ACTOR_BINDING_ID,
      )
  ) {
    return qualificationFailure(
      "conflict",
      "qualification actor reference is not bound to the exact Remote installation",
    );
  }
  return Effect.succeed(actor);
};

const workResult = <A>(
  result: WorkOpResult<A>,
  operation: string,
): Effect.Effect<
  Extract<WorkOpResult<A>, { readonly ok: true }>,
  OperatorQualificationWorkError
> => {
  if (result.ok) return Effect.succeed(result);
  const type: OperatorErrorType =
    result.code === "task_not_found" ||
      result.code === "canvas_not_found" ||
      result.code === "node_not_found"
      ? "not_found"
      : result.code === "claim_contention" ||
          result.code === "illegal_transition"
        ? "conflict"
        : "validation";
  return qualificationFailure(
    type,
    `${operation} failed: ${result.message}`,
  );
};

const requireCommandCenter = Effect.gen(function* () {
  const stations = yield* StationRepository;
  const configuration = yield* stations.configuration;
  if (configuration?.configuration.role !== "command-center") {
    return yield* qualificationFailure(
      "forbidden",
      "qualification work prepare and verify require Command Center",
    );
  }
  const installationId = yield* stations.installationId;
  return {
    installationId,
    configuration: configuration.configuration,
  };
});

const requireRemote = Effect.gen(function* () {
  const stations = yield* StationRepository;
  const configuration = yield* stations.configuration;
  if (configuration?.configuration.role !== "remote") {
    return yield* qualificationFailure(
      "forbidden",
      "qualification offline progress requires a configured Remote",
    );
  }
  const installationId = yield* stations.installationId;
  return {
    installationId,
    configuration: configuration.configuration,
  };
});

const requireFleetTarget = (
  hostId: HostIdValue,
): Effect.Effect<
  {
    readonly hostId: HostIdValue;
    readonly stationInstallationId: InstallationId;
  },
  unknown,
  StationFleetTargetRepository
> =>
  Effect.gen(function* () {
    const targets = yield* StationFleetTargetRepository;
    const target = yield* targets.get(hostId);
    if (target === undefined) {
      return yield* qualificationFailure(
        "not_found",
        "qualification Remote is not an exact enrolled Station target",
      );
    }
    return target;
  });

const synchronizeExact = (
  hostId: HostIdValue,
  stationInstallationId: InstallationId,
): Effect.Effect<
  Extract<StationFleetPropagationResult, { readonly ok: true }>,
  unknown,
  StationFleetPropagation
> =>
  Effect.gen(function* () {
    const fleet = yield* StationFleetPropagation;
    const results = yield* fleet.synchronize(hostId);
    if (results.length !== 1) {
      return yield* qualificationFailure(
        "conflict",
        "qualification synchronization did not select exactly one Remote",
      );
    }
    const result = results[0]!;
    if (!result.ok) {
      return yield* qualificationFailure(
        "io",
        `qualification Remote synchronization failed: ${result.error.reason}`,
      );
    }
    if (result.stationInstallationId !== stationInstallationId) {
      return yield* qualificationFailure(
        "conflict",
        "qualification synchronization returned a different Remote installation",
      );
    }
    if (result.receipt.report.inboundRejected !== 0) {
      return yield* qualificationFailure(
        "conflict",
        "qualification synchronization rejected one or more Work records",
      );
    }
    if (
      result.receipt.remoteStatus.installationId !==
        stationInstallationId ||
      result.receipt.remoteStatus.configuration?.role !== "remote"
    ) {
      return yield* qualificationFailure(
        "conflict",
        "qualification synchronization did not prove the exact configured Remote",
      );
    }
    return result;
  });

const remoteCursor = (
  cursors: ReadonlyArray<{
    readonly eventHome: InstallationId;
    readonly entityHome: InstallationId;
    readonly through: LogicalSequence;
  }>,
  stationInstallationId: InstallationId,
): Effect.Effect<LogicalSequence, OperatorQualificationWorkError> => {
  const exact = cursors.filter(
    (cursor) =>
      cursor.eventHome === stationInstallationId &&
      cursor.entityHome === stationInstallationId,
  );
  return exact.length === 1
    ? Effect.succeed(exact[0]!.through)
    : qualificationFailure(
      "conflict",
      "qualification did not produce exactly one Remote-to-Remote Work cursor",
    );
};

const ensureQualificationCanvas = (
  runId: string,
  hostId: HostIdValue,
): Effect.Effect<
  void,
  unknown,
  CanvasesService
> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const name = qualificationCanvasName(runId);
    const expected = qualificationWorkDocument(runId, hostId);
    let authority = yield* canvases.authoritySnapshot();
    let existing = authority.documents.get(name);
    if (existing === undefined) {
      const created = yield* Effect.result(canvases.create(name));
      if (Result.isSuccess(created)) {
        yield* canvases.write(name, expected, created.success.revision);
      }
      authority = yield* canvases.authoritySnapshot();
      existing = authority.documents.get(name);
    }
    if (
      existing === undefined ||
      serializeCanvas(existing) !== serializeCanvas(expected)
    ) {
      return yield* qualificationFailure(
        "conflict",
        "qualification canvas already exists with different authorial intent",
      );
    }
  });

const readQualificationView = (
  runId: string,
): Effect.Effect<
  {
    readonly read: CanvasReadResult;
    readonly task: Task;
    readonly hostId: HostIdValue;
  },
  unknown,
  CanvasesService
> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const read = yield* canvases.read(qualificationCanvasName(runId));
    const marker = yield* requireExactlyOneMarkerTask(read.doc, runId);
    if (!projectionMatchesFixedDocument(read.doc, runId, marker.hostId)) {
      return yield* qualificationFailure(
        "conflict",
        "qualification projection differs from the fixed canvas",
      );
    }
    return { read, ...marker };
  });

const transitionCursor = (
  request: ReportRequest,
  stationInstallationId: InstallationId,
  taskId: string,
): Effect.Effect<LogicalSequence, OperatorQualificationWorkError> => {
  const exact = request.batch.records.filter(
    (record) =>
      record.recordType === "fact" &&
      record.operation === "task.transition" &&
      record.id.route.eventHome === stationInstallationId &&
      record.id.route.entityHome === stationInstallationId &&
      record.item.itemId === taskId &&
      record.body.operation === "task.transition" &&
      record.body.task.id === taskId &&
      record.body.task.state === "completed",
  );
  return exact.length === 1
    ? Effect.succeed(exact[0]!.id.seq)
    : qualificationFailure(
      "conflict",
      "offline progress did not expose exactly one completed Remote Work fact",
    );
};

export const qualificationWorkPrepareEffect = (
  args: OperatorQualificationWorkTargetArgs,
): Effect.Effect<
  OperatorQualificationWorkPrepareData,
  unknown,
  | CanvasesService
  | StationFleetPropagation
  | StationFleetTargetRepository
  | StationRepository
  | WorkService
> =>
  Effect.gen(function* () {
    const commandCenter = yield* requireCommandCenter;
    const target = yield* requireFleetTarget(args.hostId);
    yield* ensureQualificationCanvas(args.runId, args.hostId);
    yield* synchronizeExact(args.hostId, target.stationInstallationId);

    const canvases = yield* CanvasesService;
    const work = yield* WorkService;
    const stations = yield* StationRepository;
    const canvasName = qualificationCanvasName(args.runId);
    let read = yield* canvases.read(canvasName);
    const actor = yield* requireActor(
      read.actorRefs,
      canvasName,
      target.stationInstallationId,
    );
    const sink = read.doc.nodes.find(
      (node) => node.id === QUALIFICATION_WORK_SINK_NODE_ID,
    );
    const candidates = (sink?.ether?.tasks?.items ?? []).filter((task) =>
      isMarkerCandidate(task, args.runId)
    );
    let task: Task;
    let created = false;
    if (candidates.length === 0) {
      const result = yield* work.workTaskCreate(
        canvasName,
        QUALIFICATION_WORK_SINK_NODE_ID,
        QUALIFICATION_WORK_BRIEF,
        qualificationMarker(args.runId, args.hostId),
      );
      const admitted = yield* workResult(
        result,
        "qualification task creation",
      );
      if (admitted.disposition !== "applied") {
        return yield* qualificationFailure(
          "conflict",
          "qualification task was not created at Command Center",
        );
      }
      task = admitted.data;
      created = true;
    } else {
      if (candidates.length !== 1) {
        return yield* qualificationFailure(
          "conflict",
          "qualification canvas contains more than one marker task",
        );
      }
      task = candidates[0]!;
      const markerHost = yield* exactMarkerHost(task, args.runId);
      if (markerHost !== args.hostId) {
        return yield* qualificationFailure(
          "conflict",
          "qualification marker is bound to a different Remote host",
        );
      }
    }

    const beforeHome = yield* work.workTaskHome(
      canvasName,
      QUALIFICATION_WORK_SINK_NODE_ID,
      task.id,
    );
    let disposition: "prepared" | "idempotent";
    if (
      taskMatchesSubmitted(
        task,
        args.runId,
        args.hostId,
        canvasName,
      )
    ) {
      if (beforeHome !== commandCenter.installationId) {
        return yield* qualificationFailure(
          "conflict",
          "submitted qualification task is not homed at Command Center",
        );
      }
      const claim = yield* work.workTaskClaim(
        canvasName,
        QUALIFICATION_WORK_SINK_NODE_ID,
        task.id,
        actor,
      );
      const admitted = yield* workResult(
        claim,
        "qualification task claim",
      );
      if (admitted.disposition !== "queued") {
        return yield* qualificationFailure(
          "conflict",
          "qualification claim did not queue for the exact Remote",
        );
      }
      disposition = "prepared";
    } else if (
      taskMatchesWorking(
        task,
        actor,
        args.runId,
        args.hostId,
        canvasName,
      )
    ) {
      if (beforeHome !== target.stationInstallationId) {
        return yield* qualificationFailure(
          "conflict",
          "working qualification task is not homed at the exact Remote",
        );
      }
      disposition = "idempotent";
    } else {
      return yield* qualificationFailure(
        "conflict",
        "qualification task is not an exact submitted or already-working task",
      );
    }

    const synchronized = yield* synchronizeExact(
      args.hostId,
      target.stationInstallationId,
    );
    read = yield* canvases.read(canvasName);
    const finalMarker = yield* requireExactlyOneMarkerTask(
      read.doc,
      args.runId,
    );
    if (
      finalMarker.hostId !== args.hostId ||
      !taskMatchesWorking(
        finalMarker.task,
        actor,
        args.runId,
        args.hostId,
        canvasName,
      )
    ) {
      return yield* qualificationFailure(
        "conflict",
        "Command Center did not observe the exact claimed qualification task",
      );
    }
    const finalHome = yield* work.workTaskHome(
      canvasName,
      QUALIFICATION_WORK_SINK_NODE_ID,
      finalMarker.task.id,
    );
    if (finalHome !== target.stationInstallationId) {
      return yield* qualificationFailure(
        "conflict",
        "claimed qualification task is not homed at the exact Remote",
      );
    }
    void synchronized;
    const facts = yield* stations.statusFacts;
    const receivedThrough = yield* remoteCursor(
      facts.receivedThrough,
      target.stationInstallationId,
    );
    return {
      runId: args.runId,
      canvasName,
      hostId: args.hostId,
      stationInstallationId: target.stationInstallationId,
      taskId: finalMarker.task.id,
      actor,
      receivedThrough,
      state: "working",
      disposition: created ? "prepared" : disposition,
    };
  });

export const qualificationWorkProgressEffect = (
  args: OperatorQualificationWorkRunArgs,
  sessionReady: () => boolean,
): Effect.Effect<
  OperatorQualificationWorkProgressData,
  unknown,
  CanvasesService | StationApiService | StationRepository | WorkService
> =>
  Effect.gen(function* () {
    if (sessionReady()) {
      return yield* qualificationFailure(
        "conflict",
        "offline qualification progress requires no live Command Center session",
      );
    }
    const remote = yield* requireRemote;
    const canvases = yield* CanvasesService;
    const work = yield* WorkService;
    const api = yield* StationApiService;
    const canvasName = qualificationCanvasName(args.runId);
    let view = yield* readQualificationView(args.runId);
    const actor = yield* requireActor(
      view.read.actorRefs,
      canvasName,
      remote.installationId,
    );
    const home = yield* work.workTaskHome(
      canvasName,
      QUALIFICATION_WORK_SINK_NODE_ID,
      view.task.id,
    );
    if (home !== remote.installationId) {
      return yield* qualificationFailure(
        "conflict",
        "offline qualification task is not homed at this Remote",
      );
    }

    if (
      !taskMatchesWorking(
        view.task,
        actor,
        args.runId,
        view.hostId,
        canvasName,
      )
    ) {
      return yield* qualificationFailure(
        "conflict",
        "offline qualification task is not exact working work",
      );
    }
    const transitioned = yield* work.workTaskTransition(
      canvasName,
      QUALIFICATION_WORK_SINK_NODE_ID,
      view.task.id,
      "completed",
      QUALIFICATION_WORK_COMPLETION_NOTE,
    );
    const admitted = yield* workResult(
      transitioned,
      "offline qualification transition",
    );
    if (admitted.disposition !== "applied") {
      return yield* qualificationFailure(
        "conflict",
        "offline qualification transition did not apply locally",
      );
    }

    if (sessionReady()) {
      return yield* qualificationFailure(
        "conflict",
        "Command Center session appeared during offline qualification progress",
      );
    }
    view = yield* readQualificationView(args.runId);
    if (
      view.hostId === undefined ||
      !taskMatchesCompleted(
        view.task,
        actor,
        args.runId,
        view.hostId,
        canvasName,
      )
    ) {
      return yield* qualificationFailure(
        "conflict",
        "Remote did not retain the exact completed qualification task",
      );
    }
    const finalHome = yield* work.workTaskHome(
      canvasName,
      QUALIFICATION_WORK_SINK_NODE_ID,
      view.task.id,
    );
    if (finalHome !== remote.installationId) {
      return yield* qualificationFailure(
        "conflict",
        "completed qualification task is not homed at this Remote",
      );
    }
    const report = yield* api.prepareReport(
      remote.configuration.commandCenterInstallationId,
    );
    const receivedThrough = yield* transitionCursor(
      report,
      remote.installationId,
      view.task.id,
    );
    if (sessionReady()) {
      return yield* qualificationFailure(
        "conflict",
        "Command Center session appeared before offline progress proof completed",
      );
    }
    return {
      runId: args.runId,
      canvasName,
      hostId: view.hostId,
      stationInstallationId: remote.installationId,
      taskId: view.task.id,
      actor,
      receivedThrough,
      before: "working",
      after: "completed",
      disposition: "applied",
    };
  });

export const qualificationWorkVerifyEffect = (
  args: OperatorQualificationWorkTargetArgs,
): Effect.Effect<
  OperatorQualificationWorkVerifyData,
  unknown,
  | CanvasesService
  | StationFleetPropagation
  | StationFleetTargetRepository
  | StationRepository
  | WorkService
> =>
  Effect.gen(function* () {
    yield* requireCommandCenter;
    const target = yield* requireFleetTarget(args.hostId);
    yield* ensureQualificationCanvas(args.runId, args.hostId);
    yield* synchronizeExact(args.hostId, target.stationInstallationId);

    const canvases = yield* CanvasesService;
    const work = yield* WorkService;
    const stations = yield* StationRepository;
    const canvasName = qualificationCanvasName(args.runId);
    const read = yield* canvases.read(canvasName);
    const actor = yield* requireActor(
      read.actorRefs,
      canvasName,
      target.stationInstallationId,
    );
    const marker = yield* requireExactlyOneMarkerTask(
      read.doc,
      args.runId,
    );
    if (
      marker.hostId !== args.hostId ||
      !taskMatchesCompleted(
        marker.task,
        actor,
        args.runId,
        args.hostId,
        canvasName,
      )
    ) {
      return yield* qualificationFailure(
        "conflict",
        "Command Center did not observe the exact completed qualification task",
      );
    }
    const home = yield* work.workTaskHome(
      canvasName,
      QUALIFICATION_WORK_SINK_NODE_ID,
      marker.task.id,
    );
    if (home !== target.stationInstallationId) {
      return yield* qualificationFailure(
        "conflict",
        "verified qualification task is not homed at the exact Remote",
      );
    }
    const facts = yield* stations.statusFacts;
    const receivedThrough = yield* remoteCursor(
      facts.receivedThrough,
      target.stationInstallationId,
    );
    return {
      runId: args.runId,
      canvasName,
      hostId: args.hostId,
      stationInstallationId: target.stationInstallationId,
      taskId: marker.task.id,
      actor,
      receivedThrough,
      state: "completed",
    };
  });
