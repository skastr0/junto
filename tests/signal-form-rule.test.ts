/**
 * What a signal's raise asks the operator to produce, resolved in the seat's
 * reach (0.11/07, N1). The raise names an Artifacts node; only a node the
 * asking seat reaches may hold the document, and the title, labels and word
 * condition are settled here, once, so the store and the feed read the same
 * form.
 */
import { Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ vault: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get VAULT_ENABLED() { return flags.vault; },
}));

import { resolveSignalForm, signalKindTakesForm } from "../src/main/junto/signals/form-rule";
import { artifacts, canvasOf, region, seat, taskBoard } from "./support/model-nodes";
import { resourcesSeatReaches } from "../src/shared/region-reach";
import type { NodeId } from "../src/shared/physics/schema";
import { THIS_MACHINE } from "./support/machines";

const SEAT = "agent" as NodeId;

/** A seat inside a region that holds it and two Artifacts shelves, one out of reach. */
const board = canvasOf(
  [
    seat("agent", { x: 0, y: 0, width: 100, height: 40 }),
    region("region", { x: -20, y: -20, width: 620, height: 120 }, {
      label: "Forge",
      instruction: "ship",
      environment: { sources: [{ id: "cf", kind: "secret", name: "CLOUDFLARE_TOKEN", secretId: "secret-cf" }] },
    }),
    artifacts("shelf", { x: 0, y: 0, width: 100, height: 40, label: "Shelf" }),
    artifacts("shelf-two", { x: 120, y: 0, width: 100, height: 40, label: "Shelf Two" }),
    region("elsewhere", { x: 800, y: -20, width: 240, height: 160 }, { label: "Elsewhere", instruction: "other work" }),
    artifacts("far-shelf", { x: 820, y: 0, width: 100, height: 40, label: "Far" }),
    taskBoard("board", { x: 0, y: 40, width: 100, height: 40 }),
  ],
  [],
);

const resolve = (request: Parameters<typeof resolveSignalForm>[0]["request"], text = "Write the post.") =>
  resolveSignalForm({
    board,
    reaches: resourcesSeatReaches(board, SEAT).map((node) => node.id),
    text,
    request,
    raiser: SEAT,
  });

const failure = (result: ReturnType<typeof resolve>) => {
  if (Result.isSuccess(result)) throw new Error("expected a refusal");
  return result.failure;
};

describe("the reply form a raise asks for", () => {
  afterEach(() => {
    flags.vault = true;
  });

  it("text and proof need nothing", () => {
    expect(resolve({ kind: "text" })).toEqual(Result.succeed({ kind: "text" }));
    expect(resolve({ kind: "proof" })).toEqual(Result.succeed({ kind: "proof" }));
  });

  it("a document names its shelf by name, id or ref, in the seat's reach", () => {
    const byName = resolve({ kind: "artifact", node: "Shelf Two" });
    const stored = Result.isSuccess(byName) ? byName.success : undefined;
    expect(stored).toMatchObject({ kind: "artifact", nodeId: "shelf-two", title: "Write the post.", labels: [], minWords: 1 });
    expect(Result.isSuccess(resolve({ kind: "artifact", node: "shelf" }))).toBe(true);
    expect(Result.isSuccess(resolve({ kind: "artifact", node: "junto://canvas/factory?node=shelf" }))).toBe(true);
  });

  it("settles the title, the labels and the word condition once", () => {
    const result = resolve({ kind: "artifact", node: "shelf", title: "Morning pages", labels: ["Daily", "daily", "writing"], minWords: 500 });
    expect(result).toEqual(
      Result.succeed({
        kind: "artifact",
        nodeId: "shelf",
        title: "Morning pages",
        labels: ["daily", "writing"],
        minWords: 500,
      }),
    );
    // The signal's own sentence is the title when the raise named none, cut to a title's length.
    const long = resolve({ kind: "artifact", node: "shelf" }, "w".repeat(400));
    expect(Result.isSuccess(long) && long.success.kind === "artifact" && long.success.title.length).toBe(200);
  });

  it("refuses a shelf the seat cannot reach, a node that is not one, and a name two share", () => {
    const far = failure(resolve({ kind: "artifact", node: "Far" }));
    expect(far.type).toBe("UnknownTarget");
    expect(far.message).toContain("Shelf");
    const task = failure(resolve({ kind: "artifact", node: "board" }));
    expect(task.type).toBe("InputError");
    expect(task.details?.path).toBe("args.form.node");
  });

  it("refuses a label that breaks the label rule, at its index", () => {
    const refused = failure(resolve({ kind: "artifact", node: "shelf", labels: ["fine", "not a label!"] }));
    expect(refused.type).toBe("InputError");
    expect(refused.details?.path).toBe("args.form.labels[1]");
    expect(refused.message).toContain("is not a label");
  });

  it("settles a secret in the region that declares it for the asker's machine, or says which it lacks", () => {
    // The forge region declares CLOUDFLARE_TOKEN; the seat's machine reads it there.
    expect(resolve({ kind: "secret", name: "CLOUDFLARE_TOKEN" })).toEqual(
      Result.succeed({ kind: "secret", name: "CLOUDFLARE_TOKEN", regionId: "region", machine: THIS_MACHINE }),
    );
    const refused = failure(resolve({ kind: "secret", name: "STRIPE_KEY" }));
    expect(refused.type).toBe("InputError");
    expect(refused.details?.reason).toBe("not_declared");
    expect(refused.message).toContain("STRIPE_KEY");
    expect(refused.message).toContain(THIS_MACHINE);
  });

  it("with VAULT_ENABLED off, refuses the secret form as not available, even for a declared secret", () => {
    flags.vault = false;
    const refused = failure(resolve({ kind: "secret", name: "CLOUDFLARE_TOKEN" }));
    expect(refused.type).toBe("InvalidTransition");
    expect(refused.details?.reason).toBe("not_available");
    expect(refused.details?.next_step).toContain("CLOUDFLARE_TOKEN");
  });

  it("only a kind that asks the operator to produce something carries one", () => {
    expect(signalKindTakesForm("blocked")).toBe(true);
    expect(signalKindTakesForm("escalate")).toBe(true);
    expect(signalKindTakesForm("work")).toBe(true);
    expect(signalKindTakesForm("feedback")).toBe(false);
    expect(signalKindTakesForm("notice")).toBe(false);
  });
});
