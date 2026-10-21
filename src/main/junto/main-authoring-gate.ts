import type { WorkOpName } from "@shared/work-control";

/**
 * Every main-process ingress that can eventually change canvas or Work rows.
 * Keeping this vocabulary closed makes missing shutdown coverage a type error
 * instead of a convention hidden in string labels.
 */
export const MAIN_AUTHORING_LABELS = [
  "ipc.model.command",
  "ipc.canvas.portfolio",
  "control.overseer",
  "kernel.claim-tick",
  "startup.canvas.ensure-seed",
  "ipc.work.task-create",
  "ipc.work.task-describe",
  "ipc.work.task-transition",
  "ipc.work.task-promote",
  "ipc.work.task-comment",
  "ipc.work.task-respond",
  "ipc.work.message-append",
  "ipc.work.signal-answer",
  "ipc.work.signal-dismiss",
  "ipc.work.artifact-archive",
  "ipc.work.artifact-delete",
  "ipc.resource.task-apply",
  "ipc.resource.artifact-apply",
  "control.work.tasks-create",
  "control.work.tasks-update",
  "control.work.msg-send",
  "control.work.signal",
  "control.work.offboard",
  "ipc.work.collaboration-ask",
  "ipc.work.thread-send",
  "companion.signal-answer",
  "companion.signal-dismiss",
  "companion.mail-send",
  "delivery.message-stamp",
  "review.checkout",
  "kernel.flag-mirror",
  "kernel.phase-mirror",
  "seat-sessions.rotate",
] as const;

export type MainAuthoringLabel = (typeof MAIN_AUTHORING_LABELS)[number];

/**
 * One-way lifecycle. `final-flush` still admits the renderer's model commands
 * so an open editor draft can land; `closed` admits nothing. There is no
 * reopen: the gate only leaves `open` after the operator has confirmed quit.
 */
export type MainAuthoringPhase = "open" | "final-flush" | "closed";

/**
 * The renderer's quit flush lands through the ordinary model command handler.
 * Sender trust is already proven at the IPC boundary
 * (isTrustedMainWebContents), so the label alone is the admission fact here.
 */
const FINAL_FLUSH_LABELS: ReadonlySet<MainAuthoringLabel> = new Set([
  "ipc.model.command",
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
  since: "read",
  // Offboard writes the seat's own notes file and seat_sessions row.
  offboard: "authorial",
  // Preamble only emits an ephemeral renderer event; it does not author the
  // canvas document or a work-plane row.
  preamble: "read",
  // The envelope can carry authoring or native effects. Close the complete
  // administrative ingress during shutdown, independently of factory pause.
  overseer: "authorial",
  "overseer.live": "read",
  "task.list": "read",
  "task.wait": "read",
  "task.show": "read",
  "task.create": "authorial",
  "task.edit": "authorial",
  "task.assign": "authorial",
  "task.unassign": "authorial",
  "task.start": "authorial",
  "task.pause": "authorial",
  "task.resume": "authorial",
  "task.finish": "authorial",
  "task.cancel": "authorial",
  "task.archive": "authorial",
  "task.depend": "authorial",
  "task.undepend": "authorial",
  "task.reviewer-add": "authorial",
  "task.reviewer-remove": "authorial",
  "task.stamp-policy": "authorial",
  "task.stamp": "authorial",
  "task.comment": "authorial",
  "task.rules": "read",
  "task.check": "authorial",
  rulings: "read",
  "content.path": "read",
  "content.stat": "read",
  "content.materialize": "read",
  "msg.list": "authorial",
  "msg.send": "authorial",
  "msg.prompt": "authorial",
  "msg.sent": "read",
  "seat.wait": "read",
  "seat.read": "read",
  "msg.read": "authorial",
  "msg.reply": "authorial",
  "msg.react": "authorial",
  // Signals write the seat's own durable agent_signals row.
  "signal.raise": "authorial",
  "signal.clear": "authorial",
  "signal.list": "read",
  "op.show": "read",
  "op.list": "read",
  "env.report": "read",
  "logs.read": "read",
  "references.list": "read",
  "references.read": "read",
  // Staging writes the content store and its manifest.
  "content.stage": "authorial",
  "automation.list": "read",
  "automation.show": "read",
  "automation.history": "read",
  "artifact.list": "read",
  "artifact.show": "read",
  "artifact.history": "read",
  "artifact.create": "authorial",
  "artifact.edit": "authorial",
  "artifact.comment": "authorial",
  "artifact.archive": "authorial",
  "artifact.restore": "authorial",
} as const satisfies Record<WorkOpName, MainAuthoringWorkClassification>;

export const classifyMainAuthoringWorkOperation = (
  operation: WorkOpName,
): MainAuthoringWorkClassification => WORK_OPERATION_CLASSIFICATION[operation];

const WORK_AUTHORING_LABELS = {
  overseer: "control.overseer",
  "task.create": "control.work.tasks-create",
  // Every other task write moves or edits a task: one family, one label.
  "task.edit": "control.work.tasks-update",
  "task.assign": "control.work.tasks-update",
  "task.unassign": "control.work.tasks-update",
  "task.start": "control.work.tasks-update",
  "task.pause": "control.work.tasks-update",
  "task.resume": "control.work.tasks-update",
  "task.finish": "control.work.tasks-update",
  "task.cancel": "control.work.tasks-update",
  "task.archive": "control.work.tasks-update",
  "task.depend": "control.work.tasks-update",
  "task.undepend": "control.work.tasks-update",
  "task.reviewer-add": "control.work.tasks-update",
  "task.reviewer-remove": "control.work.tasks-update",
  "task.stamp-policy": "control.work.tasks-update",
  "task.stamp": "control.work.tasks-update",
  "task.comment": "control.work.tasks-update",
  // Check results stamp on the task row — same authorial family as an
  // update, so it carries the same label rather than minting a new one.
  "task.check": "control.work.tasks-update",
  "msg.list": "control.work.msg-send",
  "msg.send": "control.work.msg-send",
  "msg.read": "control.work.msg-send",
  "msg.reply": "control.work.msg-send",
  "msg.react": "control.work.msg-send",
  "signal.raise": "control.work.signal",
  "signal.clear": "control.work.signal",
  // A staged file is a signal's attachment on its way in: the same
  // authorial family, so it carries the same label.
  "content.stage": "control.work.signal",
  offboard: "control.work.offboard",
} as const satisfies Record<
  Extract<
    WorkOpName,
    | "overseer"
    | "task.create"
    | "task.edit"
    | "task.assign"
    | "task.unassign"
    | "task.start"
    | "task.pause"
    | "task.resume"
    | "task.finish"
    | "task.cancel"
    | "task.archive"
    | "task.depend"
    | "task.undepend"
    | "task.reviewer-add"
    | "task.reviewer-remove"
    | "task.stamp-policy"
    | "task.stamp"
    | "task.comment"
    | "task.check"
    | "msg.list"
    | "msg.send"
    | "msg.read"
    | "msg.reply"
    | "msg.react"
    | "signal.raise"
    | "signal.clear"
    | "content.stage"
    | "offboard"
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
