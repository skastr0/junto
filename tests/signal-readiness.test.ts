import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AGENT_SIGNAL_MAX_DEPENDS_ON,
  AgentSignal,
  signalReadiness,
  type AgentSignal as AgentSignalT,
  type AgentSignalState,
} from "../src/shared/agent-signals";

const signal = (over: Partial<AgentSignalT>): AgentSignalT => ({
  signalId: "s1",
  canvasName: "portfolio",
  nodeId: "a",
  kind: "feedback",
  text: "ready for review",
  createdAt: 1,
  state: "open",
  ...over,
});

const states = (entries: Record<string, AgentSignalState>) => (id: string) => entries[id];

const ULID = (n: number) => `01M8S${String(n).padStart(21, "0")}`;

describe("AgentSignal thread and order fields", () => {
  const decode = Schema.decodeUnknownSync(AgentSignal);

  it("reads a signal written before them with none of them", () => {
    const old = decode(signal({}));
    expect(old.threadId).toBeUndefined();
    expect(old.messageId).toBeUndefined();
    expect(old.followsSignalId).toBeUndefined();
    expect(old.dependsOn).toBeUndefined();
  });

  it("carries the thread, its message, what it follows and what it comes after", () => {
    const raised = decode(
      signal({ threadId: ULID(1), messageId: ULID(2), followsSignalId: ULID(3), dependsOn: [ULID(3), ULID(4)] }),
    );
    expect(raised).toMatchObject({ threadId: ULID(1), messageId: ULID(2), followsSignalId: ULID(3) });
    expect(raised.dependsOn).toEqual([ULID(3), ULID(4)]);
  });

  it("takes only ULIDs for every id it names", () => {
    expect(() => decode(signal({ threadId: "t1" }))).toThrow();
    expect(() => decode(signal({ messageId: "m1" }))).toThrow();
    expect(() => decode(signal({ followsSignalId: ULID(1).toLowerCase() }))).toThrow();
    expect(() => decode(signal({ dependsOn: [ULID(1), "s2"] }))).toThrow();
  });

  it(`comes after at most ${AGENT_SIGNAL_MAX_DEPENDS_ON} signals`, () => {
    const ids = Array.from({ length: AGENT_SIGNAL_MAX_DEPENDS_ON + 1 }, (_, n) => ULID(n));
    expect(decode(signal({ dependsOn: ids.slice(0, AGENT_SIGNAL_MAX_DEPENDS_ON) })).dependsOn).toHaveLength(8);
    expect(() => decode(signal({ dependsOn: ids }))).toThrow();
  });
});

describe("signalReadiness", () => {
  it("is ready when it comes after nothing, as every old signal does", () => {
    expect(signalReadiness(signal({}), states({}))).toEqual({ ready: true, waitingOn: [], notReceived: [] });
    expect(signalReadiness(signal({ dependsOn: [] }), states({}))).toEqual({ ready: true, waitingOn: [], notReceived: [] });
  });

  it("waits on what is still open, in the order named", () => {
    const read = signalReadiness(
      signal({ dependsOn: ["c", "a", "b"] }),
      states({ a: "open", b: "answered", c: "open" }),
    );
    expect(read).toEqual({ ready: false, waitingOn: ["c", "a"], notReceived: [] });
  });

  it("is ready once every one is closed, however it closed", () => {
    const read = signalReadiness(
      signal({ dependsOn: ["a", "b", "c"] }),
      states({ a: "answered", b: "dismissed", c: "withdrawn" }),
    );
    expect(read).toEqual({ ready: true, waitingOn: [], notReceived: [] });
  });

  it("is not held back by an id it cannot find, and names it as not received", () => {
    expect(signalReadiness(signal({ dependsOn: ["gone"] }), states({}))).toEqual({
      ready: true,
      waitingOn: [],
      notReceived: ["gone"],
    });
  });

  it("names what it waits on and what it has not received apart, each in order, once", () => {
    const read = signalReadiness(
      signal({ dependsOn: ["x", "a", "y", "b", "x", "a"] }),
      states({ a: "open", b: "answered" }),
    );
    expect(read).toEqual({ ready: false, waitingOn: ["a"], notReceived: ["x", "y"] });
  });

  it("names a signal it waits on once", () => {
    expect(signalReadiness(signal({ dependsOn: ["a", "a"] }), states({ a: "open" })).waitingOn).toEqual(["a"]);
  });

  it("makes the next of a batch ready as each one closes", () => {
    const batch = ["s1", "s2", "s3"].map((signalId, index, ids) =>
      signal({ signalId, dependsOn: index === 0 ? undefined : [ids[index - 1]!] }),
    );
    const held: Record<string, AgentSignalState> = { s1: "open", s2: "open", s3: "open" };
    const ready = () => batch.filter((s) => signalReadiness(s, states(held)).ready).map((s) => s.signalId);
    expect(ready()).toEqual(["s1"]);
    held.s1 = "answered";
    expect(ready()).toEqual(["s1", "s2"]);
    held.s2 = "dismissed";
    expect(ready()).toEqual(["s1", "s2", "s3"]);
  });
});
