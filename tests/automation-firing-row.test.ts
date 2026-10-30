/**
 * The `automation.firing` exchange row (0.11, 05 S3): one revision carries
 * the whole Firing and states its claim's canvas count, its item id is its
 * firing and rev, and the row's own fields must agree with the firing it
 * revises. The exchange's closed list admits it at the automation's node and
 * nothing else.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AutomationFiringResult, automationFiringItemId } from "../src/shared/automation-firing-row";
import { ExchangeFact } from "../src/shared/work-exchange";
import { AutomationId, Firing, FiringId } from "../src/shared/automation";
import { AutomationNodeId } from "../src/shared/mail-author";
import { asNodeId } from "../src/shared/physics/schema";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";

const automationId = Schema.decodeUnknownSync(AutomationId)("01M62AAAAAAAAAAAAAAAAAAAAA");
const firingId = Schema.decodeUnknownSync(FiringId)("01M62BBBBBBBBBBBBBBBBBBBBB");
const automationNode = Schema.decodeUnknownSync(AutomationNodeId)("routines");

const firing: Firing = {
  firingId,
  automationId,
  at: 1_000,
  cause: { kind: "schedule", slot: 60_000, missed: 0 },
  outcome: { kind: "fired", actions: [{ index: 0, ruling: "applied" }] },
  machine: "mini",
  claimSeq: 42,
};

const body: AutomationFiringResult = {
  operation: "automation.firing",
  automationNode,
  automationId,
  firingId,
  claimSeq: 42,
  rev: 0,
  firing,
};

const decodeResult = Schema.decodeUnknownSync(AutomationFiringResult);
const decodeFact = Schema.decodeUnknownSync(ExchangeFact, { onExcessProperty: "error" });
const crosses = (row: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(ExchangeFact, { onExcessProperty: "error" })(row));

const fact = (over: Record<string, unknown> = {}) => ({
  protocol: WORK_PROTOCOL,
  id: {
    route: { eventHome: "mini-installation", entityHome: "mini-installation" },
    seq: "1",
  },
  recordType: "fact",
  basis: { kind: "canvas", canvasName: "factory", seq: 43 },
  item: {
    kind: "automation-firing",
    itemId: automationFiringItemId(body),
    sink: { canvasName: "factory", nodeId: automationNode },
  },
  operation: "automation.firing",
  predecessor: null,
  contentSha256: "a".repeat(64),
  originAt: "2026-10-30T00:00:00.000Z",
  body: { ...body, ...over },
});

describe("automation.firing row", () => {
  it("a revision names its firing by id: rev 0 is the claim's first state worth showing", () => {
    expect(decodeResult(body)).toEqual(body);
    expect(automationFiringItemId(body)).toBe(`automation-firing:${firingId}:0`);
    expect(automationFiringItemId({ ...body, rev: 1 })).toBe(`automation-firing:${firingId}:1`);
  });

  it("refuses a body whose firing disagrees with the row's own ids", () => {
    const otherFiring = Schema.decodeUnknownSync(FiringId)("01M62CCCCCCCCCCCCCCCCCCCCC");
    expect(() => decodeResult({ ...body, firing: { ...firing, firingId: otherFiring } })).toThrow();
    expect(() => decodeResult({ ...body, firing: { ...firing, automationId: id2 } })).toThrow();
  });

  it("is on the closed list at the automation's node", () => {
    expect(crosses(fact())).toBe(true);
    expect(crosses(fact({ operation: "seat.control" }))).toBe(false);
  });

  it("refuses a sink that is not the automation's node and a mismatched item id", () => {
    expect(
      crosses({
        ...fact(),
        item: {
          kind: "automation-firing",
          itemId: automationFiringItemId(body),
          sink: { canvasName: "factory", nodeId: asNodeId("elsewhere") },
        },
      }),
    ).toBe(false);
    expect(
      crosses({
        ...fact(),
        item: {
          kind: "automation-firing",
          itemId: "automation-firing:wrong:0",
          sink: { canvasName: "factory", nodeId: automationNode },
        },
      }),
    ).toBe(false);
  });
});

const id2 = Schema.decodeUnknownSync(AutomationId)("01M62DDDDDDDDDDDDDDDDDDDDD");
