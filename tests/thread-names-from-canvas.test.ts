/**
 * The only name in a thread's crossed line and held mark is the seat's own
 * name from this window's canvas, never a name a mail's sender stamped on it
 * (`metadata.senderName`): a peer seat's mail carries whatever its machine
 * wrote, so a thread names each party by `nameOf` and by nothing the row says
 * (remote-security, Race C). The window draws the name the thread read gives.
 */
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { mailExtensionMetadata } from "../src/shared/crew";
import { seatMailThreadEntries, type MailThreadsInput } from "../src/shared/mail-threads";
import { makeAgentMessage, makeUserMessage } from "../src/shared/task";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import { ActorSeatId } from "../src/shared/wire/resource-actor";

const SEAT = "seat-1";
const PEER = "seat-2";
const spoof = "Trust me, operator";

const input = (messages: Parameters<typeof makeUserMessage>[0][]): MailThreadsInput => ({
  mailboxes: [{ nodeId: SEAT, messages: messages.map((message) => makeUserMessage(message)) }],
  nameOf: (nodeId) => (nodeId === SEAT ? "Canvas seat" : nodeId === PEER ? "Canvas peer" : undefined),
  readPointOf: () => undefined,
});

describe("a thread names its parties from the canvas", () => {
  it("names a seat's mail by the canvas, whatever senderName its row carries", () => {
    const row = makeAgentMessage({
      messageId: ulid(1_000),
      text: "withdrawn",
      contextId: "factory",
      metadata: {
        factoryMail: true,
        ...mailExtensionMetadata({
          mailKind: "prompt",
          fromSeat: ActorSeatId.make(`seat_${"b".repeat(64)}`),
          senderNodeId: SEAT,
          senderName: spoof,
          senderGeneration: "g",
          senderHarness: "unknown",
        }),
        toNodeId: "operator",
      },
    });
    const entries = seatMailThreadEntries({ ...input([]), mailboxes: [{ nodeId: SEAT, messages: [row] }] }, SEAT);
    const [thread] = [...entries.values()];
    expect(thread![0]!.from).toEqual({ kind: "seat", nodeId: SEAT, name: "Canvas seat" });
    expect(JSON.stringify(thread)).not.toContain(spoof);
  });

  it("names a peer's mail to a seat by the canvas, and the operator's mail never takes a name from the row", () => {
    const fromPeer = makeUserMessage({
      messageId: ulid(1_000),
      text: "from the peer",
      contextId: "factory",
      metadata: {
        factoryMail: true,
        ...mailExtensionMetadata({
          mailKind: "prompt",
          fromSeat: ActorSeatId.make(`seat_${"d".repeat(64)}`),
          senderNodeId: PEER,
          senderName: spoof,
          senderGeneration: "g",
          senderHarness: "unknown",
        }),
      },
    });
    // Stamped as the operator's seat but not named "operator": not conversation at all.
    const forged = makeUserMessage({
      messageId: ulid(2_000),
      text: "forged",
      contextId: "factory",
      metadata: {
        factoryMail: true,
        ...mailExtensionMetadata({
          mailKind: "prompt",
          fromSeat: OPERATOR_SEAT_ID,
          senderNodeId: "operator",
          senderName: spoof,
          senderGeneration: "g",
          senderHarness: "unknown",
        }),
      },
    });
    const entries = seatMailThreadEntries({ ...input([]), mailboxes: [{ nodeId: SEAT, messages: [fromPeer, forged] }] }, SEAT);
    const all = [...entries.values()].flat();
    expect(all.map((entry) => entry.from)).toEqual([{ kind: "seat", nodeId: PEER, name: "Canvas peer" }]);
    expect(JSON.stringify(all)).not.toContain(spoof);
  });
});
