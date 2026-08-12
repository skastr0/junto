import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import type { CanvasDoc, TextNode } from "../src/shared/canvas";
import type { Message } from "../src/shared/work-model";
import {
  mailAgeLabel,
  mailboxCounts,
  mailboxRows,
  unreadMailByPeer,
} from "../src/renderer/lib/actor-ledger";

const T0 = 1_700_000_000_000;

const agent = (
  id: string,
  label: string,
  messages?: ReadonlyArray<Message>,
): TextNode => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `local:${id}`, harness: "codex" },
    ...(messages ? { messages: { items: [...messages] } } : {}),
  },
});

const docOf = (nodes: readonly TextNode[]): CanvasDoc => ({
  nodes: [...nodes],
  edges: [],
});

const mail = (
  atMs: number,
  overrides: Partial<Message> & { readonly text?: string } = {},
): Message => {
  const { text, ...rest } = overrides;
  return {
    messageId: ulid(atMs),
    role: "user",
    parts: [{ kind: "text", text: text ?? "hello" }],
    ...rest,
  };
};

describe("mailboxRows", () => {
  it("orders newest first by ULID birth time", () => {
    const older = mail(T0, { text: "older" });
    const newer = mail(T0 + 60_000, { text: "newer" });
    const doc = docOf([agent("hub", "Hub", [older, newer])]);
    const rows = mailboxRows(doc, doc.nodes[0]!);
    expect(rows.map((r) => r.preview)).toEqual(["newer", "older"]);
    expect(rows[0]!.sentAtMs).toBe(T0 + 60_000);
  });

  it("resolves the sender label from the doc, falls back to the raw id, then system", () => {
    const fromPeer = mail(T0, { metadata: { fromSeat: "bravo" } });
    const fromGone = mail(T0 + 1000, { metadata: { fromSeat: "ghost" } });
    const fromNobody = mail(T0 + 2000, {});
    const doc = docOf([
      agent("hub", "Hub", [fromPeer, fromGone, fromNobody]),
      agent("bravo", "Bravo peer"),
    ]);
    const rows = mailboxRows(doc, doc.nodes[0]!);
    expect(rows.map((r) => r.fromLabel)).toEqual(["system", "ghost", "Bravo peer"]);
    expect(rows[2]!.fromNodeId).toBe("bravo");
  });

  it("strips the factory mail prefix and previews the first line only", () => {
    const wrapped = mail(T0, {
      text: "[factory mail from bravo] line one\nline two",
      metadata: { fromSeat: "bravo" },
    });
    const doc = docOf([agent("hub", "Hub", [wrapped])]);
    const row = mailboxRows(doc, doc.nodes[0]!)[0]!;
    expect(row.preview).toBe("line one");
    expect(row.body).toBe("line one\nline two");
  });

  it("maps delivery receipts and roles", () => {
    const queued = mail(T0, {});
    const deliveredUnread = mail(T0 + 1000, { metadata: { deliveredAt: T0 + 2000 } });
    const read = mail(T0 + 2000, {
      metadata: { deliveredAt: T0 + 3000, readAt: T0 + 4000 },
    });
    const note = mail(T0 + 3000, { role: "agent" });
    const doc = docOf([agent("hub", "Hub", [queued, deliveredUnread, read, note])]);
    const rows = mailboxRows(doc, doc.nodes[0]!);
    const byId = new Map(rows.map((r) => [r.messageId, r] as const));
    expect(byId.get(queued.messageId)).toMatchObject({
      direction: "in",
      delivered: false,
      read: false,
    });
    expect(byId.get(deliveredUnread.messageId)).toMatchObject({
      delivered: true,
      read: false,
    });
    expect(byId.get(read.messageId)).toMatchObject({ delivered: true, read: true });
    expect(byId.get(note.messageId)).toMatchObject({ direction: "note" });
  });

  it("is empty for a node without a mailbox", () => {
    const doc = docOf([agent("hub", "Hub")]);
    expect(mailboxRows(doc, doc.nodes[0]!)).toEqual([]);
  });

  it("survives non-ULID message ids (no birth time, sinks to the end)", () => {
    const odd: Message = {
      messageId: "not-a-ulid",
      role: "user",
      parts: [{ kind: "text", text: "odd" }],
    };
    const fresh = mail(T0, { text: "fresh" });
    const doc = docOf([agent("hub", "Hub", [odd, fresh])]);
    const rows = mailboxRows(doc, doc.nodes[0]!);
    expect(rows.map((r) => r.preview)).toEqual(["fresh", "odd"]);
    expect(rows[1]!.sentAtMs).toBeUndefined();
  });
});

describe("mailboxCounts", () => {
  it("counts queued and unread over inbound mail only", () => {
    const queued = mail(T0, {});
    const deliveredUnread = mail(T0 + 1000, { metadata: { deliveredAt: T0 + 2000 } });
    const read = mail(T0 + 2000, {
      metadata: { deliveredAt: T0 + 3000, readAt: T0 + 4000 },
    });
    const note = mail(T0 + 3000, { role: "agent" });
    const doc = docOf([agent("hub", "Hub", [queued, deliveredUnread, read, note])]);
    const counts = mailboxCounts(mailboxRows(doc, doc.nodes[0]!));
    expect(counts).toEqual({ total: 4, queued: 1, unread: 2 });
  });
});

describe("mailAgeLabel", () => {
  it("formats each magnitude and clamps the future to now", () => {
    expect(mailAgeLabel(T0, undefined)).toBeUndefined();
    expect(mailAgeLabel(T0 + 5_000, T0)).toBe("now");
    expect(mailAgeLabel(T0 + 45_000, T0)).toBe("45s");
    expect(mailAgeLabel(T0 + 12 * 60_000, T0)).toBe("12m");
    expect(mailAgeLabel(T0 + 3 * 3_600_000, T0)).toBe("3h");
    expect(mailAgeLabel(T0 + 5 * 86_400_000, T0)).toBe("5d");
    expect(mailAgeLabel(T0, T0 + 60_000)).toBe("now");
  });
});

describe("unreadMailByPeer", () => {
  it("counts inbound unread per sender, skipping read mail, notes, and system", () => {
    const fromBravoUnread = mail(T0, { metadata: { fromSeat: "bravo" } });
    const fromBravoUnread2 = mail(T0 + 1000, { metadata: { fromSeat: "bravo" } });
    const fromBravoRead = mail(T0 + 2000, {
      metadata: { fromSeat: "bravo", deliveredAt: T0 + 3000, readAt: T0 + 4000 },
    });
    const fromCharlie = mail(T0 + 3000, { metadata: { fromSeat: "charlie" } });
    const system = mail(T0 + 4000, {});
    const note = mail(T0 + 5000, { role: "agent", metadata: { fromSeat: "bravo" } });
    const doc = docOf([
      agent("hub", "Hub", [
        fromBravoUnread,
        fromBravoUnread2,
        fromBravoRead,
        fromCharlie,
        system,
        note,
      ]),
    ]);
    const counts = unreadMailByPeer(mailboxRows(doc, doc.nodes[0]!));
    expect(counts.get("bravo")).toBe(2);
    expect(counts.get("charlie")).toBe(1);
    expect(counts.size).toBe(2);
  });
});
