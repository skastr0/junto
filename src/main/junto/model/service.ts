import { isDeepStrictEqual } from "node:util";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ulid } from "ulid";
import {
  CanvasName,
  Command,
  Node,
  Wire,
  canvasFromOpened,
  follow,
  inPaintOrder,
  type Canvas,
  type Changed,
  type SheetChanged,
  type SheetGrid,
  type CanvasesChanged,
  type Opened,
} from "@shared/model";
import { ModelDependents } from "./dependents";
import { SEED_CANVAS_NAME } from "@shared/seed";
import { normalizeNode } from "@shared/model/normalize";
import { compileVerb } from "@shared/physics/verbs";
import {
  afterSqlCommit,
  sqlTransactionLocal,
  setSqlTransactionLocal,
} from "../state/sql-commit";
import { withSqlRead } from "../state/sql-read";
import { StateTransactionOperation } from "../state/service";
import {
  ModelNotFound,
  ModelRefused,
  ModelRecords,
  modelError,
} from "./records";

const patch = (original: object, change: object): object => {
  const result: Record<string, unknown> = { ...original };
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
};
const refused = (rule: string) => new ModelRefused({ rule });
type Drafts = ReadonlyMap<string, Canvas | null>;

export class ModelService extends Context.Service<ModelService>()(
  "@junto/ModelService",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const records = yield* ModelRecords;
      const dependents = yield* ModelDependents;
      const held = new Map<string, Canvas>();
      const draftKey = Symbol("ModelService.canvases");
      // Slow subscribers reopen on a seq gap; they cannot stall a commit.
      const changes = yield* PubSub.sliding<Changed>(1024);
      const sheetChanges = yield* PubSub.sliding<SheetChanged>(256);
      const canvasChanges = yield* PubSub.sliding<CanvasesChanged>(64);
      const listeners = new Set<(event: Changed, current: Canvas) => void>();
      const canvasListeners = new Set<
        (event: CanvasesChanged, current?: Canvas) => void
      >();
      const sheetListeners = new Set<
        (event: SheetChanged, grid: SheetGrid) => void
      >();
      const notify = <A extends ReadonlyArray<unknown>>(
        targets: ReadonlySet<(...args: A) => void>,
        ...args: A
      ) => {
        for (const listener of [...targets]) {
          try {
            listener(...args);
          } catch (cause) {
            console.error("[model] change listener failed", cause);
          }
        }
      };
      const publishChange = (event: Changed, current: Canvas) =>
        afterSqlCommit(sql, () => {
          const applied = follow(held.get(event.canvas) ?? current, event);
          if (applied._tag === "Applied") {
            held.set(event.canvas, applied.canvas);
            notify(listeners, event, applied.canvas);
          } else held.delete(event.canvas);
          PubSub.publishUnsafe(changes, event);
        });

      const stage = (name: string, value: Canvas | null) =>
        Effect.gen(function* () {
          const drafts = yield* sqlTransactionLocal<Drafts>(sql, draftKey);
          yield* setSqlTransactionLocal(
            sql,
            draftKey,
            new Map([...(drafts ?? []), [name, value]]),
          );
        });
      const canvas = Effect.fn("ModelService.canvas")(function* (name: string) {
        const decoded = yield* Schema.decodeUnknownEffect(CanvasName)(
          name,
        ).pipe(Effect.mapError(() => refused("Use a valid canvas name.")));
        const read = Effect.gen(function* () {
          const drafts = yield* sqlTransactionLocal<Drafts>(sql, draftKey);
          if (drafts?.has(name)) {
            const value = drafts.get(name);
            if (!value)
              return yield* new ModelNotFound({ what: "canvas", id: name });
            return value;
          }
          const known = held.get(name);
          if (known) return known;
          const header = yield* records.getCanvas(name);
          if (!header)
            return yield* new ModelNotFound({ what: "canvas", id: name });
          const loaded = canvasFromOpened({
            canvas: decoded,
            seq: header.seq,
            nodes: yield* records.listNodes(name),
            wires: yield* records.listWires(name),
          });
          yield* afterSqlCommit(sql, () => {
            held.set(name, loaded);
          });
          return loaded;
        });
        return yield* withSqlRead(sql, read).pipe(
          Effect.mapError((cause) => modelError("canvas", cause)),
        );
      });
      /**
       * Take a copy of a canvas another machine edits. A copy replaces what
       * this machine holds of that canvas when it is newer; the same or an
       * older copy changes nothing.
       *
       * A name is one canvas on a machine. When this machine already has
       * another canvas of that name, the copy is not installed and the answer
       * says so, with one exception: this machine's own canvas that never
       * changed holds nothing, so the copy takes its place, id and editing
       * machine included.
       *
       * Refused for a copy this machine would edit, and for a copy that names
       * another editing machine for a canvas this machine already holds.
       */
      const installCopy = Effect.fn("ModelService.installCopy")(function* (input: {
        readonly canvas: CanvasName;
        readonly canvasId: string;
        readonly seq: number;
        readonly editor: string;
        readonly nodes: ReadonlyArray<Node>;
        readonly wires: ReadonlyArray<Wire>;
      }) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const self = yield* records.thisInstallation();
              if (input.editor === self) {
                return yield* refused("A machine holds no copy of a canvas it edits.");
              }
              const header = yield* records.getCanvas(input.canvas);
              if (header !== undefined) {
                const editor = yield* records.canvasEditor(input.canvas);
                if (header.canvas_id !== input.canvasId) {
                  const ownAndNeverChanged = (editor === undefined || editor === self) && header.seq === 0;
                  if (!ownAndNeverChanged) {
                    return { installed: false as const, refused: "a-canvas-of-that-name" as const };
                  }
                } else {
                  if (editor !== input.editor) {
                    return yield* refused("A copy does not change which machine edits a canvas.");
                  }
                  if (header.seq >= input.seq) return { installed: false as const, seq: header.seq };
                }
              }
              yield* records.replaceCanvas(input);
              const replaced = canvasFromOpened({ canvas: input.canvas, seq: input.seq, nodes: input.nodes, wires: input.wires });
              yield* stage(input.canvas, replaced);
              yield* afterSqlCommit(sql, () => {
                held.set(input.canvas, replaced);
                const event: CanvasesChanged = { _tag: "Replaced", canvas: input.canvas };
                notify(canvasListeners, event, replaced);
                PubSub.publishUnsafe(canvasChanges, event);
              });
              return { installed: true as const, seq: input.seq };
            }),
          )
          .pipe(Effect.mapError((cause) => modelError("installCopy", cause)));
      });
      const open = Effect.fn("ModelService.open")(function* (name: string) {
        const current = yield* canvas(name);
        return {
          canvas: current.name,
          seq: current.seq,
          nodes: inPaintOrder(current),
          wires: [...current.wires.values()],
        } satisfies Opened;
      });
      const command = Effect.fn("ModelService.command")(function* (
        input: Command,
        source: "operator" | "runtime" | "overseer",
      ) {
        const command = yield* Schema.decodeUnknownEffect(Command)(input, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(() =>
            refused("Send a command that matches the model command schema."),
          ),
        );
        if (
          source === "runtime" ||
          (command._tag === "GrantOverseer" && source !== "operator")
        ) {
          return yield* refused(
            "Only the operator changes overseer authority. Canvas changes require operator or overseer authoring.",
          );
        }
        yield* Effect.annotateCurrentSpan("canvas", command.canvas);
        yield* Effect.annotateCurrentSpan("command", command._tag);
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (command._tag === "CreateCanvas") {
                const drafts = yield* sqlTransactionLocal<Drafts>(
                  sql,
                  draftKey,
                );
                if (
                  drafts?.get(command.canvas) ||
                  (!drafts?.has(command.canvas) &&
                    (held.has(command.canvas) ||
                      (yield* records.getCanvas(command.canvas))))
                ) {
                  return yield* refused(
                    "Choose a canvas name that does not already exist.",
                  );
                }
                yield* records.createCanvas(command.canvas, ulid());
                const created = canvasFromOpened({
                  canvas: command.canvas,
                  seq: 0,
                  nodes: [],
                  wires: [],
                });
                yield* stage(command.canvas, created);
                yield* afterSqlCommit(sql, () => {
                  held.set(command.canvas, created);
                  const event: CanvasesChanged = {
                    _tag: "Created",
                    canvas: command.canvas,
                  };
                  notify(canvasListeners, event, created);
                  PubSub.publishUnsafe(canvasChanges, event);
                });
                return { seq: 0 };
              }
              // A machine changes only the canvases it edits.
              if (!(yield* records.editsCanvas(command.canvas))) {
                return yield* refused(
                  "This canvas is edited on another machine; this machine holds a copy of it.",
                );
              }
              const current = yield* canvas(command.canvas);
              const nodesById = new Map(current.nodes);
              const wiresById = new Map(current.wires);
              const requireNode = (id: string) => {
                const node = nodesById.get(id as Node["id"]);
                return node
                  ? Effect.succeed(node)
                  : Effect.fail(new ModelNotFound({ what: "node", id }));
              };
              const requireWire = (id: string) => {
                const wire = wiresById.get(id as Wire["id"]);
                return wire
                  ? Effect.succeed(wire)
                  : Effect.fail(new ModelNotFound({ what: "wire", id }));
              };
              const mayChange = (node: Node, presentation = false) =>
                node.kind === "agent" &&
                node.overseer &&
                source !== "operator" &&
                !(source === "overseer" && presentation)
                  ? Effect.fail(
                      refused(
                        "Only the operator can change what an overseer seat runs or remove it.",
                      ),
                    )
                  : Effect.void;
              if (command._tag === "RemoveCanvas") {
                for (const node of current.nodes.values()) yield* mayChange(node);
                yield* dependents.removeCanvas(command.canvas);
                yield* records.removeCanvas(command.canvas);
                yield* stage(command.canvas, null);
                yield* afterSqlCommit(sql, () => {
                  held.delete(command.canvas);
                  const event: CanvasesChanged = { _tag: "Removed", canvas: command.canvas };
                  notify(canvasListeners, event);
                  PubSub.publishUnsafe(canvasChanges, event);
                });
                return { seq: 0 };
              }
              if (command._tag === "GrantOverseer") {
                const seat = yield* requireNode(command.id);
                if (seat.kind !== "agent")
                  return yield* refused("This command requires an agent seat.");
                let replySeq = current.seq;
                for (const name of yield* records.listCanvases()) {
                  const aliasCanvas = yield* canvas(name);
                  const updates: Node[] = [];
                  for (const alias of aliasCanvas.nodes.values()) {
                    if (
                      alias.kind !== "agent" ||
                      alias.bindingId !== seat.bindingId ||
                      alias.host !== seat.host ||
                      alias.overseer === command.overseer
                    )
                      continue;
                    const next = { ...alias, overseer: command.overseer };
                    yield* records.updateNode(name, next);
                    updates.push(next);
                  }
                  if (!updates.length) continue;
                  const seq = yield* records.advanceSeq(name);
                  const event: Changed = {
                    canvas: aliasCanvas.name,
                    seq,
                    nodes: updates,
                    wires: [],
                    removedNodes: [],
                    removedWires: [],
                  };
                  const applied = follow(aliasCanvas, event);
                  if (applied._tag !== "Applied")
                    return yield* refused(
                      "The canvas sequence changed unexpectedly.",
                    );
                  yield* stage(name, applied.canvas);
                  yield* publishChange(event, aliasCanvas);
                  if (name === command.canvas) replySeq = seq;
                }
                return { seq: replySeq };
              }
              const reseatedBindings = new Set<string>();
              const sheetUpdates = new Map<Node["id"], SheetGrid>();
              const writtenSheets = new Set<Node["id"]>();
              const saveNode = Effect.fn("ModelService.saveNode")(function* (
                node: Node,
                presentation = false,
              ) {
                const previous = yield* requireNode(node.id);
                yield* mayChange(previous, presentation);
                if (isDeepStrictEqual(previous, node)) return;
                nodesById.set(node.id, node);
              });
              const validateWire = Effect.fn("ModelService.validateWire")(
                function* (wire: Wire) {
                  const from = yield* requireNode(wire.from);
                  const to = yield* requireNode(wire.to);
                  if (compileVerb(wire.verb, from.kind, to.kind) === undefined)
                    return yield* refused(
                      "Choose a relationship allowed between these kinds.",
                    );
                  if (
                    [...wiresById.values()].some(
                      (other) =>
                        other.id !== wire.id &&
                        other.from === wire.from &&
                        other.to === wire.to &&
                        other.verb === wire.verb,
                    )
                  ) {
                    return yield* refused(
                      "These objects already have this relationship.",
                    );
                  }
                  if (wire.verb === "feeds" || wire.verb === "chains") {
                    const pending = [wire.to];
                    const seen = new Set<string>();
                    while (pending.length > 0) {
                      const id = pending.pop()!;
                      if (id === wire.from)
                        return yield* refused(
                          "This relationship would create a cycle.",
                        );
                      if (seen.has(id)) continue;
                      seen.add(id);
                      for (const next of wiresById.values()) {
                        if (
                          next.id !== wire.id &&
                          next.verb === wire.verb &&
                          next.from === id
                        )
                          pending.push(next.to);
                      }
                    }
                  }
                },
              );
              const decodeNode = (value: unknown) =>
                Schema.decodeUnknownEffect(Node)(value, {
                  onExcessProperty: "error",
                }).pipe(
                  Effect.map(normalizeNode),
                  Effect.mapError(() =>
                    refused("Use values allowed for this kind."),
                  ),
                );
              const steps = command._tag === "Batch" ? command.steps : [command];
              for (const step of steps) {
                if (step.canvas !== command.canvas) return yield* refused("Every batch step must name the same canvas.");
                switch (step._tag) {
                case "Add":
                  for (const node of step.nodes.map(normalizeNode)) {
                    if (node.kind === "agent") yield* records.requireSeatHost(node.host);
                    if (
                      node.kind === "agent" &&
                      node.overseer &&
                      source !== "operator"
                    )
                      return yield* refused(
                        "Only the operator can add an overseer seat.",
                      );
                    if (nodesById.has(node.id))
                      return yield* refused("Use a new object id.");
                    if (
                      (node.kind === "agent" || node.kind === "terminal") &&
                      [...nodesById.values()].some(
                        (other) =>
                          (other.kind === "agent" ||
                            other.kind === "terminal") &&
                          other.bindingId === node.bindingId,
                      )
                    ) {
                      return yield* refused(
                        "A seat or terminal already uses this session binding on this canvas.",
                      );
                    }
                    if (node.kind === "sheet") sheetUpdates.set(node.id, { columns: [], rows: [] });
                    nodesById.set(node.id, node);
                  }
                  for (const wire of step.wires) {
                    if (wiresById.has(wire.id))
                      return yield* refused("Use a new relationship id.");
                    yield* validateWire(wire);
                    wiresById.set(wire.id, wire);
                  }
                  break;
                case "Remove":
                  for (const id of step.wires) {
                    yield* requireWire(id);
                    wiresById.delete(id);
                  }
                  for (const id of step.nodes) {
                    const node = yield* requireNode(id);
                    yield* mayChange(node);
                    for (const wire of wiresById.values()) {
                      if (wire.from !== id && wire.to !== id) continue;
                      wiresById.delete(wire.id);
                    }
                    nodesById.delete(id);
                    sheetUpdates.delete(id);
                    writtenSheets.delete(id);
                  }
                  break;
                case "Move":
                  for (const move of step.moves)
                    yield* saveNode(
                      yield* decodeNode({
                        ...(yield* requireNode(move.id)),
                        x: move.x,
                        y: move.y,
                        ...move.size,
                        ...(move.z === undefined ? {} : { z: move.z }),
                      }),
                      true,
                    );
                  break;
                case "Restack": {
                  const selected = new Set(step.nodes);
                  for (const id of selected) yield* requireNode(id);
                  const moving = inPaintOrder({ ...current, nodes: nodesById }).filter((node) =>
                    selected.has(node.id),
                  );
                  const extremes = [...nodesById.values()].map(
                    (node) => node.z,
                  );
                  let z =
                    step.to === "front"
                      ? Math.max(0, ...extremes) + 1
                      : Math.min(0, ...extremes) - moving.length;
                  for (const node of moving)
                    yield* saveNode(yield* decodeNode({ ...node, z: z++ }), true);
                  break;
                }
                case "Recolor":
                  for (const id of step.nodes)
                    yield* saveNode(
                      yield* decodeNode(
                        patch(yield* requireNode(id), { color: step.color }),
                      ),
                      true,
                    );
                  break;
                case "Edit": {
                  const node = yield* requireNode(step.id);
                  if (node.kind !== step.change.kind)
                    return yield* refused(
                      "Edit fields must belong to the object's kind.",
                    );
                  const edited = yield* decodeNode(patch(node, step.change));
                  if (edited.kind === "agent" && node.kind === "agent" && edited.host !== node.host) yield* records.requireSeatHost(edited.host);
                  yield* saveNode(edited, Object.keys(step.change).every((key) => key === "kind" || key === "label"));
                  break;
                }
                case "Reseat": {
                  const node = yield* requireNode(step.id);
                  if (node.kind !== "agent") return yield* refused("Reseat requires an agent seat.");
                  yield* mayChange(node);
                  if (node.bindingId === step.bindingId) return yield* refused("Reseat needs a fresh session binding.");
                  if ([...nodesById.values()].some((other) => other.id !== node.id && (other.kind === "agent" || other.kind === "terminal") && other.bindingId === step.bindingId))
                    return yield* refused("A seat or terminal already uses this session binding on this canvas.");
                  yield* records.requireSeatHost(step.host);
                  reseatedBindings.add(JSON.stringify([node.host, node.bindingId]));
                  yield* saveNode(yield* decodeNode(patch(node, { agentKey: step.agentKey, bindingId: step.bindingId, harness: step.harness, host: step.host, launch: step.launch ?? null, overseer: false })));
                  break;
                }
                case "WriteSheet": {
                  const node = yield* requireNode(step.id);
                  if (node.kind !== "sheet") return yield* refused("Write a grid only to a sheet.");
                  sheetUpdates.set(step.id, step.grid);
                  writtenSheets.add(step.id);
                  break;
                }
                case "Rewire": {
                  const previous = yield* requireWire(step.id);
                  const next = yield* Schema.decodeUnknownEffect(Wire)(
                    patch(previous, step.change),
                    { onExcessProperty: "error" },
                  ).pipe(
                    Effect.mapError(() =>
                      refused("Use values allowed for this relationship."),
                    ),
                  );
                  if (isDeepStrictEqual(previous, next)) break;
                  yield* validateWire(next);
                  wiresById.set(next.id, next);
                  break;
                }
              }
              }
              if (reseatedBindings.size) {
                const revoked = (node: Node): node is Extract<Node, { readonly kind: "agent" }> => node.kind === "agent" && node.overseer
                  && reseatedBindings.has(JSON.stringify([node.host, node.bindingId]));
                for (const node of nodesById.values()) {
                  if (revoked(node)) nodesById.set(node.id, { ...node, overseer: false });
                }
                for (const name of yield* records.listCanvases()) {
                  if (name === command.canvas) continue;
                  const aliasCanvas = yield* canvas(name);
                  const updates = [...aliasCanvas.nodes.values()].filter(revoked)
                    .map((node) => ({ ...node, overseer: false }));
                  if (!updates.length) continue;
                  for (const node of updates) yield* records.updateNode(name, node);
                  const seq = yield* records.advanceSeq(name);
                  const event: Changed = { canvas: aliasCanvas.name, seq, nodes: updates, wires: [], removedNodes: [], removedWires: [] };
                  const applied = follow(aliasCanvas, event);
                  if (applied._tag !== "Applied") return yield* refused("The canvas sequence changed unexpectedly.");
                  yield* stage(name, applied.canvas);
                  yield* publishChange(event, aliasCanvas);
                }
              }
              const nodes = [...nodesById.values()].filter((node) => !isDeepStrictEqual(current.nodes.get(node.id), node));
              const wires = [...wiresById.values()].filter((wire) => !isDeepStrictEqual(current.wires.get(wire.id), wire));
              const removedNodes = [...current.nodes.keys()].filter((id) => !nodesById.has(id));
              const removedWires = [...current.wires.keys()].filter((id) => !wiresById.has(id));
              const grids = new Map<Node["id"], SheetGrid>();
              for (const [id, grid] of sheetUpdates) {
                if (nodesById.get(id)?.kind !== "sheet") continue;
                const previous = yield* records.readSheet(command.canvas, id);
                if (!isDeepStrictEqual(previous, grid)) grids.set(id, grid);
              }
              const retiredIds = [...removedNodes, ...nodes.filter((node) => {
                const previous = current.nodes.get(node.id);
                return previous !== undefined && previous.kind !== node.kind;
              }).map((node) => node.id)];
              if (retiredIds.length) yield* dependents.removeNodes(command.canvas, retiredIds);
              for (const id of removedWires) yield* records.removeWire(command.canvas, id);
              for (const id of removedNodes) yield* records.removeNode(command.canvas, current.nodes.get(id)!);
              for (const node of nodes) {
                const previous = current.nodes.get(node.id);
                if (previous && previous.kind !== node.kind) yield* records.removeNode(command.canvas, previous);
              }
              for (const node of nodes) {
                const previous = current.nodes.get(node.id);
                if (previous?.kind === node.kind) yield* records.updateNode(command.canvas, node);
                else yield* records.insertNode(command.canvas, node);
              }
              for (const wire of wires) {
                if (current.wires.has(wire.id)) yield* records.updateWire(command.canvas, wire);
                else yield* records.insertWire(command.canvas, wire);
              }
              for (const [id, grid] of grids) yield* records.writeSheet(command.canvas, id, grid);
              const publishSheets = Effect.forEach([...grids].filter(([id]) => writtenSheets.has(id)), ([id, grid]) => afterSqlCommit(sql, () => {
                const event: SheetChanged = { canvas: command.canvas, id };
                notify(sheetListeners, event, grid);
                PubSub.publishUnsafe(sheetChanges, event);
              }), { discard: true });
              if (!nodes.length && !wires.length && !removedNodes.length && !removedWires.length && (command._tag !== "Batch" || !grids.size)) {
                yield* publishSheets;
                return { seq: current.seq };
              }
              const seq = yield* records.advanceSeq(command.canvas);
              const event: Changed = {
                canvas: command.canvas,
                seq,
                nodes,
                wires,
                removedNodes,
                removedWires: [...removedWires],
              };
              const followed = follow(current, event);
              if (followed._tag !== "Applied")
                return yield* refused(
                  "The canvas sequence changed unexpectedly.",
                );
              yield* stage(command.canvas, followed.canvas);
              yield* publishChange(event, current);
              yield* publishSheets;
              return { seq };
            }),
          )
          .pipe(
            Effect.provideService(
              StateTransactionOperation,
              `model.${command._tag}`,
            ),
            Effect.mapError((cause) => modelError("command", cause)),
          );
      });
      const ensureSeed = sql.withTransaction(Effect.gen(function* () {
        if ((yield* records.listCanvases()).length === 0)
          yield* command({ _tag: "CreateCanvas", canvas: Schema.decodeUnknownSync(CanvasName)(SEED_CANVAS_NAME) }, "operator");
      })).pipe(Effect.mapError((cause) => modelError("ensureSeed", cause)));
      return {
        subscribeChanges: (
          listener: (event: Changed, current: Canvas) => void,
        ) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        subscribeCanvasesChanges: (
          listener: (event: CanvasesChanged, current?: Canvas) => void,
        ) => {
          canvasListeners.add(listener);
          return () => {
            canvasListeners.delete(listener);
          };
        },
        subscribeSheetChanges: (
          listener: (event: SheetChanged, grid: SheetGrid) => void,
        ) => {
          sheetListeners.add(listener);
          return () => {
            sheetListeners.delete(listener);
          };
        },
        canvas,
        open,
        command,
        installCopy,
        listCanvases: records.listCanvases,
        listCanvasSummaries: records.listCanvasSummaries,
        ensureSeed,
        readSheet: records.readSheet,
        sheetChanges: Stream.fromPubSub(sheetChanges),
        changes: Stream.fromPubSub(changes),
        canvasesChanges: Stream.fromPubSub(canvasChanges),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(ModelRecords.layer),
  );
}
