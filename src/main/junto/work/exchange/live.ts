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
import { Cause, Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { exportCanvasCopy, type CanvasCopy, type CopiedAutomation, type CopiedReference } from "@shared/canvas-copy";
import type { InstallationId } from "@shared/installation-id";
import { asCanvasName, type Seat } from "@shared/model";
import { APP_REFERENCE_PLACE, type ReferencePlace, type StoredReference } from "@shared/references";
import type { AgentSignal } from "@shared/agent-signals";
import { EXCHANGE_MAX_SIGNAL_ATTACHMENTS, signalAttachmentCrosses, type CanvasPlacement, type ExchangeSignal } from "@shared/work-exchange";
import type { Message } from "@shared/work-model";
import { deriveActorSeatId } from "../../actor-seat-id";
import { AutomationRepository } from "../../automation/repository";
import { MachineRepository } from "../../machines/repository";
import { ModelRecords } from "../../model/records";
import { ModelService } from "../../model/service";
import { PausePlane } from "../../pause-plane";
import { onReferencesChanged } from "../../references/changes";
import { ReferencesRepository } from "../../references/repository";
import { StateTransactionOperation } from "../../state/service";
import { onSeatGuidanceChanged } from "../../seat-guidance/changes";
import { SeatGuidanceRepository } from "../../seat-guidance/repository";
import { onAgentSignalChanged } from "../../signals/changes";
import { raisedHands } from "../../signals/raised-hands";
import { AgentSignalRepository } from "../../signals/repository";
import { WorkRepository } from "../repository";
import { HeldSeatControls } from "./seat-controls";
import { canvasPlacement, machineInstallations } from "../canvas-placement";
import type { ArrivedSeatControl, ArrivedSeatSettled } from "./seat-controls";
import { makeRowExchange, type CopyInstalled, type ExchangeChange, type RowExchange } from "./session";
import { encodeFailure } from "../../failure-encode";
import { logMachine } from "../../observability/logger";
import { releaseSignalAttachments } from "../../signals/attachments";
import { takenSignalAttachments } from "../../signals/taken-attachments";

export type LiveRowExchangeOptions = {
  /** Mail that arrived for a seat, for this machine to deliver if the seat is here. */
  readonly mailArrived: (canvasName: string, nodeId: string, message: Message) => void;
  /** Commands arrived for a canvas: wakes the editing machine's ruler. */
  readonly commandArrived?: (canvasName: string) => void;
  /** A push to a linked machine failed: the exchange on that link is over. */
  readonly linkFailed?: (peer: InstallationId, cause: unknown) => void;
  /** A signal another machine wrote was kept here, as it now stands: for whoever shows signals. */
  readonly signalTaken?: (signal: AgentSignal) => void;
};

/** A signal as it stands here, in the words that cross: no file it carries. */
const stated = (signal: AgentSignal): ExchangeSignal => ({
  signalId: signal.signalId,
  nodeId: signal.nodeId,
  kind: signal.kind,
  text: signal.text,
  ...(signal.detail === undefined ? {} : { detail: signal.detail }),
  ...(signal.source === undefined ? {} : { source: signal.source }),
  ...(signal.work === undefined ? {} : { work: signal.work }),
  ...(signal.form === undefined ? {} : { form: signal.form }),
  ...(signal.suggestions === undefined ? {} : { suggestions: signal.suggestions }),
  ...(signal.attachments === undefined || signal.attachments.length === 0
    ? {}
    : { attachments: signal.attachments.filter(signalAttachmentCrosses).slice(0, EXCHANGE_MAX_SIGNAL_ATTACHMENTS) }),
  createdAt: signal.createdAt,
  ...(signal.state === "open" || signal.closedAt === undefined
    ? {}
    : signal.state === "answered"
      ? signal.response === undefined
        ? {}
        : { closing: { state: "answered" as const, closedAt: signal.closedAt, response: signal.response } }
      : { closing: { state: signal.state, closedAt: signal.closedAt } }),
});

const copied = (reference: StoredReference, regionId?: string): CopiedReference => ({
  ...(regionId === undefined ? {} : { regionId: regionId as NonNullable<CopiedReference["regionId"]> }),
  name: reference.name,
  ...(reference.description === undefined ? {} : { description: reference.description }),
  body: reference.body,
});

const sameText = (held: StoredReference | undefined, sent: CopiedReference): boolean =>
  held !== undefined && held.body === sent.body && held.description === sent.description;

/** A held-controls effect, forked: each row's own failures are logged inside it. */
const runHeld = (work: Effect.Effect<void, unknown>): void => {
  void Effect.runFork(
    work.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("seat controls could not be judged").pipe(
          Effect.annotateLogs({ area: "exchange", error: Cause.pretty(cause) }),
        ),
      ),
    ),
  );
};

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
  | AgentSignalRepository
  | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const machines = yield* MachineRepository;
    const records = yield* ModelRecords;
    const model = yield* ModelService;
    const repository = yield* WorkRepository;
    const guidance = yield* SeatGuidanceRepository;
    const heldControls = yield* Effect.serviceOption(HeldSeatControls);
    const references = yield* ReferencesRepository;
    const pause = yield* PausePlane;
    const signals = yield* AgentSignalRepository;
    const self = yield* machines.installationId;
    const automationStore = yield* Effect.serviceOption(AutomationRepository);

    const installations = machineInstallations.pipe(Effect.provideService(MachineRepository, machines));

    const placement = (canvasName: string): Effect.Effect<CanvasPlacement | undefined, unknown> =>
      Effect.gen(function* () {
        const placed = yield* canvasPlacement(canvasName).pipe(
          Effect.provideService(MachineRepository, machines),
          Effect.provideService(ModelRecords, records),
          // Where automations run, when this process folds them.
          (placed) => Option.isSome(automationStore) ? Effect.provideService(placed, AutomationRepository, automationStore.value) : placed,
        );
        // Only the editing machine keeps placement history, so only it knows who is departing.
        if (placed === undefined || placed.editor !== self) return placed;
        const departing = new Set([...(yield* repository.departingFrom(canvasName))].filter((machine) => !placed.holds(machine)));
        if (departing.size === 0) return placed;
        return { ...placed, holds: (machine) => placed.holds(machine) || departing.has(machine), departing: (machine) => departing.has(machine) };
      });

    /**
     * A departing machine has taken every row of this machine's it is
     * entitled to, the rulings that moved its seats and automations among
     * them: record where everything stands now as told to it, which closes
     * its rows in placement history, so it no longer holds the canvas.
     */
    const departed = (canvasName: string, peer: InstallationId): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const header = yield* records.getCanvas(canvasName);
        if (header === undefined) return;
        const byName = yield* installations;
        const seats = (yield* records.listNodes(canvasName)).flatMap((node) => {
          if (node.kind !== "agent") return [];
          const machine = byName.get(node.host);
          return machine === undefined ? [] : [{ nodeId: node.id as string, seatId: deriveActorSeatId(machine, node.bindingId), machine }];
        });
        const automations = (yield* copiedAutomations(canvasName)).flatMap((automation) => {
          const machine = byName.get(automation.machine);
          return machine === undefined ? [] : [{ nodeId: automation.nodeId, automationId: automation.automationId, machine }];
        });
        yield* repository.recordCanvasCopySent({ canvasName, target: peer, seq: header.seq, seats, automations });
      }).pipe(sql.withTransaction, Effect.provideService(StateTransactionOperation, "exchange.departed"));

    /** Every live automation of a canvas and the machine it runs on, by real short name. */
    const copiedAutomations = (canvasName: string) =>
      Effect.gen(function* () {
        const editorName = yield* machines.machineName;
        const state = Option.isSome(automationStore) ? yield* automationStore.value.loadState(canvasName) : new Map();
        const copied: Array<CopiedAutomation> = [];
        for (const { automation, archived } of state.values()) {
          if (archived) continue;
          copied.push({ automationId: automation.automationId, nodeId: automation.nodeId, machine: automation.machine ?? editorName });
        }
        return copied;
      });

    /**
     * This machine's canvas, cut for that machine. Absent when this machine
     * does not edit the canvas, has not pinned that machine, or the cut is
     * refused: that machine has no seat on it, or a row names no machine.
     * One read transaction: the count, the nodes and every automation's
     * machine are read as one state, so no move committed between the reads
     * is sent as standing at the count before it.
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
            editorMachineName: yield* machines.machineName,
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
            automations: yield* copiedAutomations(canvasName),
          },
          { installationId: peer, machineName: target.machineName },
        );
        return cut.ok ? cut.copy : undefined;
      }).pipe(sql.withTransaction, Effect.provideService(StateTransactionOperation, "exchange.cut-copy"));

    /** Keep the count sent to that machine, and where every seat and automation was at it. */
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
        const automations = copy.automations?.flatMap((automation) => {
          const machine = byName.get(automation.machine);
          return machine === undefined ? [] : [{ nodeId: automation.nodeId, automationId: automation.automationId, machine }];
        });
        yield* repository.recordCanvasCopySent({
          canvasName: copy.canvasName,
          target: copy.target,
          seq: copy.seq,
          seats,
          ...(automations === undefined ? {} : { automations }),
        });
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
          yield* guidance.set(seat.id, sent);
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
        // A seat that comes to live here makes its held mail this machine's:
        // forgotten before the copy is kept, so no stop in between loses it.
        const here = yield* machines.machineName;
        const seated = new Set(
          (yield* records.listNodes(copy.canvasName)).flatMap((node) =>
            node.kind === "agent" && node.host === here ? [node.id as string] : [],
          ),
        );
        if (copy.seats.some((seat) => !seated.has(seat.id))) yield* repository.exchangeForget(copy.canvasName);
        const outcome = yield* model.installCopy({
          canvas: copy.canvasName,
          canvasId: copy.canvasId,
          seq: copy.seq,
          editor: copy.editor,
          nodes: [...copy.regions, ...copy.seats, ...copy.peers, ...copy.terminals, ...copy.resources],
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
      ...(options.commandArrived === undefined ? {} : { commandArrived: options.commandArrived }),
      ...(Option.isNone(heldControls)
        ? {}
        : {
            seatControlsArrived: (canvasName: string, controls: ReadonlyArray<ArrivedSeatControl>) =>
              runHeld(heldControls.value.controlsArrived(canvasName, controls)),
            seatSettlementsArrived: (canvasName: string, settled: ReadonlyArray<ArrivedSeatSettled>) =>
              runHeld(heldControls.value.settledArrived(canvasName, settled)),
            seatControlsSweep: (canvasName: string) => runHeld(heldControls.value.sweepPending(canvasName)),
          }),
      ...(options.linkFailed === undefined ? {} : { linkFailed: options.linkFailed }),
      cutCopy,
      copySent,
      departed,
      installCopy,
      signals: (canvasName) => signals.listCanvas(canvasName).pipe(Effect.map((held) => held.map(stated))),
      takeSignal: (canvasName, { attachments, ...signal }, raises) =>
        signals.take({
          ...signal,
          canvasName,
          raises,
          ...(attachments === undefined ? {} : { attachments: takenSignalAttachments(attachments) }),
        }).pipe(
          // A signal closed by another machine lets go of its files here too.
          Effect.tap((taken) => (taken === undefined ? Effect.void : releaseSignalAttachments(taken))),
          Effect.map((taken) => {
            if (taken === undefined) return;
            raisedHands.note(taken);
            options.signalTaken?.(taken);
          }),
        ),
    });
  });

/**
 * Push every local commit to the open links: a change to a canvas, a row
 * written to the work log, a signal raised or closed, and a change to what a
 * copy carries: play or pause, guidance, the briefing, a reference. Returns
 * the function that stops following.
 */
export const followLocalCommits = (
  exchange: RowExchange,
): Effect.Effect<() => void, never, ModelService | ModelRecords | WorkRepository | PausePlane> =>
  Effect.gen(function* () {
    const model = yield* ModelService;
    const records = yield* ModelRecords;
    const repository = yield* WorkRepository;
    const pause = yield* PausePlane;
    const heldControls = yield* Effect.serviceOption(HeldSeatControls);
    const push = (canvasName: string, change: ExchangeChange): void => {
      Effect.runFork(exchange.committed(canvasName, change));
    };
    /**
     * A held seat control is judged against the fold as it stands at every
     * pass (0.11, 05 S4): a seat moved, an automation moved or archived, a
     * region that changed reach, or a pause the operator set re-judges it.
     */
    const sweep = (canvasName: string): void => {
      if (Option.isSome(heldControls)) runHeld(heldControls.value.sweepPending(canvasName));
    };
    /** Guidance and app-wide texts name no canvas: every canvas is looked at again. */
    const pushAll = (): void => {
      Effect.runFork(
        records.listCanvases().pipe(
          Effect.flatMap((canvases) =>
            Effect.forEach(canvases, (canvasName) => exchange.committed(canvasName, "canvas"), { discard: true }),
          ),
          // Nothing is pushed this time; the next commit pushes again. Never silent.
          Effect.catchCause((cause) => Effect.logWarning("canvases could not be listed to push to linked machines").pipe(
            Effect.annotateLogs({ area: "exchange", failure: encodeFailure(cause, { machine: logMachine() }) }))),
        ),
      );
    };
    const offs = [
      // The canvas, play and what a copy carries cut a copy; the work log and signals do not.
      model.subscribeChanges((event) => {
        push(event.canvas, "canvas");
        sweep(event.canvas);
      }),
      repository.subscribeChanges((canvasName) => {
        push(canvasName, "rows");
        sweep(canvasName);
      }),
      pause.subscribe((canvasName) => {
        push(canvasName, "canvas");
        // A pause settles every held control of that canvas refused: paused.
        sweep(canvasName);
      }),
      onAgentSignalChanged((signal) => push(signal.canvasName, "rows")),
      onSeatGuidanceChanged(pushAll),
      onReferencesChanged((event) =>
        event.kind === "reference" && event.canvasName !== undefined ? push(event.canvasName, "canvas") : pushAll(),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  });
