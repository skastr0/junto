import { isDeepStrictEqual } from "node:util";
import { Context, Effect, Option, Result, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { CanvasDoc } from "@shared/canvas";
import { decodeCanvasDoc, serializeCanvas } from "@shared/canvas";
import { SEED_CANVAS_NAME } from "@shared/seed";
import {
  Command,
  inPaintOrder,
  type Node,
  type NodeEdit,
  type Canvas,
  type SheetGrid,
} from "@shared/model";
import {
  nodeFromDocument,
  nodeToDocument,
  wireFromDocument,
  wireToDocument,
} from "@shared/model/from-document";
import { reconcileOverseerGrants } from "@shared/overseer-authoring";
import type {
  CanvasReadResult,
  CanvasWriteResult,
  CanvasOverseerSetInput,
} from "@shared/ipc";
import {
  CanvasesService,
  CanvasError,
  type CanvasChangeDetail,
  type CanvasPortfolioView,
  type CanvasPortfolioEdit,
  type CanvasReadTag,
} from "../canvases";
import { canvasBodySha256Of, intentSha256Of } from "../canvas-intent-identity";
import { canvasNameFrom, toCanvasError } from "../canvas/domain";
import {
  WorkRepository,
  WorkProjectionReader,
  projectWorkSnapshots,
} from "../work/repository";
import { StateTransactionOperation } from "../state/service";
import { afterSqlCommit } from "../state/sql-commit";
import { withSqlRead } from "../state/sql-read";
import { ModelService } from "./service";
import { ModelActorRefs } from "./actor-refs";
import { ModelRefused, ModelNotFound, ModelStorageError } from "./records";

const failure = Effect.mapError((cause: unknown) => {
  if (cause instanceof ModelRefused)
    return new CanvasError({ message: cause.rule });
  if (cause instanceof ModelNotFound)
    return new CanvasError({
      message: `${cause.what} "${cause.id}" does not exist`,
    });
  if (cause instanceof ModelStorageError) return toCanvasError(cause.cause);
  return toCanvasError(cause);
});

/** Temporary public-method facade. The kinds are the only stored authority. */
export const makeModelCanvases = Effect.gen(function* () {
  const model = yield* ModelService;
  const actors = yield* ModelActorRefs;
  const sql = yield* SqlClient.SqlClient;
  const work = yield* WorkRepository;
  const workReader = yield* WorkProjectionReader;
  const listeners = new Set<
    (name: string, detail?: CanvasChangeDetail) => void
  >();
  const documents = new WeakMap<Canvas, CanvasDoc>();
  const last = new Map<string, CanvasDoc>();
  const lastCanvas = new Map<string, Canvas>();
  const grids = new Map<string, SheetGrid>();
  let muted = 0;
  const pending = new Map<string, CanvasChangeDetail>();

  const canonicalName = (name: string) => Effect.try({ try: () => canvasNameFrom(name), catch: toCanvasError });
  const document = Effect.fn("Canvases.modelDocument")(function* (
    name: string,
  ) {
    name = yield* canonicalName(name);
    const canvas = yield* model.canvas(name);
    const cacheable = Option.isNone(
      yield* Effect.serviceOption(sql.transactionService),
    );
    const cached = cacheable ? documents.get(canvas) : undefined;
    if (cached) return cached;
    const nodes = inPaintOrder(canvas).map(nodeToDocument);
    // The legacy sheet editor needs its grid until it moves to modelSheetRead.
    for (const [index, node] of nodes.entries()) {
      if (node.ether?.entity?.kind !== "sheet") continue;
      const grid = yield* model.readSheet(name, node.id);
      if (grid) {
        nodes[index] = { ...node, ether: { ...node.ether, sheet: grid } };
        if (cacheable) grids.set(`${name}/${node.id}`, grid);
      }
    }
    const doc: CanvasDoc = {
      nodes,
      edges: [...canvas.wires.values()].map(wireToDocument),
    };
    if (cacheable) {
      documents.set(canvas, doc);
      last.set(name, doc);
      lastCanvas.set(name, canvas);
    }
    return doc;
  });
  const revision = (name: string) =>
    document(name).pipe(
      Effect.map((doc) => canvasBodySha256Of(serializeCanvas(doc))),
    );
  const notify = (name: string, detail?: CanvasChangeDetail) => {
    for (const listener of [...listeners]) {
      try {
        listener(name, detail);
      } catch (cause) {
        console.error("[canvases] change listener failed", cause);
      }
    }
  };
  const emit = (name: string, detail: CanvasChangeDetail) => {
    if (muted)
      pending.set(name, {
        previous: pending.has(name)
          ? pending.get(name)!.previous
          : detail.previous,
        next: detail.next,
      });
    else notify(name, detail);
  };
  const spatialDocument = (canvas: Canvas): CanvasDoc => ({
    nodes: inPaintOrder(canvas).map((node) => {
      const result = nodeToDocument(node);
      const grid = grids.get(`${canvas.name}/${node.id}`);
      return node.kind === "sheet" && grid
        ? { ...result, ether: { ...result.ether, sheet: grid } }
        : result;
    }),
    edges: [...canvas.wires.values()].map(wireToDocument),
  });
  const unwatchChanges = model.subscribeChanges((event, current) => {
    const previous = last.get(event.canvas);
    const next = spatialDocument(current);
    documents.set(current, next);
    lastCanvas.set(event.canvas, current);
    last.set(event.canvas, next);
    emit(event.canvas, { previous, next });
  });
  const unwatchCanvases = model.subscribeCanvasesChanges((event, current) => {
    if (event._tag === "Removed") {
      const name = event.canvas;
      const previous = last.get(name);
      last.delete(name);
      lastCanvas.delete(name);
      emit(name, { previous, next: undefined });
    }
    if (current) {
      const next = spatialDocument(current);
      last.set(current.name, next);
      lastCanvas.set(current.name, current);
      documents.set(current, next);
      emit(current.name, { previous: undefined, next });
    }
  });
  const unwatchSheets = model.subscribeSheetChanges((event, grid) => {
    grids.set(`${event.canvas}/${event.id}`, grid);
    const current = lastCanvas.get(event.canvas);
    if (!current) return;
    const previous = last.get(event.canvas);
    const next = spatialDocument(current);
    documents.set(current, next);
    last.set(event.canvas, next);
    emit(event.canvas, { previous, next });
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unwatchChanges();
      unwatchCanvases();
      unwatchSheets();
    }),
  );
  const unsubscribeWork = work.subscribeChanges((name, _id, kind) => {
    if (kind !== "mail") notify(name);
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeWork));
  const transaction = <A, E, R>(
    operation: string,
    body: Effect.Effect<A, E, R>,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* afterSqlCommit(sql, () => {
            muted++;
          });
          const result = yield* body;
          yield* afterSqlCommit(sql, () => {
            if (--muted !== 0) return;
            const notices = [...pending];
            pending.clear();
            for (const [name, detail] of notices) notify(name, detail);
          });
          return result;
        }),
      )
      .pipe(
        Effect.provideService(StateTransactionOperation, operation),
        failure,
      );
  const read = Effect.fn("Canvases.readModel")(function* (
    name: string,
    _tag?: CanvasReadTag,
  ): Effect.fn.Return<CanvasReadResult, CanvasError> {
    name = yield* canonicalName(name);
    return yield* withSqlRead(
      sql,
      Effect.gen(function* () {
        const doc = yield* document(name);
        const projection = yield* workReader.canvasProjection(name);
        return {
          name,
          doc: projectWorkSnapshots(doc, projection.snapshots),
          actorRefs: yield* actors.read(name),
          revision: canvasBodySha256Of(serializeCanvas(doc)),
          workRevision: projection.workRevision,
        };
      }),
    ).pipe(failure);
  });
  const send = (input: unknown, source: "operator" | "runtime" = "operator") =>
    Effect.gen(function* () {
      const value = input as { canvas: string; to?: string };
      const canvas = yield* canonicalName(value.canvas);
      const to = value.to === undefined ? undefined : yield* canonicalName(value.to);
      const command = yield* Schema.decodeUnknownEffect(Command)({ ...value, canvas, ...(to === undefined ? {} : { to }) }, { onExcessProperty: "error" });
      return yield* model.command(command, source);
    });
  const replace = Effect.fn("Canvases.replaceModel")(function* (
    name: string,
    input: CanvasDoc,
    expected?: string,
  ) {
    name = yield* canonicalName(name);
    const current = yield* model.canvas(name);
    const steps: unknown[] = [];
    const sessionStamps: unknown[] = [];
    const queue = (input: unknown, source: "operator" | "runtime" = "operator") =>
      Effect.sync(() => { (source === "runtime" ? sessionStamps : steps).push(input); });
    const before = yield* document(name);
    if (
      expected !== undefined &&
      canvasBodySha256Of(serializeCanvas(before)) !== expected
    )
      return yield* new CanvasError({
        message: `canvas "${name}" revision conflict; reload before saving`,
      });
    const decodedResult = decodeCanvasDoc(
      reconcileOverseerGrants(before, input),
    );
    if (Result.isFailure(decodedResult))
      return yield* new CanvasError({ message: String(decodedResult.failure) });
    const decoded = decodedResult.success;
    const nextNodes = decoded.nodes.map((node, z) =>
      nodeFromDocument(name, node, z),
    );
    const nextWires = decoded.edges.map((wire) => wireFromDocument(name, wire));
    const replaces = new Set<string>();
    for (const node of nextNodes) {
      const old = current.nodes.get(node.id);
      if (
        old &&
        (old.kind !== node.kind ||
          (old.kind === "agent" &&
            node.kind === "agent" &&
            (old.agentKey !== node.agentKey ||
              old.bindingId !== node.bindingId)) ||
          (old.kind === "terminal" &&
            node.kind === "terminal" &&
            old.bindingId !== node.bindingId))
      )
        replaces.add(node.id);
    }
    const nodeIds = new Set(nextNodes.map((node) => node.id));
    const wireIds = new Set(nextWires.map((wire) => wire.id));
    const removals = [...current.nodes.keys()].filter(
      (id) => !nodeIds.has(id) || replaces.has(id),
    );
    const removedWires = [...current.wires.values()]
      .filter(
        (wire) =>
          !wireIds.has(wire.id) ||
          nextWires.some(
            (next) =>
              next.id === wire.id &&
              (next.from !== wire.from || next.to !== wire.to),
          ),
      )
      .map((wire) => wire.id);
    if (removals.length || removedWires.length)
      yield* queue({
        _tag: "Remove",
        canvas: name,
        nodes: removals,
        wires: removedWires,
      });
    const added = nextNodes.filter(
      (node) => !current.nodes.has(node.id) || replaces.has(node.id),
    );
    if (added.length)
      yield* queue({ _tag: "Add", canvas: name, nodes: added, wires: [] });
    for (const node of nextNodes) {
      const old = current.nodes.get(node.id);
      if (!old || replaces.has(node.id)) continue;
      if (
        old.x !== node.x ||
        old.y !== node.y ||
        old.width !== node.width ||
        old.height !== node.height
      ) {
        yield* queue({
          _tag: "Move",
          canvas: name,
          moves: [
            {
              id: node.id,
              x: node.x,
              y: node.y,
              size: { width: node.width, height: node.height },
            },
          ],
        });
      }
      if (old.color !== node.color)
        yield* queue({
          _tag: "Recolor",
          canvas: name,
          nodes: [node.id],
          color: node.color ?? null,
        });
      const change: Record<string, unknown> = { kind: node.kind };
      const fields = new Set([...Object.keys(old), ...Object.keys(node)]);
      for (const key of fields) {
        if (
          [
            "id",
            "kind",
            "x",
            "y",
            "width",
            "height",
            "z",
            "color",
            "agentKey",
            "bindingId",
            "overseer",
            "sessionId",
          ].includes(key)
        )
          continue;
        const value = (node as unknown as Record<string, unknown>)[key];
        if (
          !isDeepStrictEqual(
            (old as unknown as Record<string, unknown>)[key],
            value,
          )
        )
          change[key] = value ?? null;
      }
      if (Object.keys(change).length > 1)
        yield* queue({ _tag: "Edit", canvas: name, id: node.id, change });
      if (
        old.kind === "agent" &&
        node.kind === "agent" &&
        old.sessionId !== node.sessionId
      ) {
        yield* queue(
          {
            _tag: "RecordSession",
            canvas: name,
            id: node.id,
            sessionId: node.sessionId ?? null,
          },
          "runtime",
        );
      }
    }
    const previousOrder = inPaintOrder(current)
      .map((node) => node.id)
      .filter((id) => nodeIds.has(id));
    const proposedOrder = nextNodes
      .map((node) => node.id)
      .filter((id) => current.nodes.has(id));
    if (!isDeepStrictEqual(previousOrder, proposedOrder))
      yield* queue({
        _tag: "Move", canvas: name,
        moves: nextNodes.map((node) => ({ id: node.id, x: node.x, y: node.y, z: node.z })),
      });
    // Removing a node also removes its attached wires within the pending batch.
    const removedNodeIds = new Set(removals);
    const removedWireIds = new Set(removedWires);
    const survivingWires = new Map([...current.wires].filter(([id, wire]) =>
      !removedWireIds.has(id) && !removedNodeIds.has(wire.from) && !removedNodeIds.has(wire.to),
    ));
    for (const wire of nextWires) {
      const old = survivingWires.get(wire.id);
      if (!old)
        yield* queue({ _tag: "Add", canvas: name, nodes: [], wires: [wire] });
      else if (!isDeepStrictEqual(old, wire))
        yield* queue({
          _tag: "Rewire",
          canvas: name,
          id: wire.id,
          change: {
            verb: wire.verb,
            mask: wire.mask ?? null,
            fromSide: wire.fromSide ?? null,
            toSide: wire.toSide ?? null,
          },
        });
    }
    for (const node of decoded.nodes) {
      if (node.ether?.entity?.kind === "sheet")
        yield* queue({
          _tag: "WriteSheet",
          canvas: name,
          id: node.id,
          grid: node.ether.sheet ?? { columns: [], rows: [] },
        });
    }
    if (steps.length) yield* send({ _tag: "Batch", canvas: name, steps });
    // Capture remains a runtime operation, outside the operator's edit batch.
    for (const stamp of sessionStamps) yield* send(stamp, "runtime");
    // Session drafts are read before commit, so the facade reports the result
    // that was actually written, never a revision supplied by its caller.
    documents.delete(yield* model.canvas(name));
    return { revision: yield* revision(name) };
  }, failure);
  const write = (name: string, doc: CanvasDoc, expected?: string) =>
    transaction(
      "canvas.write",
      Effect.gen(function* () {
        name = yield* canonicalName(name);
        if (!(yield* model.listCanvases()).includes(name as never)) {
          if (expected !== undefined)
            return yield* new CanvasError({
              message: "Canvas no longer exists; reload before saving.",
            });
          yield* send({ _tag: "CreateCanvas", canvas: name });
        }
        return yield* replace(name, doc, expected);
      }),
    );
  const view = Effect.fn("Canvases.modelPortfolio")(function* () {
    const docs = new Map<string, CanvasDoc>();
    const revisions = new Map<string, string>();
    for (const name of yield* model.listCanvases()) {
      const doc = yield* document(name);
      docs.set(name, doc);
      revisions.set(name, canvasBodySha256Of(serializeCanvas(doc)));
    }
    return { documents: docs, revisions } satisfies CanvasPortfolioView;
  });
  const material = () =>
    view().pipe(
      Effect.map((current) => {
        const storedDocuments = new Map(
          [...current.documents].map(([name, document]) => [
            name,
            {
              document,
              rawBody: serializeCanvas(document),
              revisionSha256: current.revisions.get(name)!,
            },
          ]),
        );
        return {
          documents: current.documents,
          storedDocuments,
          generation: "0",
          intentSha256: intentSha256Of(
            new Map(
              [...current.revisions].map(([name, revisionSha256]) => [
                name,
                { revisionSha256 },
              ]),
            ),
          ),
        };
      }),
      failure,
    );
  const mutatePortfolio = <A>(
    fn: (current: CanvasPortfolioView) => CanvasPortfolioEdit<A>,
  ) =>
    transaction(
      "canvas.mutatePortfolio",
      Effect.gen(function* () {
        const current = yield* view();
        const edit = yield* Effect.try({
          try: () => fn(current),
          catch: toCanvasError,
        });
        if (!edit.ok) return { _tag: "Rejected" as const, error: edit.error };
        const affected: Array<{ name: string; revision: string }> = [];
        for (const name of current.documents.keys())
          if (!edit.mutation.documents.has(name))
            yield* send({ _tag: "RemoveCanvas", canvas: name });
        for (const [name, doc] of edit.mutation.documents) {
          if (!current.documents.has(name))
            yield* send({ _tag: "CreateCanvas", canvas: name });
          const result = yield* replace(name, doc);
          if (current.revisions.get(name) !== result.revision)
            affected.push({ name, revision: result.revision });
        }
        return { _tag: "Committed" as const, commit: { result: edit.mutation.result, affected } };
      }),
    ).pipe(Effect.flatMap((outcome) => outcome._tag === "Rejected" ? Effect.fail(outcome.error) : Effect.succeed(outcome.commit)));
  const canvasOverseerSet = (input: CanvasOverseerSetInput) =>
    transaction(
      "canvas.overseerSet",
      Effect.gen(function* () {
        if ((yield* revision(input.canvasName)) !== input.expectedRevision)
          return yield* new CanvasError({
            message: "Canvas changed; reload before changing seat authority.",
          });
        const current = yield* model.canvas(input.canvasName);
        const node = current.nodes.get(input.nodeId as Node["id"]);
        if (!node || node.kind !== "agent")
          return yield* new CanvasError({ message: "Choose an agent seat." });
        const affected: Array<{ name: string; revision: string }> = [];
        for (const name of yield* model.listCanvases()) {
          for (const alias of (yield* model.canvas(name)).nodes.values()) {
            if (
              alias.kind !== "agent" ||
              alias.host !== node.host ||
              alias.bindingId !== node.bindingId
            )
              continue;
            yield* send({
              _tag: "GrantOverseer",
              canvas: name,
              id: alias.id,
              overseer: input.overseer,
            });
            affected.push({ name, revision: yield* revision(name) });
          }
        }
        return {
          binding: { hostId: node.host, bindingId: node.bindingId },
          overseer: input.overseer,
          affected,
        };
      }),
    );
  const create = (name: string) =>
    send({ _tag: "CreateCanvas", canvas: name }).pipe(
      Effect.flatMap(() => read(name)),
      failure,
    );
  const ensureSeed = Effect.gen(function* () {
    if ((yield* model.listCanvases()).length === 0)
      yield* send({ _tag: "CreateCanvas", canvas: SEED_CANVAS_NAME });
  }).pipe(failure);
  return CanvasesService.of({
    list: sql`SELECT canvas_name,updated_at FROM canvases ORDER BY canvas_name`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          name: String(row.canvas_name),
          modifiedAt: String(row.updated_at),
        })),
      ),
      failure,
    ),
    read,
    write,
    create,
    ensureSeed,
    canvasOverseerSet,
    readWithIntentWitness: (name, tag) =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          name = yield* canonicalName(name);
          const current = yield* model.canvas(name);
          const result = yield* read(name, tag);
          return {
            read: result,
            intentWitness: {
              canvasName: current.name,
              seq: current.seq,
              generation: String(current.seq),
              contentSha256: result.revision,
            },
          };
        }),
      ).pipe(failure),
    readNodeStructure: (name, id) =>
      document(name).pipe(
        Effect.map((doc) => {
          const node = doc.nodes.find((node) => node.id === id);
          return node
            ? {
                name,
                node,
                structure: doc,
                revision: canvasBodySha256Of(serializeCanvas(doc)),
              }
            : undefined;
        }),
        failure,
      ),
    mutate: (name, fn) =>
      transaction(
        "canvas.mutate",
        Effect.gen(function* () {
          const doc = yield* document(name);
          const next = yield* Effect.try({
            try: () => fn(doc),
            catch: toCanvasError,
          });
          yield* replace(name, next);
        }),
      ),
    mutatePortfolio,
    remove: (name) =>
      send({ _tag: "RemoveCanvas", canvas: name }).pipe(
        Effect.as({ name }),
        failure,
      ),
    start: () => {},
    subscribeChanges: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    announceInstalledProjection: (changes) => {
      for (const change of changes) notify(change.name, change.detail);
    },
    liveDocuments: () =>
      view().pipe(
        Effect.map((current) =>
          [...current.documents].map(([canvasName, doc]) => ({
            canvasName,
            doc,
          })),
        ),
        failure,
      ),
    activeActorRefs: () => actors.read().pipe(failure),
    authorityMaterialSnapshot: material,
    authoritySnapshot: () =>
      material().pipe(
        Effect.map(({ storedDocuments: _, ...snapshot }) => snapshot),
      ),
    liveAuthorityGeneration: () => Effect.succeed("0"),
    activeIntentWitness: () =>
      material().pipe(
        Effect.map((snapshot) => ({
          generation: snapshot.generation,
          contentSha256: snapshot.intentSha256,
        })),
      ),
    doctor: model.listCanvases().pipe(
      Effect.match({
        onFailure: () => ({
          id: "canvases",
          label: "Canvases",
          status: "error" as const,
          detail: "Canvas storage is unavailable",
        }),
        onSuccess: (names) => ({
          id: "canvases",
          label: "Canvases",
          status: "ok" as const,
          detail: `${names.length} canvases`,
        }),
      }),
    ),
  });
});
