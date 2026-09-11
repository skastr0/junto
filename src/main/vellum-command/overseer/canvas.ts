import { Effect, Exit, Result } from "effect";
import { ulid } from "ulid";
import {
  decodeCanvasDoc,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from "@shared/canvas";
import { digestCanvas } from "@shared/digest";
import { renderCanvasSvg } from "@shared/svg";
import {
  decodeOverseerArgs,
  type OverseerArgsFor,
  type OverseerCaller,
  type OverseerErrorBody,
  type OverseerNodeDraft,
  type OverseerOperation,
  type OverseerRequest,
} from "@shared/overseer-control";
import {
  aliasesLiveOverseerBinding,
  applyNodeChanges,
  callerGrantLive,
  canvasDeleteRetiresCaller,
  edgeVerbAdmitted,
  findEdge,
  findNode,
  flowCycleIfInvalid,
  nativeDeleteResourcesOf,
  nodeGeometry,
  nodeHasOverseerGrant,
  nodeKindChanged,
  nodeSeatBinding,
  removalIncludesCaller,
  retiresOccupant,
  stripIncidentEdges,
  verbsForEndpoints,
  type OverseerDeleteResource,
} from "@shared/overseer-authoring";
import type { WorkErrorBody } from "@shared/work-control";
import { actorRefResolverFromProjection } from "@shared/graph";
import type { ActorRef } from "@shared/work-protocol";
import { defaultVerbForPair } from "@shared/physics";
import {
  CanvasError,
  CanvasesService,
  canvasNameFrom,
  type CanvasPortfolioView,
} from "../canvases";

const CANVAS_OPS = new Set<OverseerOperation>([
  "canvas.list",
  "canvas.read",
  "canvas.create",
  "canvas.delete",
  "canvas.digest",
  "canvas.render",
  "node.list",
  "node.get",
  "node.create",
  "node.configure",
  "node.move",
  "node.resize",
  "node.delete",
  "edge.list",
  "edge.get",
  "edge.verbs",
  "edge.connect",
  "edge.configure",
  "edge.disconnect",
  "sheet.read",
  "sheet.configure",
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
  readonly commitAgentReseat?: (
    caller: OverseerCaller,
    args: OverseerArgsFor<"agent.reseat">,
  ) => Effect.Effect<unknown, WorkErrorBody, CanvasesService>;
  readonly applySchedulerConfigure?: (
    caller: OverseerCaller,
    args: OverseerArgsFor<"scheduler.configure">,
  ) => Effect.Effect<unknown, WorkErrorBody, CanvasesService>;
};

const workError = (
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
  return workError(type, error.message);
};

const fromCanvasError = (error: CanvasError): WorkErrorBody => {
  const message = error.message;
  if (message.includes("revision conflict")) {
    return workError("ClaimConflict", message, { retryable: true });
  }
  if (message.includes("does not exist") || message.includes("is not in")) {
    return workError("UnknownTarget", message);
  }
  if (message.includes("already exists") || message.includes("invalid canvas name")) {
    return workError("InputError", message);
  }
  return workError("InternalError", message);
};

const fail = (type: WorkErrorBody["type"], message: string): WorkErrorBody =>
  workError(type, message);

const schemaFailure = (error: { readonly message: string }): WorkErrorBody =>
  workError("InputError", error.message);

const targetCanvas = (
  caller: OverseerCaller,
  canvas: string | undefined,
): string => canvas ?? caller.canvasName;

const decodeNode = (
  draft: OverseerNodeDraft,
  mintedId: string,
): { readonly ok: true; readonly node: CanvasNode } | { readonly ok: false; readonly error: WorkErrorBody } => {
  const raw = {
    ...draft,
    id: draft.id ?? mintedId,
  };
  const decoded = decodeCanvasDoc({ nodes: [raw], edges: [] });
  if (Result.isFailure(decoded)) {
    return { ok: false, error: fail("InputError", decoded.failure.message) };
  }
  const node = decoded.success.nodes[0];
  if (node === undefined) {
    return { ok: false, error: fail("InputError", "node draft did not decode") };
  }
  return { ok: true, node };
};

const isWorkError = (
  value: CanvasNode | WorkErrorBody,
): value is WorkErrorBody => !("id" in value) && "message" in value;

const requireGrant = (
  view: CanvasPortfolioView,
  caller: OverseerCaller,
): WorkErrorBody | undefined => {
  if (callerGrantLive(view.documents, caller)) return undefined;
  return fail(
    "AuthError",
    "overseer grant is not live on the calling seat",
  );
};

const cloneDocs = (
  documents: ReadonlyMap<string, CanvasDoc>,
): Map<string, CanvasDoc> => new Map(documents);

const putDoc = (
  documents: Map<string, CanvasDoc>,
  name: string,
  doc: CanvasDoc,
): Map<string, CanvasDoc> => {
  documents.set(name, doc);
  return documents;
};

const digestLive = (actorRefs: ReadonlyArray<ActorRef>) => ({
  resolveActorRef: actorRefResolverFromProjection(actorRefs),
});

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
  body: () => Effect.Effect<A, WorkErrorBody, CanvasesService>,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<A, WorkErrorBody, CanvasesService> =>
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

const executeOnPortfolio = <A>(
  fn: (view: CanvasPortfolioView) =>
    | { readonly ok: true; readonly documents: ReadonlyMap<string, CanvasDoc>; readonly result: A }
    | { readonly ok: false; readonly error: WorkErrorBody },
): Effect.Effect<A, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const committed = yield* canvases.mutatePortfolio((view) => {
      const edit = fn(view);
      if (!edit.ok) return { ok: false as const, error: edit.error };
      return {
        ok: true as const,
        mutation: { documents: edit.documents, result: edit.result },
      };
    }).pipe(
      Effect.mapError((error): WorkErrorBody =>
        error instanceof CanvasError ? fromCanvasError(error) : error,
      ),
    );
    return committed.result;
  });

const readCanvas = (
  name: string,
): Effect.Effect<
  {
    readonly name: string;
    readonly doc: CanvasDoc;
    readonly revision: string;
    readonly actorRefs: ReadonlyArray<ActorRef>;
  },
  WorkErrorBody,
  CanvasesService
> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const canonical = yield* Effect.try({
      try: () => canvasNameFrom(name),
      catch: (error): WorkErrorBody =>
        error instanceof CanvasError
          ? fromCanvasError(error)
          : fail("InputError", String(error)),
    });
    const read = yield* canvases.read(canonical, "overseer.canvas").pipe(
      Effect.mapError(fromCanvasError),
    );
    return read;
  });

const handleList = (): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    return yield* canvases.list.pipe(Effect.mapError(fromCanvasError));
  });

const handleRead = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.read">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  readCanvas(targetCanvas(caller, args.canvas));

const handleCreateCanvas = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.create">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  executeOnPortfolio((view) => {
    const revoked = requireGrant(view, caller);
    if (revoked) return { ok: false, error: revoked };
    let name: string;
    try {
      name = canvasNameFrom(args.canvas);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof CanvasError
            ? fromCanvasError(error)
            : fail("InputError", String(error)),
      };
    }
    if (view.documents.has(name)) {
      return {
        ok: false,
        error: fail("InputError", `canvas "${name}" already exists`),
      };
    }
    const doc: CanvasDoc = { nodes: [], edges: [] };
    return {
      ok: true,
      documents: putDoc(cloneDocs(view.documents), name, doc),
      result: { name, doc },
    };
  });

const handleDeleteCanvas = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.delete">,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const name = yield* Effect.try({
      try: () => canvasNameFrom(args.canvas),
      catch: (error): WorkErrorBody =>
        error instanceof CanvasError
          ? fromCanvasError(error)
          : fail("InputError", String(error)),
    });
    const current = yield* canvases.read(name, "overseer.canvas").pipe(
      Effect.mapError(fromCanvasError),
    );
    if (canvasDeleteRetiresCaller(caller, name)) {
      return yield* Effect.fail(
        fail("AuthError", "overseer cannot delete its own canvas"),
      );
    }
    const resources = nativeDeleteResourcesOf(
      new Map([[name, current.doc]]),
      [{ canvasName: name, nodeIds: new Set(current.doc.nodes.map((node) => node.id)) }],
    );
    return yield* withPreparedDelete(
      resources,
      () =>
      executeOnPortfolio((view) => {
        const revoked = requireGrant(view, caller);
        if (revoked) return { ok: false, error: revoked };
        if (canvasDeleteRetiresCaller(caller, name)) {
          return {
            ok: false,
            error: fail("AuthError", "overseer cannot delete its own canvas"),
          };
        }
        if (!view.documents.has(name)) {
          return {
            ok: false,
            error: fail("UnknownTarget", `canvas "${name}" does not exist`),
          };
        }
        const documents = cloneDocs(view.documents);
        documents.delete(name);
        return { ok: true, documents, result: { name } };
      }),
      hooks,
    );
  });

const handleDigest = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.digest">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const read = yield* readCanvas(targetCanvas(caller, args.canvas));
    return {
      digest: digestCanvas(read.name, read.doc, { bundles: [] }, digestLive(read.actorRefs)),
    };
  });

const handleRender = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"canvas.render">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const read = yield* readCanvas(targetCanvas(caller, args.canvas));
    return {
      svg: renderCanvasSvg(read.doc, {
        canvasName: read.name,
        resolveActorRef: actorRefResolverFromProjection(read.actorRefs),
      }),
    };
  });

const handleNodeList = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.list">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const read = yield* readCanvas(targetCanvas(caller, args.canvas));
    return { nodes: read.doc.nodes };
  });

const handleNodeGet = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.get">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const read = yield* readCanvas(targetCanvas(caller, args.canvas));
    const node = findNode(read.doc, args.nodeId);
    if (node === undefined) {
      return yield* Effect.fail(
        fail("UnknownTarget", `node "${args.nodeId}" was not found`),
      );
    }
    return { node };
  });

const handleNodeCreate = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.create">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  executeOnPortfolio((view) => {
    const revoked = requireGrant(view, caller);
    if (revoked) return { ok: false, error: revoked };
    const name = targetCanvas(caller, args.canvas);
    const current = view.documents.get(name);
    if (current === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", `canvas "${name}" does not exist`),
      };
    }
    const decodedNode = decodeNode(args.node, `node-${ulid()}`);
    if (!decodedNode.ok) return decodedNode;
    const node = decodedNode.node;
    if (findNode(current, node.id) !== undefined) {
      return {
        ok: false,
        error: fail("InputError", `node "${node.id}" already exists`),
      };
    }
    if (nodeHasOverseerGrant(node) || aliasesLiveOverseerBinding(view.documents, node)) {
      return {
        ok: false,
        error: fail(
          "AuthError",
          "overseer cannot mint or inherit overseer authority",
        ),
      };
    }
    const next: CanvasDoc = { ...current, nodes: [...current.nodes, node] };
    return {
      ok: true,
      documents: putDoc(cloneDocs(view.documents), name, next),
      result: { node },
    };
  });

const mutateExistingNode = (
  caller: OverseerCaller,
  canvas: string | undefined,
  nodeId: string,
  transform: (
    node: CanvasNode,
    view: CanvasPortfolioView,
  ) => CanvasNode | WorkErrorBody,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  executeOnPortfolio((view) => {
    const revoked = requireGrant(view, caller);
    if (revoked) return { ok: false, error: revoked };
    const name = targetCanvas(caller, canvas);
    const current = view.documents.get(name);
    if (current === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", `canvas "${name}" does not exist`),
      };
    }
    const existing = findNode(current, nodeId);
    if (existing === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", `node "${nodeId}" was not found`),
      };
    }
    const nextNode = transform(existing, view);
    if (isWorkError(nextNode)) {
      return { ok: false, error: nextNode };
    }
    const updated = nextNode;
    if (nodeHasOverseerGrant(updated) && !nodeHasOverseerGrant(existing)) {
      return {
        ok: false,
        error: fail("AuthError", "overseer cannot mint overseer authority"),
      };
    }
    const isSelf = caller.canvasName === name && caller.nodeId === nodeId;
    if (isSelf && (nodeKindChanged(existing, updated) || retiresOccupant(existing, updated))) {
      return {
        ok: false,
        error: fail(
          "AuthError",
          "overseer cannot change its own kind, binding, host, or occupant identity",
        ),
      };
    }
    if (
      aliasesLiveOverseerBinding(view.documents, updated) &&
      nodeSeatBinding(existing)?.bindingId !== nodeSeatBinding(updated)?.bindingId
    ) {
      return {
        ok: false,
        error: fail(
          "AuthError",
          "copied or reseated nodes cannot alias a live overseer binding",
        ),
      };
    }
    const nodes = current.nodes.map((node) => (node.id === nodeId ? updated : node));
    return {
      ok: true,
      documents: putDoc(cloneDocs(view.documents), name, { ...current, nodes }),
      result: { node: updated },
    };
  });

const handleNodeConfigure = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.configure">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  mutateExistingNode(caller, args.canvas, args.nodeId, (node) =>
    applyNodeChanges(node, args.changes),
  );

const handleNodeMove = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.move">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  mutateExistingNode(caller, args.canvas, args.nodeId, (node) =>
    nodeGeometry(node, { x: args.x, y: args.y }),
  );

const handleNodeResize = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.resize">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  mutateExistingNode(caller, args.canvas, args.nodeId, (node) =>
    nodeGeometry(node, { width: args.width, height: args.height }),
  );

const handleNodeDelete = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"node.delete">,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const name = targetCanvas(caller, args.canvas);
    const current = yield* readCanvas(name);
    const existing = findNode(current.doc, args.nodeId);
    if (existing === undefined) {
      return yield* Effect.fail(
        fail("UnknownTarget", `node "${args.nodeId}" was not found`),
      );
    }
    const removed = new Set([args.nodeId]);
    if (removalIncludesCaller(caller, name, removed)) {
      return yield* Effect.fail(
        fail("AuthError", "overseer cannot delete its own seat"),
      );
    }
    const resources = nativeDeleteResourcesOf(new Map([[name, current.doc]]), [
      { canvasName: name, nodeIds: removed },
    ]);
    return yield* withPreparedDelete(
      resources,
      () =>
      executeOnPortfolio((view) => {
        const revoked = requireGrant(view, caller);
        if (revoked) return { ok: false, error: revoked };
        const doc = view.documents.get(name);
        if (doc === undefined) {
          return {
            ok: false,
            error: fail("UnknownTarget", `canvas "${name}" does not exist`),
          };
        }
        if (findNode(doc, args.nodeId) === undefined) {
          return {
            ok: false,
            error: fail("UnknownTarget", `node "${args.nodeId}" was not found`),
          };
        }
        if (removalIncludesCaller(caller, name, removed)) {
          return {
            ok: false,
            error: fail("AuthError", "overseer cannot delete its own seat"),
          };
        }
        return {
          ok: true,
          documents: putDoc(
            cloneDocs(view.documents),
            name,
            stripIncidentEdges(doc, removed),
          ),
          result: { nodeId: args.nodeId },
        };
      }),
      hooks,
    );
  });

const handleEdgeList = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"edge.list">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const read = yield* readCanvas(targetCanvas(caller, args.canvas));
    return { edges: read.doc.edges };
  });

const handleEdgeGet = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"edge.get">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const read = yield* readCanvas(targetCanvas(caller, args.canvas));
    const edge = findEdge(read.doc, args.edgeId);
    if (edge === undefined) {
      return yield* Effect.fail(
        fail("UnknownTarget", `edge "${args.edgeId}" was not found`),
      );
    }
    return { edge };
  });

const handleEdgeVerbs = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"edge.verbs">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const read = yield* readCanvas(targetCanvas(caller, args.canvas));
    if (args.fromNode === undefined || args.toNode === undefined) {
      return { verbs: [] };
    }
    const fromNode = findNode(read.doc, args.fromNode);
    const toNode = findNode(read.doc, args.toNode);
    const verbs = verbsForEndpoints(fromNode, toNode);
    return {
      verbs,
      default: defaultVerbForPair(
        fromNode === undefined || fromNode.type === "group"
          ? undefined
          : fromNode.ether?.entity?.kind,
        toNode === undefined || toNode.type === "group"
          ? undefined
          : toNode.ether?.entity?.kind,
      ),
    };
  });

const handleEdgeConnect = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"edge.connect">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  executeOnPortfolio((view) => {
    const revoked = requireGrant(view, caller);
    if (revoked) return { ok: false, error: revoked };
    const name = targetCanvas(caller, args.canvas);
    const current = view.documents.get(name);
    if (current === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", `canvas "${name}" does not exist`),
      };
    }
    const draft = args.edge;
    const fromNode = findNode(current, draft.fromNode);
    const toNode = findNode(current, draft.toNode);
    if (fromNode === undefined || toNode === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", "edge endpoints were not found"),
      };
    }
    if (!edgeVerbAdmitted(fromNode, toNode, draft.verb)) {
      return {
        ok: false,
        error: fail(
          "InputError",
          `verb "${draft.verb}" is not legal for these endpoints`,
        ),
      };
    }
    const edge: CanvasEdge = {
      id: draft.id ?? `edge-${ulid()}`,
      fromNode: draft.fromNode,
      toNode: draft.toNode,
      ether: { verb: draft.verb },
      ...(draft.fromSide !== undefined ? { fromSide: draft.fromSide } : {}),
      ...(draft.fromEnd !== undefined ? { fromEnd: draft.fromEnd } : {}),
      ...(draft.toSide !== undefined ? { toSide: draft.toSide } : {}),
      ...(draft.toEnd !== undefined ? { toEnd: draft.toEnd } : {}),
      ...(draft.color !== undefined ? { color: draft.color } : {}),
      ...(draft.label !== undefined ? { label: draft.label } : {}),
    };
    if (findEdge(current, edge.id) !== undefined) {
      return {
        ok: false,
        error: fail("InputError", `edge "${edge.id}" already exists`),
      };
    }
    const next: CanvasDoc = { ...current, edges: [...current.edges, edge] };
    const cycle = flowCycleIfInvalid(next);
    if (cycle !== undefined) {
      return { ok: false, error: fail("InputError", cycle) };
    }
    return {
      ok: true,
      documents: putDoc(cloneDocs(view.documents), name, next),
      result: { edge },
    };
  });

const handleEdgeConfigure = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"edge.configure">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  executeOnPortfolio((view) => {
    const revoked = requireGrant(view, caller);
    if (revoked) return { ok: false, error: revoked };
    const name = targetCanvas(caller, args.canvas);
    const current = view.documents.get(name);
    if (current === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", `canvas "${name}" does not exist`),
      };
    }
    const existing = findEdge(current, args.edgeId);
    if (existing === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", `edge "${args.edgeId}" was not found`),
      };
    }
    const changes = args.changes;
    let nextEdge: CanvasEdge = existing;
    if (changes.verb !== undefined) {
      const fromNode = findNode(current, existing.fromNode);
      const toNode = findNode(current, existing.toNode);
      if (!edgeVerbAdmitted(fromNode, toNode, changes.verb)) {
        return {
          ok: false,
          error: fail(
            "InputError",
            `verb "${changes.verb}" is not legal for these endpoints`,
          ),
        };
      }
      nextEdge = { ...nextEdge, ether: { verb: changes.verb } };
    }
    const assignNullable = <K extends keyof CanvasEdge>(
      key: K,
      present: boolean,
      value: CanvasEdge[K] | null | undefined,
    ): void => {
      if (!present) return;
      if (value === null || value === undefined) {
        const { [key]: _removed, ...rest } = nextEdge;
        nextEdge = rest as CanvasEdge;
        return;
      }
      nextEdge = { ...nextEdge, [key]: value };
    };
    assignNullable("fromSide", Object.prototype.hasOwnProperty.call(changes, "fromSide"), changes.fromSide);
    assignNullable("fromEnd", Object.prototype.hasOwnProperty.call(changes, "fromEnd"), changes.fromEnd);
    assignNullable("toSide", Object.prototype.hasOwnProperty.call(changes, "toSide"), changes.toSide);
    assignNullable("toEnd", Object.prototype.hasOwnProperty.call(changes, "toEnd"), changes.toEnd);
    assignNullable("color", Object.prototype.hasOwnProperty.call(changes, "color"), changes.color);
    assignNullable("label", Object.prototype.hasOwnProperty.call(changes, "label"), changes.label);
    const edges = current.edges.map((edge) =>
      edge.id === args.edgeId ? nextEdge : edge,
    );
    const next: CanvasDoc = { ...current, edges };
    const cycle = flowCycleIfInvalid(next);
    if (cycle !== undefined) {
      return { ok: false, error: fail("InputError", cycle) };
    }
    return {
      ok: true,
      documents: putDoc(cloneDocs(view.documents), name, next),
      result: { edge: nextEdge },
    };
  });

const handleEdgeDisconnect = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"edge.disconnect">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  executeOnPortfolio((view) => {
    const revoked = requireGrant(view, caller);
    if (revoked) return { ok: false, error: revoked };
    const name = targetCanvas(caller, args.canvas);
    const current = view.documents.get(name);
    if (current === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", `canvas "${name}" does not exist`),
      };
    }
    if (findEdge(current, args.edgeId) === undefined) {
      return {
        ok: false,
        error: fail("UnknownTarget", `edge "${args.edgeId}" was not found`),
      };
    }
    return {
      ok: true,
      documents: putDoc(cloneDocs(view.documents), name, {
        ...current,
        edges: current.edges.filter((edge) => edge.id !== args.edgeId),
      }),
      result: { edgeId: args.edgeId },
    };
  });

const handleSheetRead = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"sheet.read">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const read = yield* readCanvas(targetCanvas(caller, args.canvas));
    const node = findNode(read.doc, args.target);
    if (node === undefined) {
      return yield* Effect.fail(
        fail("UnknownTarget", `node "${args.target}" was not found`),
      );
    }
    if (node.ether?.entity?.kind !== "sheet") {
      return yield* Effect.fail(
        fail("InputError", `node "${args.target}" is not a sheet`),
      );
    }
    return { sheet: node.ether.sheet ?? { columns: [], rows: [] } };
  });

const handleSheetConfigure = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"sheet.configure">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  mutateExistingNode(caller, args.canvas, args.target, (node) => {
    if (node.ether?.entity?.kind !== "sheet") {
      return fail("InputError", `node "${args.target}" is not a sheet`);
    }
    return {
      ...node,
      ether: {
        ...node.ether,
        sheet: args.sheet,
      },
    };
  });

const dispatch = (
  caller: OverseerCaller,
  operation: OverseerOperation,
  args: unknown,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> => {
  const decoded = decodeOverseerArgs(operation, args);
  if (Result.isFailure(decoded)) {
    return Effect.fail(schemaFailure(decoded.failure));
  }
  switch (operation) {
    case "canvas.list":
      return handleList();
    case "canvas.read":
      return handleRead(caller, decoded.success as OverseerArgsFor<"canvas.read">);
    case "canvas.create":
      return handleCreateCanvas(
        caller,
        decoded.success as OverseerArgsFor<"canvas.create">,
      );
    case "canvas.delete":
      return handleDeleteCanvas(
        caller,
        decoded.success as OverseerArgsFor<"canvas.delete">,
        hooks,
      );
    case "canvas.digest":
      return handleDigest(caller, decoded.success as OverseerArgsFor<"canvas.digest">);
    case "canvas.render":
      return handleRender(caller, decoded.success as OverseerArgsFor<"canvas.render">);
    case "node.list":
      return handleNodeList(caller, decoded.success as OverseerArgsFor<"node.list">);
    case "node.get":
      return handleNodeGet(caller, decoded.success as OverseerArgsFor<"node.get">);
    case "node.create":
      return handleNodeCreate(
        caller,
        decoded.success as OverseerArgsFor<"node.create">,
      );
    case "node.configure":
      return handleNodeConfigure(
        caller,
        decoded.success as OverseerArgsFor<"node.configure">,
      );
    case "node.move":
      return handleNodeMove(caller, decoded.success as OverseerArgsFor<"node.move">);
    case "node.resize":
      return handleNodeResize(
        caller,
        decoded.success as OverseerArgsFor<"node.resize">,
      );
    case "node.delete":
      return handleNodeDelete(
        caller,
        decoded.success as OverseerArgsFor<"node.delete">,
        hooks,
      );
    case "edge.list":
      return handleEdgeList(caller, decoded.success as OverseerArgsFor<"edge.list">);
    case "edge.get":
      return handleEdgeGet(caller, decoded.success as OverseerArgsFor<"edge.get">);
    case "edge.verbs":
      return handleEdgeVerbs(caller, decoded.success as OverseerArgsFor<"edge.verbs">);
    case "edge.connect":
      return handleEdgeConnect(
        caller,
        decoded.success as OverseerArgsFor<"edge.connect">,
      );
    case "edge.configure":
      return handleEdgeConfigure(
        caller,
        decoded.success as OverseerArgsFor<"edge.configure">,
      );
    case "edge.disconnect":
      return handleEdgeDisconnect(
        caller,
        decoded.success as OverseerArgsFor<"edge.disconnect">,
      );
    case "sheet.read":
      return handleSheetRead(caller, decoded.success as OverseerArgsFor<"sheet.read">);
    case "sheet.configure":
      return handleSheetConfigure(
        caller,
        decoded.success as OverseerArgsFor<"sheet.configure">,
      );
    default:
      return Effect.fail(
        fail("ProtocolError", `canvas dispatcher does not own ${operation}`),
      );
  }
};

const requireLiveGrant = (
  caller: OverseerCaller,
): Effect.Effect<void, WorkErrorBody, CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const live = yield* canvases.liveDocuments().pipe(Effect.mapError(fromCanvasError));
    const documents = new Map(
      live.map((row) => [row.canvasName, row.doc] as const),
    );
    const revoked = requireGrant(
      { documents, revisions: new Map() },
      caller,
    );
    if (revoked) return yield* Effect.fail(revoked);
  });

export const executeOverseerCanvas = (
  caller: OverseerCaller,
  request: OverseerRequest,
  hooks?: OverseerCanvasHooks,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> => {
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

export const commitAgentReseat = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"agent.reseat">,
  next: CanvasNode,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  mutateExistingNode(caller, args.canvas, args.nodeId, (existing) => {
    if (existing.ether?.entity?.kind !== "agent") {
      return fail("InputError", `node "${args.nodeId}" is not an agent`);
    }
    if (caller.canvasName === targetCanvas(caller, args.canvas) && caller.nodeId === args.nodeId) {
      return fail("AuthError", "overseer cannot reseat its own occupant");
    }
    return next;
  });

export const applySchedulerConfigure = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"scheduler.configure">,
): Effect.Effect<unknown, WorkErrorBody, CanvasesService> =>
  mutateExistingNode(caller, args.canvas, args.nodeId, (node) => {
    const kind = node.ether?.entity?.kind;
    if (kind !== "cron" && kind !== "timer" && kind !== "watcher" && kind !== "relay") {
      return fail("InputError", `node "${args.nodeId}" is not a scheduler`);
    }
    const ether = { ...(node.ether ?? {}) };
    if (Object.prototype.hasOwnProperty.call(args, "timer")) {
      if (args.timer === null) delete ether.timer;
      else if (args.timer !== undefined) ether.timer = args.timer;
    }
    if (Object.prototype.hasOwnProperty.call(args, "watch")) {
      if (args.watch === null) delete ether.watch;
      else if (args.watch !== undefined) ether.watch = args.watch;
    }
    return { ...node, ether };
  });

export { fromOverseerError };
