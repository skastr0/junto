/**
 * The row exchange wired to this machine: its identity and the machines it
 * has pinned, the canvases it holds, and the work log.
 *
 * Where a seat lives is worked out here and nowhere else. A seat names its
 * machine by name; a pinned name is an installation, and this machine's own
 * name is this installation. A seat whose machine this one has not pinned has
 * no known home: it is offered nothing and vouched for by nobody here.
 *
 * What a seat needs to onboard rides the copy: its soul and instructions, the
 * briefing, the references, play or pause. The machine that takes a copy
 * keeps them where its own are kept, so a seat reads them the one way.
 */
import { Effect } from "effect";
import type { ActorSeatId } from "@shared/actor-seat";
import { exportCanvasCopy, type CanvasCopy, type CopiedReference } from "@shared/canvas-copy";
import type { InstallationId } from "@shared/installation-id";
import { asCanvasName, type Node, type Seat } from "@shared/model";
import { APP_REFERENCE_PLACE, type ReferencePlace, type StoredReference } from "@shared/references";
import type { CanvasPlacement } from "@shared/work-exchange";
import type { Message } from "@shared/work-model";
import { deriveActorSeatId } from "../../actor-seat-id";
import { MachineRepository } from "../../machines/repository";
import { ModelRecords } from "../../model/records";
import { ModelService } from "../../model/service";
import { PausePlane } from "../../pause-plane";
import { onReferencesChanged } from "../../references/changes";
import { ReferencesRepository } from "../../references/repository";
import { onSeatGuidanceChanged } from "../../seat-guidance/changes";
import { seatGuidanceIndex } from "../../seat-guidance/index-memory";
import { SeatGuidanceRepository } from "../../seat-guidance/repository";
import { WorkRepository } from "../repository";
import { makeRowExchange, type CopyInstalled, type RowExchange } from "./session";

export type LiveRowExchangeOptions = {
  /** Mail that arrived for a seat, for this machine to deliver if the seat is here. */
  readonly mailArrived: (canvasName: string, nodeId: string, message: Message) => void;
  /** A push to a linked machine failed: the exchange on that link is over. */
  readonly linkFailed?: (peer: InstallationId, cause: unknown) => void;
};

type Home = { readonly seatId: ActorSeatId; readonly machine: InstallationId };

const copied = (reference: StoredReference, regionId?: string): CopiedReference => ({
  ...(regionId === undefined ? {} : { regionId: regionId as NonNullable<CopiedReference["regionId"]> }),
  name: reference.name,
  ...(reference.description === undefined ? {} : { description: reference.description }),
  body: reference.body,
});

const sameText = (held: StoredReference | undefined, sent: CopiedReference): boolean =>
  held !== undefined && held.body === sent.body && held.description === sent.description;

export const makeLiveRowExchange = (
  options: LiveRowExchangeOptions,
): Effect.Effect<
  RowExchange,
  unknown,
  | MachineRepository
  | ModelRecords
  | ModelService
  | WorkRepository
  | SeatGuidanceRepository
  | ReferencesRepository
  | PausePlane
> =>
  Effect.gen(function* () {
    const machines = yield* MachineRepository;
    const records = yield* ModelRecords;
    const model = yield* ModelService;
    const repository = yield* WorkRepository;
    const guidance = yield* SeatGuidanceRepository;
    const references = yield* ReferencesRepository;
    const pause = yield* PausePlane;
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
        const regionIds = nodes.flatMap((node) => (node.kind === "region" ? [node.id as string] : []));
        const briefing = yield* references.briefingRead();
        const cut = exportCanvasCopy(
          {
            canvasName: asCanvasName(canvasName),
            canvasId: header.canvas_id,
            seq: header.seq,
            editor: self,
            nodes,
            wires: yield* records.listWires(canvasName),
            guidance: yield* guidance.list(),
            briefing: briefing?.body,
            references: [
              ...(yield* references.list(APP_REFERENCE_PLACE)).map((reference) => copied(reference)),
              ...(yield* references.regionTexts(canvasName, regionIds)).map((reference) =>
                copied(reference, reference.regionId),
              ),
            ],
            playing: pause.stateFor(canvasName).playing,
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

    /** One place's references as the copy states them: written where they differ. */
    const keepReferences = (place: ReferencePlace, sent: ReadonlyArray<CopiedReference>) =>
      Effect.gen(function* () {
        const held = new Map((yield* references.list(place)).map((reference) => [reference.name, reference]));
        for (const reference of sent) {
          if (sameText(held.get(reference.name), reference)) continue;
          yield* references.write(place, reference, "operator");
        }
        return held;
      });

    /**
     * Keep what a copy carries beside the canvas rows. What belongs to this
     * canvas follows the copy exactly: its seats' guidance, its regions'
     * references, play or pause. The briefing and the references of the whole
     * app are written and never taken back: this machine may have its own.
     */
    const keepCarried = (copy: CanvasCopy): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const sentGuidance = new Map(copy.guidance.map(({ nodeId, ...rest }) => [nodeId as string, rest]));
        for (const seat of copy.seats) {
          const sent = sentGuidance.get(seat.id) ?? null;
          const held = yield* guidance.get(seat.id);
          if (held?.soul === sent?.soul && held?.instructions === sent?.instructions) continue;
          seatGuidanceIndex.note(seat.id, yield* guidance.set(seat.id, sent));
        }
        if (copy.briefing !== undefined && (yield* references.briefingRead())?.body !== copy.briefing) {
          yield* references.briefingWrite(copy.briefing, "operator");
        }
        yield* keepReferences(
          APP_REFERENCE_PLACE,
          copy.references.filter((reference) => reference.regionId === undefined),
        );
        for (const region of copy.regions) {
          const place: ReferencePlace = { kind: "region", canvasName: copy.canvasName, regionId: region.id };
          const sent = copy.references.filter((reference) => reference.regionId === region.id);
          const held = yield* keepReferences(place, sent);
          for (const name of held.keys()) {
            if (!sent.some((reference) => reference.name === name)) yield* references.remove(place, name);
          }
        }
        if (pause.stateFor(copy.canvasName).playing !== copy.playing) {
          yield* pause.setPlaying(copy.canvasName, copy.playing);
        }
      });

    const installCopy = (copy: CanvasCopy): Effect.Effect<CopyInstalled, unknown> =>
      Effect.gen(function* () {
        const outcome = yield* model.installCopy({
          canvas: copy.canvasName,
          canvasId: copy.canvasId,
          seq: copy.seq,
          editor: copy.editor,
          nodes: [...copy.regions, ...copy.seats, ...copy.peers, ...copy.terminals],
          wires: copy.wires,
        });
        if (!("seq" in outcome) || outcome.seq === undefined) return { refused: "a-canvas-of-that-name" };
        // The copy this machine holds, new or sent again: what it carries may have changed.
        if (outcome.seq === copy.seq) yield* keepCarried(copy);
        return { installed: outcome.installed, seq: outcome.seq };
      });

    return makeRowExchange({
      self,
      repository,
      canvases: records.listCanvases().pipe(Effect.orDie),
      placement: (canvasName) => placement(canvasName).pipe(Effect.orDie),
      mailArrived: options.mailArrived,
      ...(options.linkFailed === undefined ? {} : { linkFailed: options.linkFailed }),
      cutCopy,
      copySent,
      installCopy,
    });
  });

/**
 * Push every local commit to the open links: a change to a canvas, a row
 * written to the work log, and a change to what a copy carries: play or
 * pause, guidance, the briefing, a reference. Returns the function that stops
 * following.
 */
export const followLocalCommits = (
  exchange: RowExchange,
): Effect.Effect<() => void, never, ModelService | ModelRecords | WorkRepository | PausePlane> =>
  Effect.gen(function* () {
    const model = yield* ModelService;
    const records = yield* ModelRecords;
    const repository = yield* WorkRepository;
    const pause = yield* PausePlane;
    const push = (canvasName: string): void => {
      Effect.runFork(exchange.committed(canvasName));
    };
    /** Guidance and app-wide texts name no canvas: every canvas is looked at again. */
    const pushAll = (): void => {
      Effect.runFork(
        records.listCanvases().pipe(
          Effect.flatMap((canvases) => Effect.forEach(canvases, exchange.committed, { discard: true })),
          Effect.ignore,
        ),
      );
    };
    const offs = [
      model.subscribeChanges((event) => push(event.canvas)),
      repository.subscribeChanges((canvasName) => push(canvasName)),
      pause.subscribe((canvasName) => push(canvasName)),
      onSeatGuidanceChanged(pushAll),
      onReferencesChanged((event) =>
        event.kind === "reference" && event.canvasName !== undefined ? push(event.canvasName) : pushAll(),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  });
