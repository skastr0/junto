import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, describe, expect, it } from "vitest";
import { ReviewVerdict } from "../src/shared/crew";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CrewRepository, CrewRepositoryLive } from "../src/main/junto/work/crew-repository";

const root = join(tmpdir(), `junto-crew-sql-${randomUUID()}`);
const runtime = ManagedRuntime.make(CrewRepositoryLive.pipe(
  Layer.provideMerge(makeStateEngineLive(join(root, "junto.db"))),
));
afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const author = `seat_${"a".repeat(64)}`;
const reviewer = `seat_${"b".repeat(64)}`;
const verdict = (id: string, kind: "green" | "blocking", at: number) => Schema.decodeUnknownSync(ReviewVerdict)({
  verdictId: id, kind, reviewerSeatId: reviewer, authorSeatId: author,
  subject: { kind: "task", installationId: "cc-crew", canvasName: "factory", nodeId: "task",
    taskId: "task-1", epoch: 3, subjectHash: "f".repeat(64) },
  subjectHash: "f".repeat(64), epoch: 3, findings: [], refs: [], postedAtMs: at,
});
const receipt = {
  canvasName: "factory", sourceKind: "checkout" as const, sourceId: "source-1", refSha: "a".repeat(40),
  reviewerSeatId: reviewer, authorSeatId: author, createdAt: "2026-09-01T00:00:00.000Z",
};

describe("Crew SQL transaction participants", () => {
  it("rolls back verdicts and receipts together, and reads its own writes without re-entering the engine", async () => {
    await runtime.runPromise(Effect.gen(function* () {
      const crew = yield* CrewRepository;
      const sql = yield* SqlClient.SqlClient;
      const outcome = yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
        expect((yield* crew.postVerdictWithin(verdict("rolled-back", "green", 10))).created).toBe(true);
        expect(yield* crew.recordReviewReceiptWithin(receipt)).toBe(true);
        expect(yield* crew.firstAuthorForSha(receipt.refSha)).toBe(author);
        return yield* Effect.fail("rollback");
      })));
      expect(Result.isFailure(outcome) && outcome.failure).toBe("rollback");
      expect(yield* crew.verdictsForSubject(verdict("x", "green", 0).subject)).toEqual([]);
      expect(yield* crew.firstAuthorForSha(receipt.refSha)).toBeUndefined();
    }));
  });

  it("keeps blocking-wins ties, exact epochs and subjects, and idempotent receipts", async () => {
    await runtime.runPromise(Effect.gen(function* () {
      const crew = yield* CrewRepository;
      const green = verdict("green", "green", 20);
      expect((yield* crew.postVerdict(green)).created).toBe(true);
      expect((yield* crew.postVerdict(green)).created).toBe(false);
      const gate = { installationId: "cc-crew", canvasName: "factory", nodeId: "task", taskId: "task-1",
        epoch: 3, subjectHash: "f".repeat(64), excludingSeatId: author };
      expect(yield* crew.currentGreenExists(gate)).toBe(true);
      expect(yield* crew.currentGreenExists({ ...gate, epoch: 4 })).toBe(false);
      expect(yield* crew.currentGreenExists({ ...gate, subjectHash: "e".repeat(64) })).toBe(false);
      expect(yield* crew.currentGreenExists({ ...gate, excludingSeatId: reviewer })).toBe(false);
      yield* crew.postVerdict(verdict("blocking", "blocking", 20));
      expect(yield* crew.currentGreenExists(gate)).toBe(false);
      yield* crew.postVerdict(verdict("new-green", "green", 21));
      expect(yield* crew.currentGreenExists(gate)).toBe(true);
      expect((yield* crew.verdictsForSubject(green.subject)).map((v) => v.verdictId)).toEqual(["blocking", "green", "new-green"]);
      expect(yield* crew.recordReviewReceipt(receipt)).toBe(true);
      expect(yield* crew.recordReviewReceipt({ ...receipt, authorSeatId: reviewer })).toBe(false);
      expect(yield* crew.firstAuthorForSha(receipt.refSha)).toBe(author);
    }));
  });
});
