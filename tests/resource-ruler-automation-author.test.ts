/**
 * An automation's command arriving from its own machine is ruled with its
 * author's reach as the ruling machine holds the definition (0.11/05 S2),
 * never from anything the row says: the live automation of that id on that
 * node. Another node, an archived automation or an unknown id has no author,
 * so it reaches nothing.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AutomationRepository } from "../src/main/junto/automation/repository";
import { automationAuthorsOf } from "../src/main/junto/work/resource-ruler";
import type { AutomationEntry } from "../src/shared/automation-domain";
import { asNodeId } from "../src/shared/model";
import type { NodeKind } from "../src/shared/model/kinds";
import type { ReachCanvas, ReachNode } from "../src/shared/region-reach";
import { rulingContextOf } from "../src/shared/ruling-context";
import { ItemId } from "../src/shared/work-ids";

const node = (id: string, kind: NodeKind, x: number, y: number, width = 50, height = 50): ReachNode => ({
  id: asNodeId(id),
  kind,
  x,
  y,
  width,
  height,
});

// A holds task TA and the Automations node AU; A1 inside A holds seat S1 and task T1; A2, its sibling inside A, holds T2.
const canvas: ReachCanvas = {
  nodes: new Map(
    [
      node("A", "region", 0, 0, 1000, 1000),
      node("A1", "region", 10, 10, 400, 400),
      node("TA", "task", 700, 600),
      node("AU", "automations", 800, 600),
      node("S1", "agent", 20, 20),
      node("T1", "task", 100, 20),
      node("A2", "region", 450, 10, 300, 300),
      node("T2", "task", 500, 20),
    ].map((n) => [n.id, n]),
  ),
};

const BY_OPERATOR = ItemId.make("01M629AAAAAAAAAAAAAAAAAAAA");
const BY_S1 = ItemId.make("01M629BBBBBBBBBBBBBBBBBBBB");
const ARCHIVED = ItemId.make("01M629CCCCCCCCCCCCCCCCCCCC");

const entry = (automationId: ItemId, author: AutomationEntry["automation"]["author"], archived = false): AutomationEntry =>
  ({ automation: { automationId, nodeId: asNodeId("AU"), author }, archived, updatedAt: 0 }) as unknown as AutomationEntry;

const store = {
  loadState: () =>
    Effect.succeed(
      new Map([
        [BY_OPERATOR, entry(BY_OPERATOR, { kind: "operator" })],
        [BY_S1, entry(BY_S1, { kind: "seat", seat: asNodeId("S1") })],
        [ARCHIVED, entry(ARCHIVED, { kind: "operator" }, true)],
      ]),
    ),
} as unknown as AutomationRepository["Service"];

const reaches = async (automationId: ItemId, nodeId: string, target: string): Promise<boolean> => {
  const command = {
    opId: "01M629DDDDDDDDDDDDDDDDDDD1",
    canvasName: "factory",
    actor: { kind: "automation", nodeId, automationId },
    target: { kind: "task", nodeId: target },
    basis: null,
    after: [],
    op: { kind: "start" },
  } as never;
  const author = await Effect.runPromise(automationAuthorsOf(store)("factory", command));
  return rulingContextOf(canvas, author).inReach({ kind: "automation", nodeId: asNodeId(nodeId), automationId }, { kind: "task", nodeId: asNodeId(target) });
};

describe("an automation's command at the ruler", () => {
  it("reaches what its stored author reaches", async () => {
    expect(await reaches(BY_OPERATOR, "AU", "TA")).toBe(true);
    expect(await reaches(BY_OPERATOR, "AU", "T1")).toBe(true);
    expect(await reaches(BY_OPERATOR, "AU", "T2")).toBe(true);
    // Authored by S1 in A1: narrowed to what S1 reaches, never A1's sibling A2.
    expect(await reaches(BY_S1, "AU", "T1")).toBe(true);
    expect(await reaches(BY_S1, "AU", "T2")).toBe(false);
  });

  it("reaches nothing from another node, archived, or unknown", async () => {
    expect(await reaches(BY_OPERATOR, "TA", "TA")).toBe(false);
    expect(await reaches(ARCHIVED, "AU", "TA")).toBe(false);
    expect(await reaches(ItemId.make("01M629EEEEEEEEEEEEEEEEEEEE"), "AU", "TA")).toBe(false);
  });
});
