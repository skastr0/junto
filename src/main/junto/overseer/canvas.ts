import { Effect, Exit } from "effect";
import { ulid } from "ulid";
import { productVerbEnabled } from "@shared/features";
import { actorRefResolverFromProjection } from "@shared/graph";
import {
  asCanvasName,
  asNodeId,
  inPaintOrder,
  type Canvas,
  type Command,
  type Node,
  type NodeEdit,
  type Wire,
} from "@shared/model";
import type { SeatParts } from "@shared/model/seat-parts";
import {
  decodeOverseerArgs,
  type OverseerArgsFor,
  type OverseerCaller,
  type OverseerCanvasBatchStep,
  type OverseerErrorBody,
  type OverseerOperation,
  type OverseerRequest,
} from "@shared/overseer-control";
import {
  applyRegionEnvironmentEdit,
  isRegionNode,
  notARegion,
  regionEnvironmentOf,
  type OverseerEnvEdit,
  type OverseerEnvRefusal,
} from "@shared/overseer-env";
import {
  callerGrantLive,
  callerSeatBinding,
  canvasDeleteRetiresCaller,
  nativeDeleteResourcesOf,
  planOverseerSteps,
  removalIncludesCaller,
  removalRetiresCallerBinding,
  seatDraftRefusal,
  verbsForEndpoints,
  type OverseerDeleteResource,
  type OverseerStepResult,
} from "@shared/overseer-rules";
import { defaultVerbForPair } from "@shared/physics";
import { renderCanvasSvg } from "@shared/svg";
import type { WorkErrorBody } from "@shared/work-control";
import type { ActorRef } from "@shared/work-protocol";
import { ModelActorRefs } from "../model/actor-refs";
import { readModelDigest } from "../model/digest";
import { ModelService } from "../model/service";
import { WorkRepository } from "../work/repository";
import {
  editCanvases,
  fromModelError,
  isCanvasName,
  modelCanvas,
  modelCanvases,
  type OverseerStores,
} from "./portfolio";

// The overseer's canvas commands. Reads answer the model's own nodes and
// wires; a write is planned by shared/overseer-rules into model commands and
// sent with source "overseer" in one transaction with the read it was decided
// on.

const CANVAS_OPS = new Set<OverseerOperation>([
  "canvas.list",
  "canvas.read",
  "canvas.create",
  "canvas.batch",
  "canvas.delete",
  "canvas.digest",
  "canvas.render",
  "node.list",
  "node.get",
  "node.create",
  "node.configure",
  "node.move",
  "node.resize",
  "node.recolor",
  "node.delete",
  "wire.list",
  "wire.get",
  "wire.verbs",
  "wire.connect",
  "wire.configure",
  "wire.disconnect",
  "sheet.read",
  "sheet.configure",
  "env.show",
  "env.source-add",
  "env.source-edit",
  "env.source-remove",
  "env.source-reorder",
  "env.seal",
  "env.folders",
]);

export type OverseerDeletePrepareResult =
  | {
      readonly ok: true;
      readonly leaseId: string;
      readonly termLeaseId?: string;
      readonly chatLeaseId?: string;
      readonly pageStops: ReadonlyArray<{
        readonly sessionId: string;
        readonly stopped: boolean;
      }>;
    }
  | { readonly ok: false; readonly error: string };

export type OverseerNativeDeleteHooks = {
  readonly prepareOverseerNodeDelete: (
    resources: ReadonlyArray<OverseerDeleteResource>,
  ) => Promise<OverseerDeletePrepareResult>;
  readonly finishOverseerNodeDelete: (
    leaseId: string,
    outcome: "committed" | "aborted",
  ) => { readonly ok: true } | { readonly ok: false; readonly error: string };
};

export type OverseerCanvasHooks = {
  readonly nativeDelete?: OverseerNativeDeleteHooks;
};

const fail = (
  type: WorkErrorBody["type"],
  message: string,
  details?: WorkErrorBody["details"],
): WorkErrorBody =>
  details === undefined ? { type, message } : { type, message, details };

const fromOverseerError = (error: OverseerErrorBody): WorkErrorBody => {
  const type: WorkErrorBody["type"] =
    error.type === "Forbidden"
      ? "AuthError"
      : error.type === "InvalidArguments"
        ? "InputError"
        : error.type === "NotFound"
          ? "UnknownTarget"
          : error.type === "Conflict"
            ? "ClaimConflict"
            : error.type === "Unsupported"
              ? "ProtocolError"
              : error.type === "RuntimeDown"
                ? "RuntimeDown"
                : "InternalError";
  return fail(type, error.message);
};

const targetCanvas = (
  caller: OverseerCaller,
  canvas: string | undefined,
): string => canvas ?? caller.canvasName;

type Canvases = ReadonlyMap<string, Canvas>;

const requireGrant = (
  canvases: Canvases,
  caller: OverseerCaller,
): WorkErrorBody | undefined =>
  callerGrantLive(canvases, caller)
    ? undefined
    : fail("AuthError", "overseer grant is not live on the calling seat");

const refuseIfRetiresCaller = (
  canvases: Canvases,
  caller: OverseerCaller,
  resources: ReadonlyArray<OverseerDeleteResource>,
): WorkErrorBody | undefined =>
  removalRetiresCallerBinding(callerSeatBinding(canvases, caller), resources)
    ? fail("AuthError", "overseer cannot retire its own physical binding")
    : undefined;

let deleteHooks: OverseerNativeDeleteHooks | undefined;

export const setOverseerNativeDeleteHooks = (
  hooks: OverseerNativeDeleteHooks | undefined,
): void => {
  deleteHooks = hooks;
};

const activeDeleteHooks = (
  hooks?: OverseerCanvasHooks,
): OverseerNativeDeleteHooks | undefined =>
  hooks?.nativeDelete ?? deleteHooks;

const prepareDelete = (
  resources: ReadonlyArray<OverseerDeleteResource>,
  hooks: OverseerCanvasHooks | undefined,
  signal: AbortSignal,
): Promise<OverseerDeletePrepareResult> => {
  if (resources.length === 0) {
    return Promise.resolve({ ok: true, leaseId: "", pageStops: [] });
  }
  const native = activeDeleteHooks(hooks);
  if (native === undefined) {
    return Promise.resolve({
      ok: false,
      error:
        "native deletion hooks are not wired; refusing to drop live seats",
    });
  }
  return Promise.race([
    native.prepareOverseerNodeDelete(resources),
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("native delete prepare interrupted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("native delete prepare interrupted")),
        { once: true },
      );
    }),
  ]);
};

const finishDelete = (
  leaseId: string,
  outcome: "committed" | "aborted",
  hooks?: OverseerCanvasHooks,
): { readonly ok: true } | { readonly ok: false; readonly error: string } => {
  const native = activeDeleteHooks(hooks);
  if (leaseId.length === 0 || native === undefined) return { ok: true };
  return native.finishOverseerNodeDelete(leaseId, outcome);
};

const finishError = (
  outcome: "committed" | "aborted",
  error: string,
): WorkErrorBody =>
  fail(
    "InternalError",
    outcome === "committed"
      ? `native delete finish failed after commit: ${error}`
      : `native delete finish failed: ${error}`,
  );

const withPreparedDelete = <A>(
  resources: ReadonlyArray<OverseerDeleteResource>,
  body: () => Effect.Effect<A, WorkErrorBody, OverseerStores>,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<A, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    let finishFailure: WorkErrorBody | undefined;
    const result = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: (signal) => prepareDelete(resources, hooks, signal),
        catch: (error): WorkErrorBody =>
          fail(
            "InternalError",
            error instanceof Error ? error.message : String(error),
          ),
      }).pipe(
        Effect.flatMap((prepared) =>
          prepared.ok
            ? Effect.succeed(prepared)
            : Effect.fail(fail("InternalError", prepared.error)),
        ),
      ),
      (prepared) => {
        if (prepared.pageStops.some((stop) => !stop.stopped)) {
          return Effect.fail(
            fail("InternalError", "page stop failed; nodes were not deleted"),
          );
        }
        return body();
      },
      (prepared, exit) =>
        Effect.sync(() => {
          if (prepared.leaseId.length === 0) return;
          const outcome = Exit.isSuccess(exit) ? "committed" : "aborted";
          const finished = finishDelete(prepared.leaseId, outcome, hooks);
          if (!finished.ok) {
            finishFailure = finishError(outcome, finished.error);
          }
        }),
    );
    if (finishFailure !== undefined) {
      return yield* Effect.fail(finishFailure);
    }
    return result;
  });

const mintId = (kind: string): string => `${kind}-${ulid()}`;

/**
 * Plan steps on one canvas and send them as one atomic change. Every write of
 * a single node or wire goes through here as a batch of one, so the rules are
 * the same in and out of a batch.
 */
const sendSteps = (
  caller: OverseerCaller,
  canvasName: string,
  steps: ReadonlyArray<OverseerCanvasBatchStep>,
  expectedSeq?: number,
): Effect.Effect<ReadonlyArray<OverseerStepResult>, WorkErrorBody, OverseerStores> =>
  editCanvases((canvases) => {
    const revoked = requireGrant(canvases, caller);
    if (revoked) return { ok: false, error: revoked };
    const held = canvases.get(canvasName);
    if (held === undefined) {
      return { ok: false, error: fail("UnknownTarget", `canvas "${canvasName}" does not exist`) };
    }
    if (expectedSeq !== undefined && held.seq !== expectedSeq) {
      return {
        ok: false,
        error: fail(
          "ClaimConflict",
          `canvas "${canvasName}" is at seq ${held.seq}, not ${expectedSeq}; read the canvas again before editing`,
          { retryable: true },
        ),
      };
    }
    const plan = planOverseerSteps({ canvases, canvas: canvasName, caller, steps, mintId });
    if (!plan.ok) return { ok: false, error: fromOverseerError(plan.error) };
    return {
      ok: true,
      // One Batch, so the canvas moves once and a later step's refusal leaves
      // nothing of the earlier ones behind.
      commands: [{ _tag: "Batch", canvas: asCanvasName(canvasName), steps: plan.commands }],
      result: plan.results,
    };
  });

const actorRefsOf = (
  name: string,
): Effect.Effect<ReadonlyArray<ActorRef>, WorkErrorBody, OverseerStores> =>
  Effect.flatMap(ModelActorRefs, (refs) =>
    refs.read(name).pipe(Effect.mapError(fromModelError)),
  );

const nodeIn = (canvas: Canvas, nodeId: string): Effect.Effect<Node, WorkErrorBody> => {
  const node = canvas.nodes.get(asNodeId(nodeId));
  return node === undefined
    ? Effect.fail(fail("UnknownTarget", `node "${nodeId}" was not found`))
    : Effect.succeed(node);
};

// ── Canvases ────────────────────────────────────────────────────────────────

const handleList = (): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const model = yield* ModelService;
    const names = yield* model.listCanvases().pipe(Effect.mapError(fromModelError));
    return names.map((name) => ({ name }));
  });

/** Structure only: what is on the canvas and how it is wired. No work rides along. */
const handleRead = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.read">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.map(modelCanvas(targetCanvas(caller, args.canvas)), (canvas) => ({
    name: canvas.name,
    seq: canvas.seq,
    nodes: inPaintOrder(canvas),
    wires: [...canvas.wires.values()],
  }));

const handleCreateCanvas = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.create">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  editCanvases((canvases) => {
    const revoked = requireGrant(canvases, caller);
    if (revoked) return { ok: false, error: revoked };
    const name = args.canvas;
    if (!isCanvasName(name)) {
      return { ok: false, error: fail("InputError", `invalid canvas name ${JSON.stringify(name)}`) };
    }
    if (canvases.has(name)) {
      return { ok: false, error: fail("InputError", `canvas "${name}" already exists`) };
    }
    return {
      ok: true,
      commands: [{ _tag: "CreateCanvas", canvas: name }],
      result: { name, seq: 0, nodes: [], wires: [] },
    };
  });

const handleCanvasBatch = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.batch">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> => {
  const canvas = targetCanvas(caller, args.canvas);
  return Effect.map(sendSteps(caller, canvas, args.steps, args.expectedSeq), (results) => ({
    canvas,
    results,
  }));
};

const handleDeleteCanvas = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.delete">,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const name = (yield* modelCanvas(args.canvas)).name;
    const refusal = (canvases: Canvases): WorkErrorBody | undefined => {
      if (canvasDeleteRetiresCaller(caller, name)) {
        return fail("AuthError", "overseer cannot delete its own canvas");
      }
      const target = canvases.get(name);
      if (target === undefined) {
        return fail("UnknownTarget", `canvas "${name}" does not exist`);
      }
      return refuseIfRetiresCaller(canvases, caller, resourcesOf(canvases, name));
    };
    const resourcesOf = (canvases: Canvases, canvasName: string) =>
      nativeDeleteResourcesOf(canvases, [{
        canvasName,
        nodeIds: new Set([...(canvases.get(canvasName)?.nodes.keys() ?? [])]),
      }]);
    const before = yield* modelCanvases;
    const early = refusal(before);
    if (early) return yield* Effect.fail(early);
    return yield* withPreparedDelete(
      resourcesOf(before, name),
      () =>
        editCanvases((canvases) => {
          const revoked = requireGrant(canvases, caller) ?? refusal(canvases);
          if (revoked) return { ok: false, error: revoked };
          return {
            ok: true,
            commands: [{ _tag: "RemoveCanvas", canvas: asCanvasName(name) }],
            result: { name },
          };
        }),
      hooks,
    );
  });

const handleDigest = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.digest">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const canvas = yield* modelCanvas(targetCanvas(caller, args.canvas));
    return {
      digest: yield* readModelDigest(canvas.name, { bundles: [] }).pipe(
        Effect.mapError((error): WorkErrorBody =>
          fail("InternalError", `canvas "${canvas.name}" could not be digested: ${String(error)}`),
        ),
      ),
    };
  });

const handleRender = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.render">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const canvas = yield* modelCanvas(targetCanvas(caller, args.canvas));
    // The picture marks boards by their rows; a read, never a work command.
    const work = yield* WorkRepository;
    const rows = yield* work.kernelWork(canvas.name).pipe(
      Effect.mapError((error): WorkErrorBody => fail("InternalError", error.message)),
    );
    return {
      svg: renderCanvasSvg(canvas, {
        canvasName: canvas.name,
        resolveActorRef: actorRefResolverFromProjection(
          yield* actorRefsOf(canvas.name),
        ),
        itemsOf: (nodeId) => rows.tasks.get(nodeId) ?? [],
      }),
    };
  });

// ── Nodes ───────────────────────────────────────────────────────────────────

const handleNodeList = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.list">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.map(modelCanvas(targetCanvas(caller, args.canvas)), (canvas) => ({
    nodes: inPaintOrder(canvas),
  }));

const handleNodeGet = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.get">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const canvas = yield* modelCanvas(targetCanvas(caller, args.canvas));
    return { node: yield* nodeIn(canvas, args.nodeId) };
  });

/** The one result of a write that was a batch of one step. */
const only = (results: ReadonlyArray<OverseerStepResult>): OverseerStepResult => results[0]!;

const handleNodeCreate = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.create">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.map(
    sendSteps(caller, targetCanvas(caller, args.canvas), [
      { operation: "node.create", node: args.node },
    ]),
    (results) => {
      const made = only(results);
      return made.operation === "node.create" ? { node: made.node } : made;
    },
  );

/** The node as it stands after a write to it, read from the model. */
const nodeAfter = (
  canvasName: string,
  nodeId: string,
): Effect.Effect<{ readonly node: Node }, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    return { node: yield* nodeIn(yield* modelCanvas(canvasName), nodeId) };
  });

const writeNode = (
  caller: OverseerCaller,
  canvas: string | undefined,
  step: Extract<OverseerCanvasBatchStep, { readonly nodeId: string }>,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> => {
  const name = targetCanvas(caller, canvas);
  return Effect.flatMap(sendSteps(caller, name, [step]), () => nodeAfter(name, step.nodeId));
};

const handleNodeRecolor = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.recolor">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.map(
    sendSteps(caller, targetCanvas(caller, args.canvas), [
      { operation: "node.recolor", nodeIds: args.nodeIds, color: args.color },
    ]),
    () => ({ nodeIds: args.nodeIds, color: args.color }),
  );

const handleNodeDelete = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.delete">,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const name = targetCanvas(caller, args.canvas);
    const removed = new Set<string>(args.nodeIds);
    const resourcesOf = (canvases: Canvases) =>
      nativeDeleteResourcesOf(canvases, [{ canvasName: name, nodeIds: removed }]);
    const refusal = (canvases: Canvases): WorkErrorBody | undefined => {
      const canvas = canvases.get(name);
      if (canvas === undefined) {
        return fail("UnknownTarget", `canvas "${name}" does not exist`);
      }
      for (const nodeId of removed) {
        if (!canvas.nodes.has(asNodeId(nodeId))) {
          return fail("UnknownTarget", `node "${nodeId}" was not found`);
        }
      }
      if (removalIncludesCaller(caller, name, removed)) {
        return fail("AuthError", "overseer cannot delete its own seat");
      }
      return refuseIfRetiresCaller(canvases, caller, resourcesOf(canvases));
    };
    const before = yield* modelCanvases;
    const early = refusal(before);
    if (early) return yield* Effect.fail(early);
    return yield* withPreparedDelete(
      resourcesOf(before),
      () =>
        editCanvases((canvases) => {
          const revoked = requireGrant(canvases, caller) ?? refusal(canvases);
          if (revoked) return { ok: false, error: revoked };
          return {
            ok: true,
            commands: [{
              _tag: "Remove",
              canvas: asCanvasName(name),
              nodes: [...removed].map(asNodeId),
              wires: [],
            }],
            result: { nodeIds: [...removed] },
          };
        }),
      hooks,
    );
  });

// ── Wires ───────────────────────────────────────────────────────────────────

const handleWireList = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"wire.list">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.map(modelCanvas(targetCanvas(caller, args.canvas)), (canvas) => ({
    wires: [...canvas.wires.values()],
  }));

const wireIn = (canvas: Canvas, wireId: string): Effect.Effect<Wire, WorkErrorBody> => {
  const wire = [...canvas.wires.values()].find((held) => held.id === wireId);
  return wire === undefined
    ? Effect.fail(fail("UnknownTarget", `wire "${wireId}" was not found`))
    : Effect.succeed(wire);
};

const handleWireGet = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"wire.get">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const canvas = yield* modelCanvas(targetCanvas(caller, args.canvas));
    return { wire: yield* wireIn(canvas, args.wireId) };
  });

const handleWireVerbs = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"wire.verbs">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const canvas = yield* modelCanvas(targetCanvas(caller, args.canvas));
    if (args.from === undefined || args.to === undefined) return { verbs: [] };
    const from = canvas.nodes.get(asNodeId(args.from));
    const to = canvas.nodes.get(asNodeId(args.to));
    const verbs = verbsForEndpoints(from, to).filter(productVerbEnabled);
    const pairDefault = defaultVerbForPair(from?.kind, to?.kind);
    return {
      verbs,
      default:
        pairDefault !== undefined && verbs.includes(pairDefault) ? pairDefault : verbs[0],
    };
  });

const handleWireConnect = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"wire.connect">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.map(
    sendSteps(caller, targetCanvas(caller, args.canvas), [
      { operation: "wire.connect", wire: args.wire },
    ]),
    (results) => {
      const made = only(results);
      return made.operation === "wire.connect" ? { wire: made.wire } : made;
    },
  );

const handleWireConfigure = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"wire.configure">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> => {
  const name = targetCanvas(caller, args.canvas);
  return Effect.gen(function* () {
    yield* sendSteps(caller, name, [
      { operation: "wire.configure", wireId: args.wireId, change: args.change },
    ]);
    return { wire: yield* wireIn(yield* modelCanvas(name), args.wireId) };
  });
};

const handleWireDisconnect = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"wire.disconnect">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.map(
    sendSteps(caller, targetCanvas(caller, args.canvas), [
      { operation: "wire.disconnect", wireId: args.wireId },
    ]),
    () => ({ wireId: args.wireId }),
  );

// ── Region environment ──────────────────────────────────────────────────────

const fromEnvRefusal = (refusal: OverseerEnvRefusal): WorkErrorBody =>
  fail(refusal.type === "NotFound" ? "UnknownTarget" : "InputError", refusal.message);

const handleEnvShow = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"env.show">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const canvas = yield* modelCanvas(targetCanvas(caller, args.canvas));
    const node = yield* nodeIn(canvas, args.nodeId);
    if (!isRegionNode(node)) {
      return yield* Effect.fail(fromEnvRefusal(notARegion(args.nodeId)));
    }
    return { nodeId: node.id, environment: regionEnvironmentOf(node) };
  });

/**
 * An environment edit is canvas authoring: one read-modify-write of a
 * region's environment, sent as that region's edit under the same
 * transaction and grant rules as `node.configure`.
 */
const handleEnvEdit = (
  caller: OverseerCaller,
  edit: OverseerEnvEdit,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> => {
  // Minted before the transaction so the caller is told the id it got.
  const mintedSourceId = `source-${ulid()}`;
  const name = targetCanvas(caller, edit.args.canvas);
  return editCanvases((canvases) => {
    const revoked = requireGrant(canvases, caller);
    if (revoked) return { ok: false, error: revoked };
    const canvas = canvases.get(name);
    if (canvas === undefined) {
      return { ok: false, error: fail("UnknownTarget", `canvas "${name}" does not exist`) };
    }
    const node = canvas.nodes.get(asNodeId(edit.args.nodeId));
    if (node === undefined) {
      return { ok: false, error: fail("UnknownTarget", `node "${edit.args.nodeId}" was not found`) };
    }
    const edited = applyRegionEnvironmentEdit(node, edit, () => mintedSourceId);
    if (!edited.ok) return { ok: false, error: fromEnvRefusal(edited.error) };
    const change: NodeEdit = { kind: "region", environment: edited.value ?? null };
    return {
      ok: true,
      commands: [{ _tag: "Edit", canvas: asCanvasName(name), id: node.id, change }],
      result: {
        nodeId: node.id,
        ...(edit.operation === "env.source-add"
          ? { sourceId: edit.args.source.id ?? mintedSourceId }
          : {}),
        environment: edited.value ?? {},
      },
    };
  });
};

// ── Sheets ──────────────────────────────────────────────────────────────────

const sheetIn = (
  canvas: Canvas,
  target: string,
): Effect.Effect<Node, WorkErrorBody> =>
  Effect.flatMap(nodeIn(canvas, target), (node) =>
    node.kind === "sheet"
      ? Effect.succeed(node)
      : Effect.fail(fail("InputError", `node "${target}" is not a sheet`)),
  );

const handleSheetRead = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"sheet.read">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const canvas = yield* modelCanvas(targetCanvas(caller, args.canvas));
    yield* sheetIn(canvas, args.target);
    // A sheet's grid is content of its own; the canvas only says it is there.
    const model = yield* ModelService;
    const sheet = yield* model
      .readSheet(canvas.name, args.target)
      .pipe(Effect.mapError(fromModelError));
    return { sheet: sheet ?? { columns: [], rows: [] } };
  });

const handleSheetConfigure = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"sheet.configure">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> => {
  const name = targetCanvas(caller, args.canvas);
  return editCanvases((canvases) => {
    const revoked = requireGrant(canvases, caller);
    if (revoked) return { ok: false, error: revoked };
    const node = canvases.get(name)?.nodes.get(asNodeId(args.target));
    if (node === undefined) {
      return { ok: false, error: fail("UnknownTarget", `node "${args.target}" was not found`) };
    }
    if (node.kind !== "sheet") {
      return { ok: false, error: fail("InputError", `node "${args.target}" is not a sheet`) };
    }
    return {
      ok: true,
      commands: [{ _tag: "WriteSheet", canvas: asCanvasName(name), id: node.id, grid: args.sheet }],
      result: { node, sheet: args.sheet },
    };
  });
};

// ── Dispatch ────────────────────────────────────────────────────────────────

const dispatch = (
  caller: OverseerCaller,
  operation: OverseerOperation,
  args: unknown,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> => {
  const decoded = decodeOverseerArgs(operation, args);
  if (decoded._tag === "Failure") {
    // A seat draft naming what main works out is told what to send instead.
    const seat =
      operation === "node.create" && typeof args === "object" && args !== null
        ? seatDraftRefusal((args as { readonly node?: unknown }).node)
        : undefined;
    return Effect.fail(fail("InputError", seat ?? decoded.failure.message));
  }
  const input = decoded.success;
  switch (operation) {
    case "canvas.list":
      return handleList();
    case "canvas.read":
      return handleRead(caller, input as OverseerArgsFor<"canvas.read">);
    case "canvas.create":
      return handleCreateCanvas(caller, input as OverseerArgsFor<"canvas.create">);
    case "canvas.batch":
      return handleCanvasBatch(caller, input as OverseerArgsFor<"canvas.batch">);
    case "canvas.delete":
      return handleDeleteCanvas(caller, input as OverseerArgsFor<"canvas.delete">, hooks);
    case "canvas.digest":
      return handleDigest(caller, input as OverseerArgsFor<"canvas.digest">);
    case "canvas.render":
      return handleRender(caller, input as OverseerArgsFor<"canvas.render">);
    case "node.list":
      return handleNodeList(caller, input as OverseerArgsFor<"node.list">);
    case "node.get":
      return handleNodeGet(caller, input as OverseerArgsFor<"node.get">);
    case "node.create":
      return handleNodeCreate(caller, input as OverseerArgsFor<"node.create">);
    case "node.configure": {
      const { canvas, ...step } = input as OverseerArgsFor<"node.configure">;
      return writeNode(caller, canvas, { operation, ...step });
    }
    case "node.move": {
      const { canvas, ...step } = input as OverseerArgsFor<"node.move">;
      return writeNode(caller, canvas, { operation, ...step });
    }
    case "node.resize": {
      const { canvas, ...step } = input as OverseerArgsFor<"node.resize">;
      return writeNode(caller, canvas, { operation, ...step });
    }
    case "node.recolor":
      return handleNodeRecolor(caller, input as OverseerArgsFor<"node.recolor">);
    case "node.delete":
      return handleNodeDelete(caller, input as OverseerArgsFor<"node.delete">, hooks);
    case "wire.list":
      return handleWireList(caller, input as OverseerArgsFor<"wire.list">);
    case "wire.get":
      return handleWireGet(caller, input as OverseerArgsFor<"wire.get">);
    case "wire.verbs":
      return handleWireVerbs(caller, input as OverseerArgsFor<"wire.verbs">);
    case "wire.connect":
      return handleWireConnect(caller, input as OverseerArgsFor<"wire.connect">);
    case "wire.configure":
      return handleWireConfigure(caller, input as OverseerArgsFor<"wire.configure">);
    case "wire.disconnect":
      return handleWireDisconnect(caller, input as OverseerArgsFor<"wire.disconnect">);
    case "env.show":
      return handleEnvShow(caller, input as OverseerArgsFor<"env.show">);
    case "env.source-add":
    case "env.source-edit":
    case "env.source-remove":
    case "env.source-reorder":
    case "env.seal":
    case "env.folders":
      return handleEnvEdit(caller, { operation, args: input } as OverseerEnvEdit);
    case "sheet.read":
      return handleSheetRead(caller, input as OverseerArgsFor<"sheet.read">);
    case "sheet.configure":
      return handleSheetConfigure(caller, input as OverseerArgsFor<"sheet.configure">);
    default:
      return Effect.fail(
        fail("ProtocolError", `canvas dispatcher does not own ${operation}`),
      );
  }
};

const requireLiveGrant = (
  caller: OverseerCaller,
): Effect.Effect<void, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const revoked = requireGrant(yield* modelCanvases, caller);
    if (revoked) return yield* Effect.fail(revoked);
  });

export const executeOverseerCanvas = (
  caller: OverseerCaller,
  request: OverseerRequest,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> => {
  if (!CANVAS_OPS.has(request.operation)) {
    return Effect.fail(
      fail(
        "ProtocolError",
        `canvas dispatcher does not own ${request.operation}`,
      ),
    );
  }
  return requireLiveGrant(caller).pipe(
    Effect.flatMap(() => dispatch(caller, request.operation, request.args, hooks)),
  );
};

/**
 * Put another agent in a seat. `parts` is what the seat launch rules worked
 * out from the choices an overseer named; the model ends the old session.
 */
export const commitAgentReseat = (
  caller: OverseerCaller,
  target: { readonly canvas?: string; readonly nodeId: string },
  parts: SeatParts,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> => {
  const name = targetCanvas(caller, target.canvas);
  return editCanvases((canvases) => {
    const revoked = requireGrant(canvases, caller);
    if (revoked) return { ok: false, error: revoked };
    const node = canvases.get(name)?.nodes.get(asNodeId(target.nodeId));
    if (node === undefined) {
      return { ok: false, error: fail("UnknownTarget", `node "${target.nodeId}" was not found`) };
    }
    if (node.kind !== "agent") {
      return { ok: false, error: fail("InputError", `node "${target.nodeId}" is not an agent`) };
    }
    if (caller.canvasName === name && caller.nodeId === target.nodeId) {
      return { ok: false, error: fail("AuthError", "overseer cannot reseat its own occupant") };
    }
    const command: Command = {
      _tag: "Reseat",
      canvas: asCanvasName(name),
      id: node.id,
      agentKey: parts.agentKey,
      bindingId: parts.bindingId,
      harness: parts.harness,
      host: parts.host,
      launch: parts.launch,
    };
    return { ok: true, commands: [command], result: { nodeId: node.id } };
  });
};

/** Change when a cron fires or what a watcher watches. */
export const applySchedulerConfigure = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"scheduler.configure">,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  writeNode(caller, args.canvas, {
    operation: "node.configure",
    nodeId: args.nodeId,
    change: args.change,
  });

export { fromOverseerError };
