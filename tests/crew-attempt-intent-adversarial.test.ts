import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CrewRepository,
  CrewRepositoryLive,
} from "../src/main/vellum-command/work/crew-repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";
import { ActorSeatId } from "../src/shared/actor-seat";

// Crash-probe proof for the attempt-intent witness (root ruling). The
// sequence: pre-write refusal (set-once refused_at) -> same-generation retry
// authorized -> markAttempted re-opens intent -> physical write -> crash
// before outcome. Boot reconciliation must catch the OPEN intent
// (attempt_seq > resolved_seq) even though a refused_at fact exists — the
// prior refusal is an independent fact, not proof the latest write
// concluded. Verified against the real CrewRepository over SQLite.

const SEAT = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);
const root = join(tmpdir(), `vellum-command-attempt-intent-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    CrewRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
  ),
);

let crew: Context.Service.Shape<typeof CrewRepository>;
const sink = { canvasName: "factory", nodeId: "agent-1" };
const iso = (n: number): string => new Date(1_760_000_000_000 + n).toISOString();

const key = (messageId: string, generation: string) => ({
  sink,
  messageId,
  recipientSeatId: SEAT,
  recipientGeneration: generation,
});

beforeAll(async () => {
  crew = await runtime.runPromise(CrewRepository);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("attempt-intent versioning across a crash", () => {
  it("a refused outcome does not hide a later unwitnessed attempt", async () => {
    const k = key("m-crash-probe", "gen-1");
    await runtime.runPromise(
      crew.enqueueAttempt({ ...k, policy: "notice", at: iso(1) }),
    );
    // Attempt 1: intent opened, then refused cleanly before any write.
    await runtime.runPromise(crew.markAttempted({ ...k, at: iso(2) }));
    const refused = await runtime.runPromise(
      crew.recordAttempt({
        ...k,
        outcome: { kind: "refused", at: iso(3), reason: "seat-busy" },
      }),
    );
    expect(refused.facts.refusedAt).toBe(iso(3));

    // Attempt 2: same-generation retry authorized — intent re-opens,
    // physical write happens, then the process crashes before the outcome.
    await runtime.runPromise(crew.markAttempted({ ...k, at: iso(4) }));

    // Boot reconcile must see the OPEN intent through the refused fact.
    const reconciled = await runtime.runPromise(
      crew.reconcileUnresolvedAttempts(iso(5)),
    );
    expect(reconciled).toBe(1);

    const row = await runtime.runPromise(crew.attempt(k));
    // The crash becomes unresolved…
    expect(row?.facts.unresolvedAt).toBe(iso(5));
    // …the independent refusal fact survives…
    expect(row?.facts.refusedAt).toBe(iso(3));
    expect(row?.facts.refusedReason).toBe("seat-busy");
    // …and the first intent witness stays set-once.
    expect(row?.facts.attemptedAt).toBe(iso(2));

    // Idempotent: the intent is closed; a second sweep finds nothing.
    expect(
      await runtime.runPromise(crew.reconcileUnresolvedAttempts(iso(6))),
    ).toBe(0);
  });

  it("a refused row with no second attempt is left alone", async () => {
    const k = key("m-clean-refusal", "gen-1");
    await runtime.runPromise(
      crew.enqueueAttempt({ ...k, policy: "notice", at: iso(10) }),
    );
    await runtime.runPromise(crew.markAttempted({ ...k, at: iso(11) }));
    await runtime.runPromise(
      crew.recordAttempt({
        ...k,
        outcome: { kind: "refused", at: iso(12), reason: "composer-draft" },
      }),
    );
    expect(
      await runtime.runPromise(crew.reconcileUnresolvedAttempts(iso(13))),
    ).toBe(0);
    const row = await runtime.runPromise(crew.attempt(k));
    expect(row?.facts.unresolvedAt).toBeUndefined();
    expect(row?.facts.refusedAt).toBe(iso(12));
  });
});
