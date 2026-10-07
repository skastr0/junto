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
  type CanvasesChanged,
  type Opened,
} from "@shared/model";
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
      const held = new Map<string, Canvas>();
      const draftKey = Symbol("ModelService.canvases");
      // Slow subscribers reopen on a seq gap; they cannot stall a commit.
      const changes = yield* PubSub.sliding<Changed>(1024);
      const sheetChanges = yield* PubSub.sliding<SheetChanged>(256);
      const canvasChanges = yield* PubSub.sliding<CanvasesChanged>(64);
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
          (source === "runtime" && command._tag !== "RecordSession") ||
          (command._tag === "GrantOverseer" && source !== "operator") ||
          (command._tag === "RecordSession" && source !== "runtime")
        ) {
          return yield* refused(
            "Only the operator changes overseer authority; the runtime only records seat sessions.",
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
                  PubSub.publishUnsafe(canvasChanges, {
                    _tag: "Created",
                    canvas: command.canvas,
                  });
                });
                return { seq: 0 };
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
              const mayChange = (node: Node) =>
                node.kind === "agent" &&
                node.overseer &&
                source !== "operator" &&
                command._tag !== "RecordSession"
                  ? Effect.fail(
                      refused(
                        "Only the operator can change or remove an overseer seat.",
                      ),
                    )
                  : Effect.void;
              if (
                command._tag === "RemoveCanvas" ||
                command._tag === "RenameCanvas"
              ) {
                for (const node of current.nodes.values())
                  yield* mayChange(node);
                if (
                  command._tag === "RenameCanvas" &&
                  command.canvas === command.to
                )
                  return { seq: current.seq };
                if (command._tag === "RemoveCanvas")
                  yield* records.removeCanvas(command.canvas);
                else {
                  if (yield* records.getCanvas(command.to))
                    return yield* refused(
                      "Choose a canvas name that does not already exist.",
                    );
                  yield* records.renameCanvas(command.canvas, command.to);
                  yield* stage(command.to, { ...current, name: command.to });
                }
                yield* stage(command.canvas, null);
                yield* afterSqlCommit(sql, () => {
                  held.delete(command.canvas);
                  if (command._tag === "RenameCanvas")
                    held.set(command.to, { ...current, name: command.to });
                  PubSub.publishUnsafe<CanvasesChanged>(
                    canvasChanges,
                    command._tag === "RemoveCanvas"
                      ? { _tag: "Removed", canvas: command.canvas }
                      : {
                          _tag: "Renamed",
                          from: command.canvas,
                          to: command.to,
                        },
                  );
                });
                return {
                  seq: command._tag === "RemoveCanvas" ? 0 : current.seq,
                };
              }
              const nodes: Node[] = [];
              const wires: Wire[] = [];
              const removedNodes: Changed["removedNodes"][number][] = [];
              const removedWires = new Set<Changed["removedWires"][number]>();
              const saveNode = Effect.fn("ModelService.saveNode")(function* (
                node: Node,
              ) {
                const previous = yield* requireNode(node.id);
                yield* mayChange(previous);
                if (isDeepStrictEqual(previous, node)) return;
                yield* records.updateNode(command.canvas, node);
                nodesById.set(node.id, node);
                nodes.push(node);
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
                  Effect.mapError(() =>
                    refused("Use values allowed for this kind."),
                  ),
                );
              switch (command._tag) {
                case "Add":
                  for (const node of command.nodes) {
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
                    yield* records.insertNode(command.canvas, node);
                    if (node.kind === "sheet")
                      yield* records.writeSheet(command.canvas, node.id, {
                        columns: [],
                        rows: [],
                      });
                    nodesById.set(node.id, node);
                    nodes.push(node);
                  }
                  for (const wire of command.wires) {
                    if (wiresById.has(wire.id))
                      return yield* refused("Use a new relationship id.");
                    yield* validateWire(wire);
                    yield* records.insertWire(command.canvas, wire);
                    wiresById.set(wire.id, wire);
                    wires.push(wire);
                  }
                  break;
                case "Remove":
                  for (const id of command.wires) {
                    yield* requireWire(id);
                    yield* records.removeWire(command.canvas, id);
                    wiresById.delete(id);
                    removedWires.add(id);
                  }
                  for (const id of command.nodes) {
                    const node = yield* requireNode(id);
                    yield* mayChange(node);
                    for (const wire of wiresById.values()) {
                      if (wire.from !== id && wire.to !== id) continue;
                      yield* records.removeWire(command.canvas, wire.id);
                      wiresById.delete(wire.id);
                      removedWires.add(wire.id);
                    }
                    yield* records.removeNode(command.canvas, node);
                    nodesById.delete(id);
                    removedNodes.push(id);
                  }
                  break;
                case "Move":
                  for (const move of command.moves)
                    yield* saveNode(
                      yield* decodeNode({
                        ...(yield* requireNode(move.id)),
                        x: move.x,
                        y: move.y,
                        ...move.size,
                      }),
                    );
                  break;
                case "Restack": {
                  const selected = new Set(command.nodes);
                  for (const id of selected) yield* requireNode(id);
                  const moving = inPaintOrder(current).filter((node) =>
                    selected.has(node.id),
                  );
                  const extremes = [...nodesById.values()].map(
                    (node) => node.z,
                  );
                  let z =
                    command.to === "front"
                      ? Math.max(0, ...extremes) + 1
                      : Math.min(0, ...extremes) - moving.length;
                  for (const node of moving)
                    yield* saveNode(yield* decodeNode({ ...node, z: z++ }));
                  break;
                }
                case "Recolor":
                  for (const id of command.nodes)
                    yield* saveNode(
                      yield* decodeNode(
                        patch(yield* requireNode(id), { color: command.color }),
                      ),
                    );
                  break;
                case "Edit": {
                  const node = yield* requireNode(command.id);
                  if (node.kind !== command.change.kind)
                    return yield* refused(
                      "Edit fields must belong to the object's kind.",
                    );
                  yield* saveNode(
                    yield* decodeNode(patch(node, command.change)),
                  );
                  break;
                }
                case "GrantOverseer":
                case "RecordSession": {
                  const node = yield* requireNode(command.id);
                  if (node.kind !== "agent")
                    return yield* refused(
                      "This command requires an agent seat.",
                    );
                  yield* saveNode(
                    yield* decodeNode(
                      patch(
                        node,
                        command._tag === "GrantOverseer"
                          ? { overseer: command.overseer }
                          : { sessionId: command.sessionId },
                      ),
                    ),
                  );
                  break;
                }
                case "WriteSheet": {
                  const node = yield* requireNode(command.id);
                  if (node.kind !== "sheet")
                    return yield* refused("Write a grid only to a sheet.");
                  const previous = yield* records.readSheet(
                    command.canvas,
                    command.id,
                  );
                  if (isDeepStrictEqual(previous, command.grid))
                    return { seq: current.seq };
                  yield* records.writeSheet(
                    command.canvas,
                    command.id,
                    command.grid,
                  );
                  yield* afterSqlCommit(sql, () => {
                    PubSub.publishUnsafe(sheetChanges, {
                      canvas: command.canvas,
                      id: command.id,
                    });
                  });
                  return { seq: current.seq };
                }
                case "Rewire": {
                  const previous = yield* requireWire(command.id);
                  const next = yield* Schema.decodeUnknownEffect(Wire)(
                    patch(previous, command.change),
                    { onExcessProperty: "error" },
                  ).pipe(
                    Effect.mapError(() =>
                      refused("Use values allowed for this relationship."),
                    ),
                  );
                  if (isDeepStrictEqual(previous, next)) break;
                  yield* validateWire(next);
                  yield* records.updateWire(command.canvas, next);
                  wiresById.set(next.id, next);
                  wires.push(next);
                  break;
                }
              }
              if (
                !nodes.length &&
                !wires.length &&
                !removedNodes.length &&
                !removedWires.size
              )
                return { seq: current.seq };
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
              yield* afterSqlCommit(sql, () => {
                const applied = follow(
                  held.get(command.canvas) ?? current,
                  event,
                );
                if (applied._tag === "Applied")
                  held.set(command.canvas, applied.canvas);
                else held.delete(command.canvas);
                PubSub.publishUnsafe(changes, event);
              });
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
      return {
        canvas,
        open,
        command,
        listCanvases: records.listCanvases,
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
