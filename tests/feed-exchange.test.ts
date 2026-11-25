/**
 * The exchange a signal that follows another tells in the pane
 * (src/window/lib/feed-exchange.ts): earlier signals and the operator's
 * answers between them, oldest first, ending at this signal; folded past four.
 */
import { describe, expect, it } from "vitest";
import { buildOperatorFeed } from "../src/shared/operator-feed";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import { exchangeRows, exchangeShown, type ExchangeRow } from "../src/window/lib/feed-exchange";
import type { SeatThreadMessage } from "../src/window/lib/seat-threads";

const REGION = { regionId: "r", label: "R", path: ["R"] };
const feedItem = (signal: AgentSignal) =>
  buildOperatorFeed({
    canvasName: "c",
    nowMs: 10_000,
    seats: [{ seat: { nodeId: "seat-a", name: "atlas", portraitIdentity: "a" }, region: REGION }],
    signals: [signal],
  }).sections[0]!.items[0]!;

const current: AgentSignal = {
  signalId: "S3",
  canvasName: "c",
  nodeId: "seat-a",
  kind: "blocked",
  text: "Third",
  createdAt: 9_000,
  state: "open",
  threadId: "T1",
  followsSignalId: "S2",
};
const signalMessage = (signalId: string, text: string, at: number, state: "answered" | "dismissed" | "withdrawn", crossed = false): SeatThreadMessage => ({
  messageId: `m-${signalId}`,
  author: "atlas",
  mine: false,
  text,
  at,
  signal: { signalId, kind: "escalate", state, text, ...(crossed ? { crossed: true as const } : {}) },
});
const answerMessage = (text: string, at: number): SeatThreadMessage => ({
  messageId: `a-${String(at)}`,
  author: "you",
  mine: true,
  text,
  at,
  answers: { signalId: "S1", kind: "escalate", text: "x" },
});

describe("a signal's exchange", () => {
  it("runs oldest first from the head, an answer between, and ends at this signal", () => {
    const rows = exchangeRows(
      feedItem(current),
      [answerMessage("Go on\nand more", 2), signalMessage("S2", "Second", 3, "dismissed"), signalMessage("S3", "Third", 9, "answered"), signalMessage("S4", "After", 10, "answered")],
      { signalId: "S1", kind: "escalate", state: "answered", text: "First", at: 1 },
    );
    expect(rows.map((row) => (row.kind === "answer" ? `you:${row.text}` : `${row.signalId}${row.current ? "*" : ""}:${row.state}`))).toEqual([
      "S1:answered",
      "you:Go on",
      "S2:dismissed",
      "S3*:open",
    ]);
  });

  it("carries the crossed mark of a withdrawn signal", () => {
    const rows = exchangeRows(feedItem(current), [signalMessage("S2", "Second", 3, "withdrawn", true)], undefined);
    expect(rows[0]).toMatchObject({ signalId: "S2", state: "withdrawn", crossed: true });
  });

  it("folds past four earlier rows to the last three, with how many are behind Show all", () => {
    const rows: ExchangeRow[] = Array.from({ length: 8 }, (_, n) => ({ kind: "answer", text: String(n), at: n }));
    const shown = exchangeShown(rows, false);
    expect(shown.rows.map((row) => (row as { text: string }).text)).toEqual(["4", "5", "6", "7"]);
    expect(shown).toMatchObject({ hidden: 4, total: 7 });
    expect(exchangeShown(rows, true).hidden).toBe(0);
    expect(exchangeShown(rows.slice(0, 5), false).hidden).toBe(0);
  });
});
