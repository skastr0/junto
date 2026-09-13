import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { transportLogDirectory } from "@shared/transport-trace";

export type PtyTraceFields = Readonly<Record<string, string | number | boolean | null>>;

export type PtyDeliveryTraceEvent = {
  readonly ts: string;
  readonly deliveryId?: string;
  readonly bindingId: string;
  readonly harness: string;
  readonly event: string;
  readonly fields: PtyTraceFields;
};

export type PtyDeliveryTraceSink = (event: PtyDeliveryTraceEvent) => void;

export type PtyDeliveryTraceContext = {
  readonly deliveryId: string;
  readonly bindingId: string;
  readonly harness: string;
};

export const ptyDeliveryTracePath = (): string =>
  join(transportLogDirectory(), "pty-delivery.jsonl");

/** Install-local diagnostics. Buffer disk work outside the physical write span. */
export const makePtyDeliveryTraceJournal = (path: string) => {
  const pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dropped = 0;
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending.length === 0) return;
    const body = pending.splice(0).join("");
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      try {
        if (statSync(path).size >= 8 * 1024 * 1024) {
          renameSync(path, `${path}.1`);
          chmodSync(`${path}.1`, 0o600);
        }
      } catch {
        // A missing file is expected on the first flush.
      }
      appendFileSync(path, body, { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Diagnostics never reject, retry, or alter a PTY delivery.
    }
  };
  const append: PtyDeliveryTraceSink = (event) => {
    try {
      if (pending.length >= 2_048) {
        dropped += 1;
        return;
      }
      pending.push(`${JSON.stringify({ ...event, ...(dropped > 0 ? { dropped } : {}) })}\n`);
      dropped = 0;
      timer ??= setTimeout(flush, 25);
      timer.unref?.();
    } catch {
      // A bad diagnostic row cannot reach the delivery path.
    }
  };
  return { append, flush };
};

let journal: ReturnType<typeof makePtyDeliveryTraceJournal> | undefined;

/** Correlation only. No payload, operator bytes, or screen text enters this object. */
export class PtyDeliveryTracer {
  private readonly context = new AsyncLocalStorage<PtyDeliveryTraceContext>();
  private readonly executing = new Map<string, PtyDeliveryTraceContext>();
  private readonly last = new Map<string, PtyDeliveryTraceContext>();

  constructor(private readonly sink: PtyDeliveryTraceSink) {}

  capture(): PtyDeliveryTraceContext | undefined {
    return this.context.getStore();
  }

  run<A>(context: PtyDeliveryTraceContext | undefined, body: () => A): A {
    return context === undefined ? body() : this.context.run(context, body);
  }

  activate(bindingId: string): () => void {
    const context = this.capture();
    if (context !== undefined) this.executing.set(bindingId, context);
    return () => {
      if (this.executing.get(bindingId) === context) this.executing.delete(bindingId);
    };
  }

  forget(bindingId: string): void {
    this.executing.delete(bindingId);
    this.last.delete(bindingId);
  }

  event(bindingId: string, event: string, fields: PtyTraceFields = {}): void {
    try {
      const current = this.capture();
      const context = current?.bindingId === bindingId
        ? current
        : this.executing.get(bindingId) ?? this.last.get(bindingId);
      this.sink({
        ts: new Date().toISOString(),
        ...(context === undefined ? {} : { deliveryId: context.deliveryId }),
        bindingId,
        harness: context?.harness ?? "unknown",
        event,
        fields,
      });
    } catch {
      // A failing sink cannot change submission, attention, or acknowledgement.
    }
  }

  prompt(
    bindingId: string,
    text: string,
    harness: () => string | undefined,
    fields: PtyTraceFields,
    body: () => Promise<boolean>,
  ): Promise<boolean> {
    let context: PtyDeliveryTraceContext;
    let digest: string;
    try {
      context = { deliveryId: randomUUID(), bindingId, harness: harness() ?? "unknown" };
      digest = createHash("sha256").update(text).digest("hex");
    } catch {
      return body();
    }
    this.last.set(bindingId, context);
    return this.run(context, () => {
      this.event(bindingId, "delivery.begin", { ...fields, textLength: text.length, textSha256: digest });
      const result = body();
      // Observe the original promise; do not replace it or add an await boundary.
      void result.then(
        (ok) => this.event(bindingId, "delivery.end", { ok }),
        () => this.event(bindingId, "delivery.end", { ok: false, threw: true }),
      );
      return result;
    });
  }
}

export const createPtyDeliveryTracer = (
  sink?: PtyDeliveryTraceSink,
): PtyDeliveryTracer | undefined => {
  try {
    if (sink !== undefined) return new PtyDeliveryTracer(sink);
    if (process.env.VELLUM_COMMAND_PTY_TRACE !== "1") return undefined;
    journal ??= makePtyDeliveryTraceJournal(ptyDeliveryTracePath());
    return new PtyDeliveryTracer(journal.append);
  } catch {
    return undefined;
  }
};
