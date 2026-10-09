/**
 * The row exchange wired to this machine: its identity and the machines it
 * has pinned, the canvases it holds, and the work log.
 *
 * Where a seat lives is worked out here and nowhere else. A seat names its
 * machine by name; a pinned name is an installation, and this machine's own
 * name is this installation. A seat whose machine this one has not pinned has
 * no known home: it is offered nothing and vouched for by nobody here.
 */
import { Effect } from "effect";
import type { ActorSeatId } from "@shared/actor-seat";
import { exportCanvasCopy, type CanvasCopy } from "@shared/canvas-copy";
import type { InstallationId } from "@shared/installation-id";
import { asCanvasName, type Node, type Seat } from "@shared/model";
import type { CanvasPlacement } from "@shared/work-exchange";
import type { Message } from "@shared/work-model";
import { deriveActorSeatId } from "../../actor-seat-id";
import { MachineRepository } from "../../machines/repository";
import { ModelRecords } from "../../model/records";
import { ModelService } from "../../model/service";
import { WorkRepository } from "../repository";
import { makeRowExchange, type CopyInstalled, type RowExchange } from "./session";

export type LiveRowExchangeOptions = {
  /** Mail that arrived for a seat, for this machine to deliver if the seat is here. */
  readonly mailArrived: (canvasName: string, nodeId: string, message: Message) => void;
};

type Home = { readonly seatId: ActorSeatId; readonly machine: InstallationId };

export const makeLiveRowExchange = (
  options: LiveRowExchangeOptions,
): Effect.Effect<RowExchange, unknown, MachineRepository | ModelRecords | ModelService | WorkRepository> =>
  Effect.gen(function* () {
    const machines = yield* MachineRepository;
    const records = yield* ModelRecords;
    const model = yield* ModelService;
    const repository = yield* WorkRepository;
    const self = yield* machines.installationId;

    /** The installation behind a machine name, as this machine knows it now. */
    const installations = Effect.gen(function* () {
      const byName = new Map<string, InstallationId>();
      for (const peer of yield* machines.peers) byName.set(peer.machineName, peer.installationId);
      byName.set(yield* machines.machineName, self);
      return byName;
    });

    /** Where each seat of a canvas lives: this machine's seats, and the peers of a copy. */
    const homesOf = (nodes: ReadonlyArray<Node>, byName: ReadonlyMap<string, InstallationId>) => {
      const homes = new Map<string, Home>();
      for (const node of nodes) {
        if (node.kind !== "agent" && node.kind !== "peer") continue;
        const machine = byName.get(node.host);
        if (machine === undefined) continue;
        homes.set(node.id, {
          machine,
          seatId: node.kind === "peer" ? node.seatId : deriveActorSeatId(machine, node.bindingId),
        });
      }
      return homes;
    };

    const placement = (canvasName: string): Effect.Effect<CanvasPlacement | undefined, unknown> =>
      Effect.gen(function* () {
        const header = yield* records.getCanvas(canvasName);
        if (header === undefined) return undefined;
        const editor = ((yield* records.canvasEditor(canvasName)) ?? self) as InstallationId;
        const homes = homesOf(yield* records.listNodes(canvasName), yield* installations);
        const holders = new Set<InstallationId>([editor, ...[...homes.values()].map((home) => home.machine)]);
        return {
          canvasId: header.canvas_id,
          editor,
          holds: (machine) => holders.has(machine),
          seatOf: (nodeId) => homes.get(nodeId),
        };
      });

    /**
     * This machine's canvas, cut for that machine. Absent when this machine
     * does not edit the canvas, has not pinned that machine, or the cut is
     * refused: that machine has no seat on it, or a row names no machine.
     */
    const cutCopy = (canvasName: string, peer: InstallationId): Effect.Effect<CanvasCopy | undefined, unknown> =>
      Effect.gen(function* () {
        const header = yield* records.getCanvas(canvasName);
        if (header === undefined || !(yield* records.editsCanvas(canvasName))) return undefined;
        const target = (yield* machines.peers).find((pinned) => pinned.installationId === peer);
        if (target === undefined) return undefined;
        const byName = yield* installations;
        const nodes = yield* records.listNodes(canvasName);
        // A seat on a machine this one has not pinned has no identity to send.
        const unplaced = nodes.some((node) => node.kind === "agent" && !byName.has(node.host));
        if (unplaced) return undefined;
        const cut = exportCanvasCopy(
          {
            canvasName: asCanvasName(canvasName),
            canvasId: header.canvas_id,
            seq: header.seq,
            editor: self,
            nodes,
            wires: yield* records.listWires(canvasName),
            guidance: {},
            briefing: undefined,
            references: [],
            playing: true,
            seatIdOf: (seat: Seat) => deriveActorSeatId(byName.get(seat.host)!, seat.bindingId),
          },
          { installationId: peer, machineName: target.machineName },
        );
        return cut.ok ? cut.copy : undefined;
      });

    /** Keep the count sent to that machine, and where every seat was at it. */
    const copySent = (copy: CanvasCopy): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const byName = yield* installations;
        const seats = [
          ...copy.seats.map((seat) => ({
            nodeId: seat.id,
            seatId: deriveActorSeatId(copy.target, seat.bindingId),
            machine: copy.target,
          })),
          ...copy.peers.flatMap((peer) => {
            const machine = byName.get(peer.host);
            return machine === undefined ? [] : [{ nodeId: peer.id, seatId: peer.seatId, machine }];
          }),
        ];
        yield* repository.recordCanvasCopySent({ canvasName: copy.canvasName, target: copy.target, seq: copy.seq, seats });
      });

    const installCopy = (copy: CanvasCopy): Effect.Effect<CopyInstalled, unknown> =>
      model
        .installCopy({
          canvas: copy.canvasName,
          canvasId: copy.canvasId,
          seq: copy.seq,
          editor: copy.editor,
          nodes: [...copy.regions, ...copy.seats, ...copy.peers, ...copy.terminals],
          wires: copy.wires,
        })
        .pipe(
          Effect.map((outcome): CopyInstalled =>
            "seq" in outcome && outcome.seq !== undefined
              ? { installed: outcome.installed, seq: outcome.seq }
              : { refused: "a-canvas-of-that-name" },
          ),
        );

    return makeRowExchange({
      self,
      repository,
      canvases: records.listCanvases().pipe(Effect.orDie),
      placement: (canvasName) => placement(canvasName).pipe(Effect.orDie),
      mailArrived: options.mailArrived,
      cutCopy,
      copySent,
      installCopy,
    });
  });
