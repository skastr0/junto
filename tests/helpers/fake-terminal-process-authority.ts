import type {
  AppProcessSignalReceipt,
  AppTerminalExit,
  AppTerminalLease,
  AppTerminalSpawnSpec,
} from "../../src/main/vellum/app-process-plane";
import type { LocalTerminalProcessAuthority } from "../../src/main/vellum/term/local-host";

export type FakeTerminalSignal = "SIGTERM" | "SIGKILL";

export interface FakeTerminalController {
  readonly lease: AppTerminalLease;
  readonly spec: AppTerminalSpawnSpec;
  readonly pid: number | undefined;
  readonly signals: FakeTerminalSignal[];
  readonly writes: string[];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }>;
  emitData(data: string): void;
  emitError(error: Error): void;
  exit(code?: number, signal?: number): void;
}

export interface FakeTerminalSpawnOptions {
  readonly pid?: number;
  readonly output?: string;
  readonly autoExitMs?: number;
  readonly exitOnSignal?: FakeTerminalSignal | false;
  readonly resizable?: boolean;
  readonly signalAttempted?: boolean;
  readonly signalFailureReason?: string;
  readonly throwOnSignal?: boolean;
  readonly echoWrites?: string;
}

export interface FakeTerminalProcessAuthority {
  readonly authority: LocalTerminalProcessAuthority;
  readonly controllers: FakeTerminalController[];
}

const rejectedReceipt = (
  signal: FakeTerminalSignal,
  reason: string,
  failureReason: string,
): AppProcessSignalReceipt => ({
  signal,
  reason,
  attempted: false,
  decision: { ok: false, reason: failureReason },
  via: "none",
});

const acceptedReceipt = (
  signal: FakeTerminalSignal,
  reason: string,
): AppProcessSignalReceipt => ({
  signal,
  reason,
  attempted: true,
  decision: { ok: true, mode: "child" },
  via: "child.kill",
});

export const makeFakeTerminalProcessAuthority = (
  optionsForSpawn: (
    spec: AppTerminalSpawnSpec,
    index: number,
  ) => FakeTerminalSpawnOptions = (_spec, index) => ({ pid: 42_420 + index }),
): FakeTerminalProcessAuthority => {
  const controllers: FakeTerminalController[] = [];
  const records = new WeakMap<
    AppTerminalLease,
    {
      readonly controller: FakeTerminalController;
      readonly options: FakeTerminalSpawnOptions;
      readonly exit: (event: AppTerminalExit) => void;
      readonly dataListeners: Set<(data: string) => void>;
      readonly exitListeners: Set<(event: AppTerminalExit) => void>;
      readonly errorListeners: Set<(error: Error) => void>;
      exited: boolean;
      termReceipt: AppProcessSignalReceipt | undefined;
      killReceipt: AppProcessSignalReceipt | undefined;
    }
  >();

  const spawnTerminal = (spec: AppTerminalSpawnSpec): AppTerminalLease => {
    const index = controllers.length;
    const options = optionsForSpawn(spec, index);
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: AppTerminalExit) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    let resolveExit!: (event: AppTerminalExit) => void;
    const exited = new Promise<AppTerminalExit>((resolve) => {
      resolveExit = resolve;
    });
    const writes: string[] = [];
    const resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
    const lease = {
      generation: index + 1,
      source: spec.source,
      purpose: spec.purpose,
      io: {
        pidForDiagnostics: options.pid,
        exited,
        write: (data: string) => {
          writes.push(data);
          if (options.echoWrites !== undefined) {
            for (const listener of [...dataListeners]) {
              listener(`${options.echoWrites}${data}`);
            }
          }
        },
        resize: options.resizable === false
          ? undefined
          : (cols: number, rows: number) => {
            resizes.push({ cols, rows });
          },
        onData: (listener: (data: string) => void) => {
          dataListeners.add(listener);
          return () => dataListeners.delete(listener);
        },
        onExit: (listener: (event: AppTerminalExit) => void) => {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        onError: (listener: (error: Error) => void) => {
          errorListeners.add(listener);
          return () => errorListeners.delete(listener);
        },
      },
    } as unknown as AppTerminalLease;
    const controller: FakeTerminalController = {
      lease,
      spec,
      pid: options.pid,
      signals: [],
      writes,
      resizes,
      emitData(data) {
        for (const listener of [...dataListeners]) listener(data);
      },
      emitError(error) {
        for (const listener of [...errorListeners]) listener(error);
      },
      exit(code = 0, signal) {
        const record = records.get(lease);
        if (record === undefined || record.exited) return;
        record.exited = true;
        const event = { code, signal };
        resolveExit(event);
        for (const listener of [...exitListeners]) listener(event);
      },
    };
    const record = {
      controller,
      options,
      exit: resolveExit,
      dataListeners,
      exitListeners,
      errorListeners,
      exited: false,
      termReceipt: undefined,
      killReceipt: undefined,
    };
    records.set(lease, record);
    controllers.push(controller);
    if (options.output !== undefined) {
      queueMicrotask(() => controller.emitData(options.output!));
    }
    if (options.autoExitMs !== undefined) {
      setTimeout(() => controller.exit(), options.autoExitMs);
    }
    return lease;
  };

  const signal = (
    lease: AppTerminalLease,
    requested: FakeTerminalSignal,
    reason: string,
  ): AppProcessSignalReceipt => {
    const record = records.get(lease);
    if (record === undefined) {
      return rejectedReceipt(requested, reason, "lease-not-registered");
    }
    const prior = requested === "SIGTERM" ? record.termReceipt : record.killReceipt;
    if (prior?.attempted === true) return prior;
    if (record.options.throwOnSignal === true) {
      throw new Error(`fake ${requested} dispatch failed`);
    }
    record.controller.signals.push(requested);
    const receipt = record.options.signalAttempted === false
      ? rejectedReceipt(
        requested,
        reason,
        record.options.signalFailureReason ?? "child-signal-refused",
      )
      : acceptedReceipt(requested, reason);
    if (requested === "SIGTERM") record.termReceipt = receipt;
    else record.killReceipt = receipt;
    if (
      receipt.attempted &&
      (record.options.exitOnSignal ?? "SIGTERM") === requested
    ) {
      record.controller.exit(0, requested === "SIGTERM" ? 15 : 9);
    }
    return receipt;
  };

  return {
    authority: {
      spawnTerminal,
      terminate: (lease, reason) => signal(lease as AppTerminalLease, "SIGTERM", reason),
      forceTerminate: (lease, reason) => signal(lease as AppTerminalLease, "SIGKILL", reason),
    },
    controllers,
  };
};
