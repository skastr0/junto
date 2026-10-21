import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREW_STATE_SCHEMA_SQL } from "../src/main/junto/work/crew-schema";
import { migrateReviewStamps } from "../src/main/junto/state/migrate-review-stamps";

const SEAT = `seat_${"a".repeat(64)}`;

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE work_canvas_revisions (canvas_name TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT");
  db.exec(CREW_STATE_SCHEMA_SQL);
});

afterEach(() => db.close());

const taskVerdict = (id: string, extra: { kind?: string; seat?: string | null; reviewerKind?: string } = {}) => {
  const columns = extra.reviewerKind === undefined ? "" : "reviewer_kind, ";
  const values = extra.reviewerKind === undefined ? "" : `'${extra.reviewerKind}', `;
  const seat = extra.seat === undefined ? SEAT : extra.seat;
  db.prepare(`
    INSERT INTO work_review_verdicts (${columns}verdict_id, kind, reviewer_seat_id, reviewer_node_id, author_seat_id,
      subject_kind, subject_task_installation, subject_task_canvas, subject_task_node, subject_task_item,
      subject_epoch, subject_hash, epoch, findings_json, refs_json, posted_at_ms)
    VALUES (${values}?, ?, ?, 'seat-bo', ?, 'task', 'mini', 'factory', 'tasks-1', 'task-1', 0, 'h', 0, '[]', '[]', 1)
  `).run(id, extra.kind ?? "green", seat, seat);
};

const revision = () => db.prepare("SELECT revision FROM work_canvas_revisions WHERE canvas_name = 'factory'").get();

describe("review stamps migration", () => {
  it("copies every stored verdict as a seat's, without bumping a canvas revision", () => {
    taskVerdict("v1");
    db.exec("DELETE FROM work_canvas_revisions");
    migrateReviewStamps(db);
    expect(db.prepare("SELECT verdict_id, reviewer_kind, reviewer_seat_id FROM work_review_verdicts").all()).toEqual([
      { verdict_id: "v1", reviewer_kind: "seat", reviewer_seat_id: SEAT },
    ]);
    expect(revision()).toBeUndefined();
  });

  it("then holds operator verdicts on tasks, with no seat ids, and keeps the revision trigger", () => {
    migrateReviewStamps(db);
    taskVerdict("v2", { reviewerKind: "operator", seat: null });
    expect(revision()).toEqual({ revision: 1 });
    expect(() => taskVerdict("v3", { reviewerKind: "operator" })).toThrow(/CHECK/);
    expect(() => taskVerdict("v4", { reviewerKind: "seat", seat: null })).toThrow(/CHECK/);
  });
});
