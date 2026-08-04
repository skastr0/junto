import type { WorkOpName } from "@shared/work-control";
import {
  productLicenseAdmission,
  ProductLicenseAuthoringRefused,
} from "./license/admission";

/**
 * Every main-process ingress that can eventually change a canvas document.
 * Keeping this vocabulary closed makes missing shutdown coverage a type error
 * instead of a convention hidden in string labels.
 */
export const MAIN_AUTHORING_LABELS = [
  "ipc.canvas.write",
  "ipc.canvas.create",
  "ipc.canvas.delete",
  "ipc.canvas.portfolio",
  "kernel.claim-tick",
  "startup.canvas.ensure-seed",
  "ipc.work.task-create",
  "ipc.work.task-propose",
  "ipc.work.task-approve-proposal",
  "ipc.work.task-reject-proposal",
  "ipc.work.task-describe",
  "ipc.work.task-transition",
  "ipc.work.task-respond",
  "ipc.work.task-claim",
  "ipc.work.message-append",
  "ipc.work.request-create",
  "ipc.work.request-resolve",
  "ipc.work.artifact-publish",
  "control.work.tasks-claim",
  "control.work.tasks-create",
  "control.work.tasks-update",
  "control.work.msg-send",
  "control.work.request-escalate",
  "control.work.artifact-publish",
  "control.work.board-create-topic",
  "control.work.board-post",
  "control.work.board-mark-read",
  "control.work.relay-trigger",
  "ipc.work.board-topic-create",
  "ipc.work.board-post",
  "ipc.work.board-mark-read",
  "ipc.work.board-notify",
  "delivery.message-stamp",
  "delivery.board-wake",
  "kernel.flag-mirror",
  "kernel.phase-mirror",
] as const;

export type MainAuthoringLabel = (typeof MAIN_AUTHORING_LABELS)[number];

export type MainAuthoringPhase = "open" | "precommit-closed" | "committed-closed";

export type MainAuthoringWorkClassification = "read" | "authorial";

/**
 * Exhaustive by construction: adding an operation to WorkOpName must also
 * decide whether it may remain available while authorial admission is closed.
 */
const WORK_OPERATION_CLASSIFICATION = {
  ping: "read",
  doctor: "read",
  capabilities: "read",
  onboard: "read",
  // Preamble only emits an ephemeral renderer event; it does not author the
  // canvas document or a work-plane row.
  preamble: "read",
  "tasks.list": "read",
  "tasks.create": "authorial",
  "tasks.claim": "authorial",
  "tasks.update": "authorial",
  "content.path": "read",
  "content.stat": "read",
  "content.materialize": "read",
  "msg.list": "read",
  "msg.send": "authorial",
  "msg.read": "authorial",
  "msg.reply": "authorial",
  "request.escalate": "authorial",
  "artifact.publish": "authorial",
  "board.list": "read",
  "board.create_topic": "authorial",
  "board.post": "authorial",
  "board.mark_read": "authorial",
  "relay.trigger": "authorial",
} as const satisfies Record<WorkOpName, MainAuthoringWorkClassification>;

export const classifyMainAuthoringWorkOperation = (
  operation: WorkOpName,
): MainAuthoringWorkClassification => WORK_OPERATION_CLASSIFICATION[operation];

const WORK_AUTHORING_LABELS = {
  "tasks.create": "control.work.tasks-create",
  "tasks.claim": "control.work.tasks-claim",
  "tasks.update": "control.work.tasks-update",
  "msg.send": "control.work.msg-send",
  "msg.read": "control.work.msg-send",
  "msg.reply": "control.work.msg-send",
  "request.escalate": "control.work.request-escalate",
  "artifact.publish": "control.work.artifact-publish",
  "board.create_topic": "control.work.board-create-topic",
  "board.post": "control.work.board-post",
  "board.mark_read": "control.work.board-mark-read",
  "relay.trigger": "control.work.relay-trigger",
} as const satisfies Record<
  Extract<
    WorkOpName,
    | "tasks.create"
    | "tasks.claim"
    | "tasks.update"
    | "msg.send"
    | "msg.read"
    | "msg.reply"
    | "request.escalate"
    | "artifact.publish"
    | "board.create_topic"
    | "board.post"
    | "board.mark_read"
    | "relay.trigger"
  >,
  MainAuthoringLabel
>;

export const mainAuthoringLabelForWorkOperation = (
  operation: WorkOpName,
): MainAuthoringLabel | undefined => {
  if (classifyMainAuthoringWorkOperation(operation) === "read") return undefined;
  return WORK_AUTHORING_LABELS[operation as keyof typeof WORK_AUTHORING_LABELS];
};

export class MainAuthoringRefused extends Error {
  readonly _tag = "MainAuthoringRefused";
  readonly code = "main_authoring_closed";

  constructor(
    readonly phase: Exclude<MainAuthoringPhase, "open">,
    readonly epoch: number,
    readonly label: MainAuthoringLabel,
  ) {
    super(`main authoring is ${phase} for epoch ${epoch}; refused ${label}`);
    this.name = "MainAuthoringRefused";
  }
}

export class MainAuthoringTransitionError extends Error {
  readonly _tag = "MainAuthoringTransitionError";

  constructor(
    readonly code:
      | "precommit_already_active"
      | "already_committed"
      | "stale_epoch"
      | "active_operations"
      | "final_permit_active"
      | "final_permit_used"
      | "drain_required"
      | "invalid_final_permit"
      | "unsupported_final_operation",
    message: string,
  ) {
    super(message);
    this.name = "MainAuthoringTransitionError";
  }
}

export interface MainAuthoringPrecommitReceipt {
  readonly epoch: number;
  readonly phase: "precommit-closed";
  readonly closedAt: number;
  readonly activeLabels: ReadonlyArray<MainAuthoringLabel>;
}

export interface MainAuthoringCommitReceipt {
  readonly epoch: number;
  readonly phase: "committed-closed";
  readonly committedAt: number;
}

export interface MainAuthoringRecoveryReceipt {
  readonly epoch: number;
  readonly phase: "open";
  readonly recoveredAt: number;
}

export interface MainAuthoringDrainReceipt {
  readonly epoch: number;
  readonly phase: Exclude<MainAuthoringPhase, "open">;
  /** Every operation observed across the fixed-point drain, in admission order. */
  readonly labels: ReadonlyArray<MainAuthoringLabel>;
  readonly settled: number;
  readonly fulfilled: number;
  readonly rejected: number;
  readonly rounds: number;
  /** Empty on a completed fixed-point drain; explicit for fail-closed consumers. */
  readonly activeLabels: ReadonlyArray<MainAuthoringLabel>;
  readonly finalPermitsActive: number;
  readonly clean: boolean;
}

export type MainAuthoringFinalOperation = "canvas.write" | "canvas.create";

export interface MainAuthoringFinalPermitBinding {
  readonly senderId: number;
  readonly requestId: string;
}

export interface MainAuthoringFinalPermitReceipt extends MainAuthoringFinalPermitBinding {
  readonly epoch: number;
  readonly issuedAt: number;
}

interface ActiveOperation {
  readonly id: number;
  readonly label: MainAuthoringLabel;
  promise: Promise<unknown>;
}

interface FinalPermitRecord extends MainAuthoringFinalPermitReceipt {
  used: boolean;
}

export interface MainAuthoringGate {
  /** Admit and strongly retain the actual main-process promise until settlement. */
  readonly run: <A>(label: MainAuthoringLabel, operation: () => Promise<A>) => Promise<A>;
  /** Synchronously closes ordinary authorial admission for a reversible epoch. */
  readonly beginPrecommit: () => MainAuthoringPrecommitReceipt;
  /** Reopen only an unused, fully drained precommit epoch. */
  readonly recover: (epoch: number) => MainAuthoringRecoveryReceipt;
  /** Make an already-closed, fully drained epoch irreversible. */
  readonly commit: (epoch: number) => MainAuthoringCommitReceipt;
  /** Await admitted work to a true fixed point using allSettled semantics. */
  readonly drain: (epoch: number) => Promise<MainAuthoringDrainReceipt>;
  /** Mint narrow final-write authority for one exact renderer request. */
  readonly mintFinalWritePermit: (
    epoch: number,
    binding: MainAuthoringFinalPermitBinding,
  ) => MainAuthoringFinalPermitReceipt;
  /** Revoke the exact permit before the post-flush drain. */
  readonly revokeFinalWritePermit: (
    epoch: number,
    binding: MainAuthoringFinalPermitBinding,
  ) => void;
  /**
   * Admit a final renderer write/create while ordinary admission is closed.
   * A flush request may perform multiple calls (conflict rebase or recovery
   * create+write); every call remains bound to the same sender/request until
   * the main process explicitly revokes that permit.
   */
  readonly runFinalWrite: <A>(
    binding: MainAuthoringFinalPermitBinding,
    operation: MainAuthoringFinalOperation,
    label: Extract<MainAuthoringLabel, "ipc.canvas.write" | "ipc.canvas.create">,
    task: () => Promise<A>,
  ) => Promise<A>;
  readonly snapshot: () => Readonly<{
    phase: MainAuthoringPhase;
    epoch: number;
    activeLabels: ReadonlyArray<MainAuthoringLabel>;
    finalPermitsActive: number;
    finalPermitUsed: boolean;
  }>;
}

const bindingKey = (binding: MainAuthoringFinalPermitBinding): string =>
  `${binding.senderId}\u0000${binding.requestId}`;

const validateBinding = (binding: MainAuthoringFinalPermitBinding): void => {
  if (!Number.isSafeInteger(binding.senderId) || binding.senderId <= 0) {
    throw new MainAuthoringTransitionError(
      "invalid_final_permit",
      "final-write permit senderId must be a positive safe integer",
    );
  }
  if (
    typeof binding.requestId !== "string" ||
    binding.requestId.length === 0 ||
    binding.requestId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(binding.requestId)
  ) {
    throw new MainAuthoringTransitionError(
      "invalid_final_permit",
      "final-write permit requestId must be non-empty, bounded, and control-free",
    );
  }
};

export const createMainAuthoringGate = (): MainAuthoringGate => {
  let phase: MainAuthoringPhase = "open";
  let epoch = 0;
  let closedAt = 0;
  let nextOperationId = 0;
  let finalPermitUsed = false;
  let admissionVersion = 0;
  let lastCleanDrain:
    | { readonly epoch: number; readonly admissionVersion: number }
    | undefined;
  const active = new Map<number, ActiveOperation>();
  // Closed-epoch journal: unlike the live registry, this retains even a fast
  // settlement until a drain has explicitly observed it. That makes a final
  // write admitted and settled between drain rounds visible in the receipt.
  const closedAdmissions = new Map<number, ActiveOperation>();
  const finalPermits = new Map<string, FinalPermitRecord>();
  let drainFlight:
    | {
        readonly epoch: number;
        promise: Promise<MainAuthoringDrainReceipt>;
        completed: boolean;
      }
    | undefined;

  const activeLabels = (): ReadonlyArray<MainAuthoringLabel> =>
    [...active.values()].sort((a, b) => a.id - b.id).map((entry) => entry.label);

  const requireClosedEpoch = (attemptedEpoch: number): void => {
    if (attemptedEpoch !== epoch || phase === "open") {
      throw new MainAuthoringTransitionError(
        "stale_epoch",
        `main authoring epoch ${attemptedEpoch} does not own closed epoch ${epoch}`,
      );
    }
  };

  const retain = <A>(label: MainAuthoringLabel, operation: () => Promise<A>): Promise<A> => {
    const id = ++nextOperationId;
    admissionVersion += 1;
    lastCleanDrain = undefined;

    // Publish a settlement token before invoking caller code. A task factory
    // may synchronously re-enter quit preparation; commit/recovery must see
    // this lifetime before any user code gets that chance.
    let resolveStarted!: (value: A) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<A>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    // The actual task remains the returned promise. This token only closes the
    // pre-publication gap, and this handler contains its mirrored rejection.
    void started.catch(() => undefined);
    const record: ActiveOperation = { id, label, promise: started };
    active.set(id, record);
    if (phase !== "open") closedAdmissions.set(id, record);

    let promise: Promise<A>;
    try {
      // Promise.resolve preserves an actual Promise's identity. The registry
      // therefore outlives renderer timeouts, socket disconnects, and abandoned
      // caller continuations without substituting a timeout wrapper.
      promise = Promise.resolve(operation());
    } catch (error) {
      promise = Promise.reject(error);
    }
    record.promise = promise;
    void promise.then(resolveStarted, rejectStarted);
    const retire = (): void => {
      const current = active.get(id);
      if (current === record) active.delete(id);
    };
    // Use both handlers rather than an ignored finally() chain, which would
    // manufacture a second rejected promise on operation failure.
    void promise.then(retire, retire);
    return promise;
  };

  const run = <A>(label: MainAuthoringLabel, operation: () => Promise<A>): Promise<A> => {
    if (phase !== "open") {
      return Promise.reject(new MainAuthoringRefused(phase, epoch, label));
    }
    // License maintenance: canvas stays readable; authorial mutations refuse.
    // Final-write permits during precommit flush remain available so the
    // flush→commit transaction can land pending edits before custody sticks.
    const license = productLicenseAdmission.snapshot();
    if (
      license.admitted &&
      license.mode === "maintenance"
    ) {
      return Promise.reject(new ProductLicenseAuthoringRefused());
    }
    return retain(label, operation);
  };

  const beginPrecommit = (): MainAuthoringPrecommitReceipt => {
    if (phase === "committed-closed") {
      throw new MainAuthoringTransitionError(
        "already_committed",
        `main authoring is irreversibly closed at epoch ${epoch}`,
      );
    }
    if (phase === "precommit-closed") {
      throw new MainAuthoringTransitionError(
        "precommit_already_active",
        `main authoring precommit epoch ${epoch} is already active`,
      );
    }
    epoch += 1;
    phase = "precommit-closed";
    closedAt = Date.now();
    finalPermitUsed = false;
    lastCleanDrain = undefined;
    finalPermits.clear();
    closedAdmissions.clear();
    for (const [id, entry] of active) closedAdmissions.set(id, entry);
    return Object.freeze({
      epoch,
      phase,
      closedAt,
      activeLabels: Object.freeze([...activeLabels()]),
    });
  };

  const recover = (attemptedEpoch: number): MainAuthoringRecoveryReceipt => {
    requireClosedEpoch(attemptedEpoch);
    if (phase === "committed-closed") {
      throw new MainAuthoringTransitionError(
        "already_committed",
        `main authoring epoch ${epoch} is irreversibly committed`,
      );
    }
    if (active.size > 0) {
      throw new MainAuthoringTransitionError(
        "active_operations",
        `cannot recover main authoring epoch ${epoch} with active operations: ${activeLabels().join(", ")}`,
      );
    }
    if (finalPermits.size > 0) {
      throw new MainAuthoringTransitionError(
        "final_permit_active",
        `cannot recover main authoring epoch ${epoch} with active final-write permits`,
      );
    }
    if (finalPermitUsed) {
      throw new MainAuthoringTransitionError(
        "final_permit_used",
        `cannot recover main authoring epoch ${epoch} after a final-write permit was used`,
      );
    }
    if (
      lastCleanDrain?.epoch !== attemptedEpoch ||
      lastCleanDrain.admissionVersion !== admissionVersion
    ) {
      throw new MainAuthoringTransitionError(
        "drain_required",
        `cannot recover main authoring epoch ${epoch} before its current admissions are drained`,
      );
    }
    phase = "open";
    closedAdmissions.clear();
    lastCleanDrain = undefined;
    return Object.freeze({
      epoch,
      phase,
      recoveredAt: Date.now(),
    });
  };

  const commit = (attemptedEpoch: number): MainAuthoringCommitReceipt => {
    requireClosedEpoch(attemptedEpoch);
    if (phase === "committed-closed") {
      throw new MainAuthoringTransitionError(
        "already_committed",
        `main authoring epoch ${epoch} is already committed`,
      );
    }
    if (active.size > 0) {
      throw new MainAuthoringTransitionError(
        "active_operations",
        `cannot commit main authoring epoch ${epoch} with active operations: ${activeLabels().join(", ")}`,
      );
    }
    if (finalPermits.size > 0) {
      throw new MainAuthoringTransitionError(
        "final_permit_active",
        `cannot commit main authoring epoch ${epoch} with active final-write permits`,
      );
    }
    if (
      lastCleanDrain?.epoch !== attemptedEpoch ||
      lastCleanDrain.admissionVersion !== admissionVersion
    ) {
      throw new MainAuthoringTransitionError(
        "drain_required",
        `cannot commit main authoring epoch ${epoch} before its current admissions are drained`,
      );
    }
    phase = "committed-closed";
    closedAdmissions.clear();
    lastCleanDrain = undefined;
    return Object.freeze({
      epoch,
      phase,
      committedAt: Date.now(),
    });
  };

  const drain = (attemptedEpoch: number): Promise<MainAuthoringDrainReceipt> => {
    requireClosedEpoch(attemptedEpoch);
    if (drainFlight?.epoch === attemptedEpoch && !drainFlight.completed) {
      return drainFlight.promise;
    }

    // Publish the mutable flight before its async body can settle. New work in
    // the promise-resolution microtask window must see `completed` and start a
    // fresh drain rather than inherit the just-completed receipt.
    const flight: NonNullable<typeof drainFlight> = {
      epoch: attemptedEpoch,
      promise: Promise.resolve(undefined as never),
      completed: false,
    };
    drainFlight = flight;

    const promise = (async (): Promise<MainAuthoringDrainReceipt> => {
      const observedIds = new Set<number>();
      const observedLabels: MainAuthoringLabel[] = [];
      let settled = 0;
      let fulfilled = 0;
      let rejected = 0;
      let rounds = 0;

      while (true) {
        requireClosedEpoch(attemptedEpoch);
        const round = [...closedAdmissions.values()]
          .filter((entry) => !observedIds.has(entry.id))
          .sort((a, b) => a.id - b.id);
        if (round.length === 0) {
          // Let settlement continuations enqueue permit-backed final writes,
          // then verify the registry once more before issuing a receipt.
          await Promise.resolve();
          const unseen = [...closedAdmissions.values()].some(
            (entry) => !observedIds.has(entry.id),
          );
          if (!unseen) break;
          continue;
        }
        rounds += 1;
        for (const entry of round) {
          observedIds.add(entry.id);
          observedLabels.push(entry.label);
        }
        const outcomes = await Promise.allSettled(round.map((entry) => entry.promise));
        settled += outcomes.length;
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") fulfilled += 1;
          else rejected += 1;
        }
      }

      const remaining = activeLabels();
      const permits = finalPermits.size;
      for (const id of observedIds) closedAdmissions.delete(id);
      const clean = remaining.length === 0 && permits === 0;
      if (clean) {
        lastCleanDrain = {
          epoch: attemptedEpoch,
          admissionVersion,
        };
      }
      flight.completed = true;
      return Object.freeze({
        epoch: attemptedEpoch,
        phase: phase as Exclude<MainAuthoringPhase, "open">,
        labels: Object.freeze(observedLabels),
        settled,
        fulfilled,
        rejected,
        rounds,
        activeLabels: Object.freeze([...remaining]),
        finalPermitsActive: permits,
        clean,
      });
    })();

    flight.promise = promise;
    void promise.then(
      () => {
        if (drainFlight?.promise === promise) drainFlight = undefined;
      },
      () => {
        if (drainFlight?.promise === promise) drainFlight = undefined;
      },
    );
    return promise;
  };

  const mintFinalWritePermit = (
    attemptedEpoch: number,
    binding: MainAuthoringFinalPermitBinding,
  ): MainAuthoringFinalPermitReceipt => {
    requireClosedEpoch(attemptedEpoch);
    if (phase !== "precommit-closed") {
      throw new MainAuthoringTransitionError(
        "already_committed",
        "final-write permits cannot be minted after main authoring commit",
      );
    }
    validateBinding(binding);
    const key = bindingKey(binding);
    if (finalPermits.has(key)) {
      throw new MainAuthoringTransitionError(
        "invalid_final_permit",
        "a final-write permit already exists for this sender and request",
      );
    }
    const receipt: FinalPermitRecord = {
      epoch: attemptedEpoch,
      senderId: binding.senderId,
      requestId: binding.requestId,
      issuedAt: Date.now(),
      used: false,
    };
    lastCleanDrain = undefined;
    finalPermits.set(key, receipt);
    return Object.freeze({
      epoch: receipt.epoch,
      senderId: receipt.senderId,
      requestId: receipt.requestId,
      issuedAt: receipt.issuedAt,
    });
  };

  const revokeFinalWritePermit = (
    attemptedEpoch: number,
    binding: MainAuthoringFinalPermitBinding,
  ): void => {
    requireClosedEpoch(attemptedEpoch);
    validateBinding(binding);
    const key = bindingKey(binding);
    const permit = finalPermits.get(key);
    if (permit === undefined || permit.epoch !== attemptedEpoch) {
      throw new MainAuthoringTransitionError(
        "invalid_final_permit",
        "no exact final-write permit exists for this sender, request, and epoch",
      );
    }
    finalPermits.delete(key);
  };

  const runFinalWrite = <A>(
    binding: MainAuthoringFinalPermitBinding,
    operation: MainAuthoringFinalOperation,
    label: Extract<MainAuthoringLabel, "ipc.canvas.write" | "ipc.canvas.create">,
    task: () => Promise<A>,
  ): Promise<A> => {
    if (operation !== "canvas.write" && operation !== "canvas.create") {
      return Promise.reject(
        new MainAuthoringTransitionError(
          "unsupported_final_operation",
          `unsupported final-write operation ${String(operation)}`,
        ),
      );
    }
    if (
      (operation === "canvas.write" && label !== "ipc.canvas.write") ||
      (operation === "canvas.create" && label !== "ipc.canvas.create")
    ) {
      return Promise.reject(
        new MainAuthoringTransitionError(
          "unsupported_final_operation",
          `final-write operation ${operation} does not match ${label}`,
        ),
      );
    }
    if (phase !== "precommit-closed") {
      return Promise.reject(
        new MainAuthoringTransitionError(
          "invalid_final_permit",
          `final writes require a precommit-closed epoch; current phase is ${phase}`,
        ),
      );
    }
    try {
      validateBinding(binding);
    } catch (error) {
      return Promise.reject(error);
    }
    const permit = finalPermits.get(bindingKey(binding));
    if (permit === undefined || permit.epoch !== epoch) {
      return Promise.reject(
        new MainAuthoringTransitionError(
          "invalid_final_permit",
          "final-write binding does not match an active main-minted permit",
        ),
      );
    }
    permit.used = true;
    finalPermitUsed = true;
    return retain(label, task);
  };

  return {
    run,
    beginPrecommit,
    recover,
    commit,
    drain,
    mintFinalWritePermit,
    revokeFinalWritePermit,
    runFinalWrite,
    snapshot: () => Object.freeze({
      phase,
      epoch,
      activeLabels: Object.freeze([...activeLabels()]),
      finalPermitsActive: finalPermits.size,
      finalPermitUsed,
    }),
  };
};

/** Process-global main authoring authority. Tests should use the factory. */
export const mainAuthoringGate = createMainAuthoringGate();
