import { recordDeliveryReceiptRefusal } from "./delivery-receipts";
import { type Context, Effect } from "effect";
import { asNodeId, type Seat, type Canvas } from "@shared/model";
import type { MailSenderStamp } from "@shared/crew";
import { isThisMachine } from "@shared/machine-identity";
import type { TerminalSessionSummary } from "@shared/terminal";
import type { CanvasFactBasis } from "@shared/work-protocol";
import type { ModelService } from "../model/service";
import type { ModelActorRefs } from "../model/actor-refs";
import type { SettingsServiceApi } from "../settings/service";
import type { LocalSessionHost } from "../term/local-host";
import {
  checkoutKeyFromPath,
  claimContextFrom,
  gitProbeOverRunCli,
  makeCheckoutWatchSupervisor,
  type CheckoutReceiptMailInput,
  type CheckoutWatchClaim,
  type CheckoutWatchReceiptFailure,
  type CheckoutWatchSupervisor,
} from "./checkout-watch-live";
import type { GitProbe } from "./checkout-watch";
import { CrewRepositoryError, type CrewRepositoryShape } from "./crew-repository";
import type { MessageDeliveryService } from "./message-delivery";
import type { WorkRepositoryShape } from "./repository";

export type CheckoutWatchCompositionOptions = {
  readonly model: Pick<Context.Service.Shape<typeof ModelService>, "listCanvases" | "canvas">;
  readonly actorRefs: Pick<Context.Service.Shape<typeof ModelActorRefs>, "read">;
  readonly settings: Pick<SettingsServiceApi, "get">;
  readonly host: Pick<LocalSessionHost, "get">;
  readonly crew: Pick<CrewRepositoryShape, "recordCheckoutObservation">;
  readonly workRepository: Pick<WorkRepositoryShape, "publishCheckoutReceipts" | "taskLane">;
  readonly messageDelivery: Pick<MessageDeliveryService, "notifyAppended">;
  readonly basisFor: (witness: { readonly canvasName: string; readonly seq: Canvas["seq"] }) => CanvasFactBasis;
  readonly run: <A>(effect: Effect.Effect<A, never>) => Promise<A>;
  /** Main's closed authoring gate covers durable writes, never Git probes. */
  readonly write: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly probe?: GitProbe;
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
};

type ProcessProof = {
  readonly session: TerminalSessionSummary;
  readonly checkoutKey: string;
};

type ProvenClaim = {
  readonly claim: CheckoutWatchClaim;
  readonly taskSinkId: string;
  readonly process: ProcessProof;
};

const failure = (reason: string, error: unknown): CheckoutWatchReceiptFailure => ({
  reason,
  message: typeof error === "object" && error !== null && "message" in error &&
    typeof error.message === "string" ? error.message : String(error),
});

const matchesSurface = (
  session: TerminalSessionSummary | undefined,
  canvasName: string,
  surface: Seat,
  thisMachine: string,
): session is TerminalSessionSummary => session !== undefined &&
  session.status === "running" && !session.stopping &&
  session.pid !== undefined && session.pid > 0 &&
  session.epoch.length > 0 &&
  isThisMachine(session.hostId, thisMachine) &&
  session.canvasName === canvasName && session.nodeId === surface.id &&
  session.bindingId === surface.bindingId &&
  session.harness === surface.harness && session.agentKey === surface.agentKey;

const sameProcess = (a: TerminalSessionSummary | undefined, b: TerminalSessionSummary): boolean =>
  a !== undefined && a.status === "running" && !a.stopping &&
  a.bindingId === b.bindingId && a.epoch === b.epoch && a.pid === b.pid &&
  a.hostId === b.hostId && a.canvasName === b.canvasName && a.nodeId === b.nodeId &&
  a.harness === b.harness && a.agentKey === b.agentKey && a.cwd === b.cwd;

const sessionIdentity = (session: TerminalSessionSummary | undefined): string => JSON.stringify(
  session === undefined ? null : [session.bindingId, session.epoch, session.pid,
    session.hostId, session.canvasName, session.nodeId, session.status, session.stopping,
    session.harness, session.agentKey, session.cwd],
);

/** Main-process composition: model intent and exact task rows, with live process proof. */
export const makeCheckoutWatchComposition = (
  options: CheckoutWatchCompositionOptions,
): CheckoutWatchSupervisor => {
  let stopped = false;
  // Only a seat on this machine has a checkout here. A machine that holds a
  // copy of a canvas holds none of its boards, so it claims nothing there.
  const machineName = options.settings.get.pipe(Effect.map((settings) => settings.machine.name));

  const readClaims = (canvasName: string) => Effect.gen(function* () {
    const thisMachine = yield* machineName;
    const canvas = yield* options.model.canvas(canvasName);
    const actors = yield* options.actorRefs.read(canvasName);
    const processes = new Map<string, ProcessProof>();
    const sessions: Array<{ readonly bindingId: string; readonly identity: string }> = [];
    for (const actor of actors) {
      const node = canvas.nodes.get(asNodeId(actor.nodeId));
      if (node === undefined) continue;
      if (node.kind !== "agent" || !isThisMachine(node.host, thisMachine)) continue;
      const surface = node;
      const session = options.host.get(surface.bindingId);
      sessions.push({ bindingId: surface.bindingId, identity: sessionIdentity(session) });
      if (!matchesSurface(session, canvasName, surface, thisMachine)) continue;
      // Only the running host's actual cwd proves a checkout. Launch/default cwd is not evidence.
      const checkoutKey = yield* Effect.promise(() => checkoutKeyFromPath(session.cwd));
      if (checkoutKey === undefined || !sameProcess(options.host.get(surface.bindingId), session)) continue;
      processes.set(actor.nodeId, { session, checkoutKey });
    }
    const claims: ProvenClaim[] = [];
    for (const node of canvas.nodes.values()) {
      if (node.kind !== "task") continue;
      const tasks = yield* options.workRepository.taskLane(canvasName, node.id, "task");
      const context = claimContextFrom({
        canvasName,
        thisMachine,
        boards: [{ nodeId: node.id, tasks, contract: node.contract }],
        actorRefs: actors.filter((actor) => processes.has(actor.nodeId)),
        nodes: [...canvas.nodes.values()],
        checkoutKeyFor: (nodeId) => processes.get(nodeId)?.checkoutKey,
        observedProcessFor: (nodeId) => {
          const session = processes.get(nodeId)?.session;
          return session?.harness === undefined ? undefined : { generation: session.epoch, harness: session.harness };
        },
      });
      for (const claim of context.claims) {
        const process = processes.get(claim.nodeId);
        if (process !== undefined) claims.push({ claim, taskSinkId: node.id, process });
      }
    }
    return { canvas, claims, sessions };
  });

  const currentClaims = (canvasName: string) => Effect.gen(function* () {
    const names = yield* options.model.listCanvases();
    const inventory = [];
    for (const name of names) inventory.push(yield* readClaims(name));
    const selected = inventory.find(({ canvas }) => canvas.name === canvasName);
    if (selected === undefined) {
      return yield* Effect.fail(failure("checkout-canvas-missing", "checkout canvas is no longer active"));
    }
    // Filesystem canonicalization yields. Recheck every canvas sequence and
    // membership so a topology change cannot authorize an older inventory.
    const currentNames = yield* options.model.listCanvases();
    if (currentNames.length !== names.length || currentNames.some((name) => !names.includes(name))) {
      return yield* Effect.fail(failure("checkout-intent-changed", "canvas membership changed while reading checkout claims"));
    }
    for (const { canvas } of inventory) {
      if ((yield* options.model.canvas(canvas.name)).seq !== canvas.seq) {
        return yield* Effect.fail(failure("checkout-intent-changed", "canvas intent changed while reading checkout claims"));
      }
    }
    const seatsByCheckout = new Map<string, Set<string>>();
    for (const { claims } of inventory) {
      for (const { claim } of claims) {
        const seats = seatsByCheckout.get(claim.checkoutKey) ?? new Set<string>();
        seats.add(claim.seatId);
        seatsByCheckout.set(claim.checkoutKey, seats);
      }
    }
    const ambiguous = new Set([...seatsByCheckout]
      .filter(([, seats]) => seats.size > 1).map(([checkoutKey]) => checkoutKey));
    const ownCheckouts = new Set(selected.claims.map(({ claim }) => claim.checkoutKey));
    const attributionClaims = selected.claims.map(({ claim }) => claim);
    // Competing claims are real portfolio evidence, not foreign receipt targets.
    // Feeding both seats to the pure attribution rule preserves unattributed
    // observations for an already tracked checkout without claiming either author.
    for (const entry of inventory) {
      if (entry === selected) continue;
      for (const { claim } of entry.claims) {
        if (!ownCheckouts.has(claim.checkoutKey) || !ambiguous.has(claim.checkoutKey)) continue;
        if (attributionClaims.some((own) => own.checkoutKey === claim.checkoutKey && own.seatId === claim.seatId)) continue;
        attributionClaims.push(claim);
      }
    }
    // Filesystem canonicalization yields. Also pin seats that were absent, so
    // a newly started competing process cannot slip into an older inventory.
    if (inventory.some(({ sessions }) => sessions.some(({ bindingId, identity }) =>
      sessionIdentity(options.host.get(bindingId)) !== identity))) {
      return yield* Effect.fail(failure("checkout-process-changed", "checkout processes changed while reading claims"));
    }
    return { ...selected, attributionClaims, ambiguous };
  });

  const receiptAdmission = (input: CheckoutReceiptMailInput) => Effect.gen(function* () {
    const fresh = yield* currentClaims(input.canvasName);
    if (fresh.ambiguous.has(input.checkoutKey)) {
      return yield* Effect.fail(failure("checkout-author-ambiguous", "several current authors share this checkout"));
    }
    const matches = fresh.claims.filter(({ claim }) => claim.taskId === input.taskId &&
      claim.seatId === input.authorSeatId && claim.checkoutKey === input.checkoutKey);
    if (matches.length !== 1) {
      return yield* Effect.fail(failure("authority-mismatch", "checkout receipt no longer has one live task author"));
    }
    const selected = matches[0]!;
    if (selected.taskSinkId !== input.taskNodeId || selected.claim.nodeId !== input.senderNodeId) {
      return yield* Effect.fail(failure("authority-mismatch", "checkout observation belongs to a previous task sink or author node"));
    }
    return { selected, witness: { canvasName: fresh.canvas.name, seq: fresh.canvas.seq } };
  });

  const deliverReceipts = (input: CheckoutReceiptMailInput) => Effect.gen(function* () {
    const { selected } = yield* receiptAdmission(input);
    const session = selected.process.session;
    // Retried historical commits keep their observed provenance. A replacement
    // process may authorize delivery for the same live claim, never relabel it.
    const author: MailSenderStamp = {
      fromSeat: input.authorSeatId,
      senderNodeId: selected.claim.nodeId,
      senderGeneration: input.senderGeneration,
      senderHarness: input.senderHarness,
    };
    const receipts = yield* Effect.tryPromise({
      try: () => options.write(Effect.gen(function* () {
        if (stopped) return yield* Effect.fail(failure("checkout-watch-stopped", "checkout watch is stopped"));
        if (!sameProcess(options.host.get(session.bindingId), session)) {
          return yield* Effect.fail(failure("authority-mismatch", "checkout author process changed before receipt commit"));
        }
        // A competing seat may have become live while this write waited for
        // the authoring gate without changing canvas intent or this process.
        const admitted = yield* receiptAdmission(input);
        if (stopped || !sameProcess(options.host.get(session.bindingId), session)) {
          return yield* Effect.fail(failure("authority-mismatch", "checkout author process changed during receipt admission"));
        }
        return yield* options.workRepository.publishCheckoutReceipts({
          basis: options.basisFor(admitted.witness),
          canvasName: input.canvasName,
          nodeId: selected.taskSinkId,
          taskId: input.taskId,
          checkoutKey: input.checkoutKey,
          author,
          shas: input.shas,
        });
      })),
      catch: (error) => failure("checkout-receipt-write", error),
    });
    for (const receipt of receipts) {
      options.messageDelivery.notifyAppended(receipt.canvas, receipt.nodeId, receipt.message);
    }
    return receipts.length;
  }).pipe(
    Effect.tapError((cause) => Effect.sync(() => recordDeliveryReceiptRefusal(input.canvasName, input.taskNodeId, cause))),
    Effect.mapError((error) => failure("checkout-receipt", error)),
  );

  const supervisor = makeCheckoutWatchSupervisor({
    probe: options.probe ?? gitProbeOverRunCli(),
    repository: {
      recordCheckoutObservation: (input) => Effect.tryPromise({
        try: () => options.write(Effect.gen(function* () {
          if (stopped) return yield* Effect.fail(failure("checkout-watch-stopped", "checkout watch is stopped"));
          return yield* options.crew.recordCheckoutObservation(input);
        })),
        catch: (cause) => new CrewRepositoryError({
          operation: "checkout-watch.record",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      }),
    },
    // A failed read must reject the pass. Empty success would discard the live baseline.
    canvases: () => options.model.listCanvases().pipe(Effect.orDie),
    claims: (canvasName) => currentClaims(canvasName).pipe(
      Effect.map(({ attributionClaims }) => attributionClaims),
      Effect.orDie,
    ),
    deliverReceipts,
    run: options.run,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return {
    ...supervisor,
    start: () => { stopped = false; supervisor.start(); },
    stop: () => { stopped = true; supervisor.stop(); },
  };
};
