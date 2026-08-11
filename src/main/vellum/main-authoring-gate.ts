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
  "ipc.work.artifact-archive",
  "ipc.work.artifact-delete",
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

/**
 * One-way lifecycle. `final-flush` still admits the renderer's own canvas save
 * so an open editor draft can land; `closed` admits nothing. There is no
 * reopen: the gate only leaves `open` after the operator has confirmed quit.
 */
export type MainAuthoringPhase = "open" | "final-flush" | "closed";

/**
 * The renderer's quit flush lands through the ordinary canvas IPC handlers.
 * Sender trust is already proven at the IPC boundary
 * (isTrustedMainWebContents), so the label alone is the admission fact here.
 */
const FINAL_FLUSH_LABELS: ReadonlySet<MainAuthoringLabel> = new Set([
  "ipc.canvas.write",
  "ipc.canvas.create",
]);

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
  "board.tags": "read",
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
    readonly label: MainAuthoringLabel,
  ) {
    super(`main authoring is ${phase}; refused ${label}`);
    this.name = "MainAuthoringRefused";
  }
}

/** Honest, small drain report: what settled, what did not, and whether time ran out. */
export interface MainAuthoringDrainReport {
  readonly settled: number;
  readonly remaining: ReadonlyArray<MainAuthoringLabel>;
  readonly timedOut: boolean;
}

interface ActiveOperation {
  readonly id: number;
  readonly label: MainAuthoringLabel;
  promise: Promise<unknown>;
}

export interface MainAuthoringGate {
  /** Admit and strongly retain the actual main-process promise until settlement. */
  readonly run: <A>(label: MainAuthoringLabel, operation: () => Promise<A>) => Promise<A>;
  /**
   * Idempotent. Closes ordinary authorial admission and leaves only the
   * renderer's final canvas save admitted.
   */
  readonly beginFinalFlush: () => void;
  /** Idempotent. Full close, canvas saves included. */
  readonly close: () => void;
  /** Await in-flight work up to a deadline. Never blocks quit past that deadline. */
  readonly drain: (timeoutMs: number) => Promise<MainAuthoringDrainReport>;
  readonly snapshot: () => Readonly<{
    phase: MainAuthoringPhase;
    activeLabels: ReadonlyArray<MainAuthoringLabel>;
  }>;
}

export const createMainAuthoringGate = (): MainAuthoringGate => {
  let phase: MainAuthoringPhase = "open";
  let nextOperationId = 0;
  const active = new Map<number, ActiveOperation>();

  const activeLabels = (): ReadonlyArray<MainAuthoringLabel> =>
    [...active.values()].sort((a, b) => a.id - b.id).map((entry) => entry.label);

  const retain = <A>(label: MainAuthoringLabel, operation: () => Promise<A>): Promise<A> => {
    const id = ++nextOperationId;

    // Publish a settlement token before invoking caller code. A task factory
    // may synchronously re-enter quit preparation; a drain started from there
    // must already see this lifetime.
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
    if (phase !== "open" && !(phase === "final-flush" && FINAL_FLUSH_LABELS.has(label))) {
      return Promise.reject(new MainAuthoringRefused(phase, label));
    }
    if (phase === "open") {
      // License maintenance: canvas stays readable; authorial mutations refuse.
      // The final flush stays admitted so pending edits can land before custody
      // sticks — quit must never wedge on an expired entitlement.
      const license = productLicenseAdmission.snapshot();
      if (license.admitted && license.mode === "maintenance") {
        return Promise.reject(new ProductLicenseAuthoringRefused());
      }
    }
    return retain(label, operation);
  };

  const beginFinalFlush = (): void => {
    if (phase === "open") phase = "final-flush";
  };

  const close = (): void => {
    phase = "closed";
  };

  const drain = async (timeoutMs: number): Promise<MainAuthoringDrainReport> => {
    const inFlight = [...active.values()].sort((a, b) => a.id - b.id);
    if (inFlight.length === 0) {
      return Object.freeze({ settled: 0, remaining: Object.freeze([]), timedOut: false });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), Math.max(0, timeoutMs));
    });
    const settlement = Promise.allSettled(inFlight.map((entry) => entry.promise)).then(
      () => "settled" as const,
    );
    const outcome = await Promise.race([settlement, deadline]);
    if (timer !== undefined) clearTimeout(timer);
    const remaining = inFlight
      .filter((entry) => active.get(entry.id) === entry)
      .map((entry) => entry.label);
    return Object.freeze({
      settled: inFlight.length - remaining.length,
      remaining: Object.freeze(remaining),
      timedOut: outcome === "deadline",
    });
  };

  return {
    run,
    beginFinalFlush,
    close,
    drain,
    snapshot: () => Object.freeze({
      phase,
      activeLabels: Object.freeze([...activeLabels()]),
    }),
  };
};

/** Process-global main authoring authority. Tests should use the factory. */
export const mainAuthoringGate = createMainAuthoringGate();
