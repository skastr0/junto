import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { taskNumber } from "../src/shared/task-model";
import type { ItemId } from "../src/shared/work-ids";
import { holdsOf, resolveResourceRef, type ReachedItem } from "../src/main/junto/signals/resource-refs";
import { admitResourceAttachment } from "../src/main/junto/signals/attachments";
import { artifacts, canvasOf, region, seat, taskBoard } from "./support/model-nodes";

// Region R holds seat S, board T and shelf A; board TX sits in a sibling region Q.
const board = canvasOf([
  region("R", { x: 0, y: 0, width: 1000, height: 1000 }),
  seat("S", { x: 10, y: 10 }),
  taskBoard("T", { x: 300, y: 10 }),
  artifacts("A", { x: 600, y: 10 }),
  region("Q", { x: 2000, y: 0, width: 1000, height: 1000 }),
  taskBoard("TX", { x: 2100, y: 10 }),
]);
const S = asNodeId("S");
const T42 = "01M5ESZPWMZZM3TZ88P6FVVK33" as ItemId;
const T7 = "01M5ESZPWMZZM3TZ88P6FVVK34" as ItemId;
const SPEC = "01M5ESR42S7P9YNR8FEH0TD2QC" as ItemId;
const items: ReadonlyArray<ReachedItem> = [
  { kind: "task", nodeId: asNodeId("T"), itemId: T42, name: "Import", number: taskNumber(42)! },
  { kind: "task", nodeId: asNodeId("T"), itemId: T7, name: "Export", number: taskNumber(7)! },
  { kind: "artifact", nodeId: asNodeId("A"), itemId: SPEC, name: "Spec" },
];
const href = (node: string, item: string) => `junto://canvas/factory?node=${node}&item=${item}`;
const resolve = (kind: "task" | "artifact", ref: string) =>
  resolveResourceRef(board, "factory", S, { kind, ref, caption: "Look" }, items);

describe("a signal's task and artifact refs, resolved in reach", () => {
  it("makes #42, an id and a ref the canonical link, keeping the caption", () => {
    expect(resolve("task", " #42 ")).toEqual(Result.succeed({ kind: "task", ref: href("T", T42), caption: "Look" }));
    expect(resolve("task", "7")).toEqual(Result.succeed({ kind: "task", ref: href("T", T7), caption: "Look" }));
    expect(resolve("task", T42)).toEqual(Result.succeed({ kind: "task", ref: href("T", T42), caption: "Look" }));
    expect(resolve("artifact", SPEC)).toEqual(Result.succeed({ kind: "artifact", ref: href("A", SPEC), caption: "Look" }));
    expect(resolve("artifact", href("A", SPEC))).toEqual(
      Result.succeed({ kind: "artifact", ref: href("A", SPEC), caption: "Look" }),
    );
  });

  it("refuses a number or an id nothing in reach has, listing what it reaches", () => {
    const missing = resolve("task", "#9");
    expect(Result.isFailure(missing) && missing.failure).toMatchObject({
      type: "UnknownTarget",
      details: { candidates: [{ itemId: T42, number: 42 }, { itemId: T7, number: 7 }] },
    });
    expect(Result.isFailure(missing) && missing.failure.message).toContain("#42 Import");
    // An artifact id is not a task id.
    expect(Result.isFailure(resolve("task", SPEC)) && resolve("task", SPEC)).toMatchObject({
      failure: { type: "UnknownTarget" },
    });
  });

  it("refuses a node where an item is wanted, with the items on it", () => {
    const node = resolve("task", "T");
    expect(Result.isFailure(node) && node.failure).toMatchObject({
      type: "InputError",
      details: { candidates: [{ itemId: T42 }, { itemId: T7 }] },
    });
  });

  it("passes a ref out of reach on, for admission to refuse by reach", () => {
    const far = resolve("task", href("TX", T42));
    expect(far).toEqual(Result.succeed({ kind: "task", ref: href("TX", T42), caption: "Look" }));
    if (Result.isSuccess(far)) {
      const resources = { canvas: board, holds: holdsOf(items) };
      expect(admitResourceAttachment(far.success, S, resources)).toEqual({
        ok: false,
        reason: "TX is out of this seat's reach",
      });
    }
  });

  it("holds exactly the items read, each on its own node", () => {
    const holds = holdsOf(items);
    expect(holds("task", asNodeId("T"), T42)).toBe(true);
    expect(holds("artifact", asNodeId("A"), SPEC)).toBe(true);
    expect(holds("task", asNodeId("A"), T42)).toBe(false);
    expect(holds("artifact", asNodeId("A"), T42)).toBe(false);
  });

  it("admits what it resolved", () => {
    const resolved = resolve("task", "#42");
    expect(Result.isSuccess(resolved)).toBe(true);
    if (Result.isSuccess(resolved)) {
      expect(admitResourceAttachment(resolved.success, S, { canvas: board, holds: holdsOf(items) })).toEqual({
        ok: true,
        attachment: { kind: "task", nodeId: "T", taskId: T42, caption: "Look" },
      });
    }
  });
});
