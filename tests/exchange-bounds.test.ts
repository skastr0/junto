/**
 * A page of rows always fits one link frame: cut by count and by bytes, with
 * one row at most 64 KiB when a machine writes it.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LINK_EVENT_WINDOW } from "../src/main/junto/link/protocol";
import {
  EXCHANGE_ROWS_ENVELOPE_BYTES,
  EXCHANGE_ROWS_PAGE_BYTES,
  LINK_FRAME_MAX_BYTES,
  assertWorkRowBound,
  pageExchangeRows,
  workRowBytes,
} from "../src/shared/exchange-bounds";
import { InstallationId } from "../src/shared/installation-id";
import { COMMAND_ROW_MAX_BYTES } from "../src/shared/resource-command";
import { EXCHANGE_MAX_FACTS_PER_FRAME, ExchangeFact, encodeExchangeFrame, type RowsFrame } from "../src/shared/work-exchange";
import { WORK_PROTOCOL, WORK_PROTOCOL_MAX_RECORD_BYTES } from "../src/shared/work-protocol";

const decodeFact = Schema.decodeUnknownSync(ExchangeFact);
const seat = `seat_${"1".repeat(64)}`;

const mail = (seq: number, text: string): ExchangeFact =>
  decodeFact({
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: "macbook", entityHome: "macbook" }, seq: String(seq) },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "factory", seq: 7 },
    item: { kind: "message", itemId: `mail-${seq}`, sink: { canvasName: "factory", nodeId: "peer" } },
    operation: "message.append",
    contentSha256: "a".repeat(64),
    originAt: "2026-10-21T12:00:00.000Z",
    predecessor: null,
    body: {
      operation: "message.append",
      message: { messageId: `mail-${seq}`, role: "agent", parts: [{ kind: "text", text }] },
      sentBy: { seatId: seat, canvasName: "factory", nodeId: "lead" },
      destination: { kind: "mailbox" },
    },
  });

/** A mail of exactly `bytes` as it crosses. */
const mailOf = (seq: number, bytes: number): ExchangeFact => mail(seq, "x".repeat(bytes - workRowBytes(mail(seq, ""))));

/** The frame at its longest: every name at its bound, every character escaped as JSON escapes it most. */
const widest = {
  canvasName: "\u0000".repeat(256),
  canvasId: "\u0001".repeat(128),
  writer: Schema.decodeUnknownSync(InstallationId)("m".repeat(128)),
  through: "9".repeat(32),
};

/** A rows frame's bytes as the link writes it: the event around the encoded frame. */
const linkBytes = (facts: ReadonlyArray<ExchangeFact>): number => {
  const frame: RowsFrame = { kind: "rows", ...widest, facts };
  return Buffer.byteLength(JSON.stringify({ type: "event", channel: "rows", payload: encodeExchangeFrame(frame) }));
};

/** Page every row the way exchangeRows does, from the start. */
const pages = (facts: ReadonlyArray<ExchangeFact>): ExchangeFact[][] => {
  const out: ExchangeFact[][] = [];
  let rest = facts.map((fact) => ({ seq: fact.id.seq, fact }));
  for (;;) {
    const page = pageExchangeRows(rest, { count: EXCHANGE_MAX_FACTS_PER_FRAME, bytes: EXCHANGE_ROWS_PAGE_BYTES });
    out.push([...page.taken]);
    if (page.cutAt === undefined) return out;
    rest = rest.slice(rest.findIndex((row) => row.seq === page.cutAt) + 1);
  }
};

describe("a page of rows and the link frame", () => {
  it("measures against the link's own frame bound", () => {
    expect(LINK_FRAME_MAX_BYTES).toBe(LINK_EVENT_WINDOW - 1);
    expect(EXCHANGE_ROWS_PAGE_BYTES + EXCHANGE_ROWS_ENVELOPE_BYTES).toBe(LINK_FRAME_MAX_BYTES);
  });

  it("leaves room for the widest envelope", () => {
    expect(linkBytes([])).toBeLessThan(EXCHANGE_ROWS_ENVELOPE_BYTES);
  });

  it("counts a row as the bytes it crosses with", () => {
    const fact = mailOf(1, 10_000);
    expect(workRowBytes(fact)).toBe(10_000);
    expect(linkBytes([fact, fact]) - linkBytes([])).toBe(2 * 10_000 + 1);
  });

  it("never exceeds the frame with a page of rows at the cap", () => {
    const facts = Array.from({ length: EXCHANGE_MAX_FACTS_PER_FRAME }, (_, index) => mailOf(index + 1, COMMAND_ROW_MAX_BYTES));
    const split = pages(facts);
    expect(split.length).toBeGreaterThan(1);
    for (const page of split) expect(linkBytes(page)).toBeLessThanOrEqual(LINK_FRAME_MAX_BYTES);
    expect(split.flat().map((fact) => fact.id.seq)).toEqual(facts.map((fact) => fact.id.seq));
    // Fifteen rows at the cap fill a page; the sixteenth goes in the next.
    expect(split[0]).toHaveLength(Math.floor(EXCHANGE_ROWS_PAGE_BYTES / (COMMAND_ROW_MAX_BYTES + 1)));
  });

  it("carries a row written before the cap, at the record bound, in a frame", () => {
    const facts = Array.from({ length: 9 }, (_, index) => mailOf(index + 1, WORK_PROTOCOL_MAX_RECORD_BYTES - 64));
    const split = pages(facts);
    for (const page of split) {
      expect(page.length).toBeGreaterThan(0);
      expect(linkBytes(page)).toBeLessThanOrEqual(LINK_FRAME_MAX_BYTES);
    }
    expect(split.flat()).toHaveLength(9);
  });

  it("still stops at the count for small rows", () => {
    const facts = Array.from({ length: 100 }, (_, index) => mail(index + 1, "hello"));
    const page = pageExchangeRows(facts.map((fact) => ({ seq: fact.id.seq, fact })), { count: 64, bytes: EXCHANGE_ROWS_PAGE_BYTES });
    expect(page.taken).toHaveLength(64);
    expect(page.cutAt).toBe("64");
  });

  it("reads past rows that do not cross, and ends a page on the last row it read", () => {
    const big = mailOf(2, COMMAND_ROW_MAX_BYTES);
    const rows = [{ seq: "1", fact: undefined }, { seq: "2", fact: big }, { seq: "3", fact: undefined }, { seq: "4", fact: mailOf(4, COMMAND_ROW_MAX_BYTES) }];
    expect(pageExchangeRows(rows, { count: 64, bytes: COMMAND_ROW_MAX_BYTES + 1 })).toEqual({ taken: [big], cutAt: "3" });
    expect(pageExchangeRows(rows.slice(0, 3), { count: 64, bytes: COMMAND_ROW_MAX_BYTES + 1 })).toEqual({ taken: [big] });
  });
});

describe("one row at write time", () => {
  it("takes a row at the cap and refuses one byte over, saying both sizes", () => {
    expect(assertWorkRowBound(mailOf(1, COMMAND_ROW_MAX_BYTES))).toBeUndefined();
    expect(assertWorkRowBound(mailOf(1, COMMAND_ROW_MAX_BYTES + 1))).toMatchObject({
      _tag: "WorkRowTooLarge",
      bytes: COMMAND_ROW_MAX_BYTES + 1,
      limit: COMMAND_ROW_MAX_BYTES,
    });
  });
});
