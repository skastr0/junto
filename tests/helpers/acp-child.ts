import type {
  AppChildIo,
  AppProcessLease,
  AppProcessSignalReceipt,
} from "../../src/main/vellum/app-process-plane";
import type {
  AcpChildLike,
  SpawnedAcpChild,
} from "../../src/main/vellum/chat/acp-client";

export type TestLocalAcpChild = AcpChildLike & {
  kill(signal?: NodeJS.Signals): unknown;
};

let nextGeneration = 1;

const frozenEvent = (code: number | null) =>
  Object.freeze({ code, signal: null });

/**
 * Test-only central-plane facade around an EventEmitter child. Product code
 * never receives this adapter: HermesPlane mints its lease through the real
 * appProcessPlane at the exact spawn boundary.
 */
export const spawnedLocalAcp = (
  child: TestLocalAcpChild,
): SpawnedAcpChild => {
  let active = true;
  let exitEvent: ReturnType<typeof frozenEvent> | undefined;
  let closeEvent: ReturnType<typeof frozenEvent> | undefined;
  let resolveExit!: (event: ReturnType<typeof frozenEvent>) => void;
  let resolveClose!: (event: ReturnType<typeof frozenEvent>) => void;
  const exited = new Promise<ReturnType<typeof frozenEvent>>((resolve) => {
    resolveExit = resolve;
  });
  const closed = new Promise<ReturnType<typeof frozenEvent>>((resolve) => {
    resolveClose = resolve;
  });

  child.on("exit", (code) => {
    if (exitEvent !== undefined) return;
    active = false;
    exitEvent = frozenEvent(code);
    resolveExit(exitEvent);
  });
  child.on("close", (code) => {
    if (closeEvent !== undefined) return;
    active = false;
    closeEvent = frozenEvent(code);
    if (exitEvent === undefined) {
      exitEvent = closeEvent;
      resolveExit(exitEvent);
    }
    resolveClose(closeEvent);
  });

  const subscribe = <Value>(
    event: "error" | "exit" | "close",
    listener: (value: Value) => void,
  ): (() => void) => {
    child.on(event as never, listener as never);
    return () => {
      const off = (child as unknown as {
        off?: (name: string, sink: (value: Value) => void) => unknown;
      }).off;
      off?.call(child, event, listener);
    };
  };

  const ioValue: AppChildIo = {
    stdin: child.stdin as AppChildIo["stdin"],
    stdout: child.stdout as AppChildIo["stdout"],
    stderr: child.stderr as AppChildIo["stderr"],
    pidForDiagnostics: child.pid,
    exited,
    closed,
    onExit: (listener) => {
      if (exitEvent !== undefined) {
        listener(exitEvent);
        return () => undefined;
      }
      return subscribe("exit", (code: number | null) =>
        listener(frozenEvent(code)));
    },
    onClose: (listener) => {
      if (closeEvent !== undefined) {
        listener(closeEvent);
        return () => undefined;
      }
      return subscribe("close", (code: number | null) =>
        listener(frozenEvent(code)));
    },
    onError: (listener) => subscribe("error", listener),
  };
  const io = Object.freeze(ioValue);
  const lease = Object.freeze({
    generation: nextGeneration++,
    source: "test.chat-acp",
    purpose: "test ACP child",
    mode: "child",
    io,
  }) as unknown as AppProcessLease;

  const send = (
    signal: "SIGTERM" | "SIGKILL",
    reason: string,
  ): AppProcessSignalReceipt => {
    if (!active) {
      const receipt: AppProcessSignalReceipt = {
        signal,
        reason,
        attempted: false,
        decision: { ok: false as const, reason: "process-already-exited" },
        via: "none",
      };
      return Object.freeze(receipt);
    }
    try {
      const accepted = child.kill(signal) !== false;
      const receipt: AppProcessSignalReceipt = accepted
        ? {
            signal,
            reason,
            attempted: true,
            decision: { ok: true as const, mode: "child" as const },
            via: "child.kill",
          }
        : {
            signal,
            reason,
            attempted: false,
            decision: { ok: false as const, reason: "child-signal-refused" },
            via: "none",
          };
      return Object.freeze(receipt);
    } catch {
      const receipt: AppProcessSignalReceipt = {
        signal,
        reason,
        attempted: false,
        decision: { ok: false as const, reason: "child-signal-failed" },
        via: "none",
      };
      return Object.freeze(receipt);
    }
  };

  return {
    kind: "local-process",
    lease,
    processPlane: {
      terminate: (_lease, reason) => send("SIGTERM", reason),
      forceTerminate: (_lease, reason) => send("SIGKILL", reason),
    },
  };
};
