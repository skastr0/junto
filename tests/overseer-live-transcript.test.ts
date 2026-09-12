import { describe, expect, it } from "vitest";
import {
  appendTranscript,
  captureLiveDelegation,
  createTranscriptJournal,
  decodeLiveDelegationEvent,
  decodeLiveTranscriptEvent,
  LIVE_TRANSCRIPT_LIMITS,
  type LiveTranscriptFragment,
} from "../src/main/vellum-command/overseer/live/transcript";

const input = (eventId: string, text: string, startMs = 0, endMs = startMs + 10): LiveTranscriptFragment =>
  ({ eventId, role: "user", text, startMs, endMs });
const delegation = (offsetMs = 100, id = "delegation-1") => ({
  eventId: `event-${id}`, delegationId: id, offsetMs,
});

describe("Live transcript evidence and delegation", () => {
  it("decodes the documented delta and client-delegation wire shapes without a task field", () => {
    expect(decodeLiveTranscriptEvent({
      type: "session.input_transcript.delta", event_id: "input-1", delta: "Move this", start_ms: 10, end_ms: 50,
    })).toEqual(input("input-1", "Move this", 10, 50));
    expect(decodeLiveTranscriptEvent({
      type: "session.output_transcript.delta", event_id: "output-1", delta: "I can help", start_ms: 40, end_ms: 80,
    })?.role).toBe("assistant");
    expect(decodeLiveDelegationEvent({
      type: "session.delegation.created", event_id: "delegation-event", offset_ms: 80,
      delegation: { id: "opaque/id:01", type: "delegation", target: "client" },
      task: "Untrusted invented task must be ignored",
    })).toEqual({ eventId: "delegation-event", delegationId: "opaque/id:01", offsetMs: 80 });
    expect(decodeLiveDelegationEvent({ type: "session.delegation.created", task: "Move this" })).toBeNull();
  });

  it("refuses malformed provider intervals and unsupported delegation targets", () => {
    const delta = { type: "session.input_transcript.delta", event_id: "event-1", delta: "hello", start_ms: 0, end_ms: 1 };
    for (const changes of [{ start_ms: -1 }, { end_ms: NaN }, { start_ms: 2 }, { event_id: "" }, { delta: 4 }]) {
      expect(decodeLiveTranscriptEvent({ ...delta, ...changes })).toBeNull();
    }
    expect(decodeLiveDelegationEvent({
      type: "session.delegation.created", event_id: "event-1", offset_ms: 10,
      delegation: { id: "id", type: "delegation", target: "responses" },
    })).toBeNull();
  });

  it("journals speech without issuing requests, and deduplicates sideband/client delivery", () => {
    const initial = createTranscriptJournal();
    const added = appendTranscript(initial, input("input-1", "Create a task"));
    expect(added).not.toHaveProperty("request");
    expect(initial.fragments).toHaveLength(0);
    expect(added.journal.fragments).toHaveLength(1);
    const duplicate = appendTranscript(added.journal, input("input-1", "Create a second task"));
    expect(duplicate).toEqual({ journal: added.journal, accepted: false, reason: "duplicate" });
    expect(duplicate.journal).toBe(added.journal);
  });

  it("captures prior operator text and a correction, excluding assistant speech and future input", () => {
    let journal = createTranscriptJournal();
    for (const fragment of [
      input("first", "Create a task for the API agent. ", 0, 20),
      { ...input("answer", "I created it.", 20, 30), role: "assistant" as const },
      input("correction", "Actually, use the research agent.", 30, 60),
      input("future", " Then erase everything.", 150, 200),
    ]) journal = appendTranscript(journal, fragment).journal;
    const captured = captureLiveDelegation(journal, delegation(), { selectedNodeIds: ["api-agent"] });
    expect(captured.request?.requestText).toBe("Create a task for the API agent. Actually, use the research agent.");
    expect(captured.request?.transcriptRefs.map((fragment) => fragment.eventId)).toEqual(["first", "correction"]);
    expect(captured.request?.delegationId).toBe("delegation-1");
  });

  it("freezes selection at capture despite operator selection changes during backend work", () => {
    const attention = { selectedNodeIds: ["first"], draft: { text: "unsaved" } };
    const journal = appendTranscript(createTranscriptJournal(), input("speech", "Move this")).journal;
    const captured = captureLiveDelegation(journal, delegation(), attention);
    attention.selectedNodeIds[0] = "second";
    attention.draft.text = "changed";
    expect(captured.request?.context).toEqual({ selectedNodeIds: ["first"], draft: { text: "unsaved" } });
    expect(Object.isFrozen(captured.request?.context.selectedNodeIds)).toBe(true);
    expect(Object.isFrozen(captured.request?.transcriptRefs)).toBe(true);
  });

  it("keeps a duplicate delegation inert even when its provider event id differs", () => {
    const journal = appendTranscript(createTranscriptJournal(), input("speech", "Move this")).journal;
    const first = captureLiveDelegation(journal, delegation(), {});
    expect(captureLiveDelegation(first.journal, delegation(), {}).reason).toBe("duplicate");
    expect(captureLiveDelegation(first.journal, { ...delegation(), eventId: "reconnected-event" }, {}).reason).toBe("duplicate");
    expect(captureLiveDelegation(first.journal, delegation(100, "new-delegation"), {}).reason).toBe("empty");
  });

  it("preserves earlier referents but separately identifies new correction evidence", () => {
    const journal = appendTranscript(createTranscriptJournal(), input("original", "Use the API agent. ")).journal;
    const first = captureLiveDelegation(journal, delegation(20), {});
    const corrected = appendTranscript(first.journal, input("correction", "Actually, the research agent.", 30, 40)).journal;
    const second = captureLiveDelegation(corrected, delegation(50, "second"), {});
    expect(second.request?.requestText).toBe("Use the API agent. Actually, the research agent.");
    expect(second.request?.newTranscriptRefs.map((fragment) => fragment.eventId)).toEqual(["correction"]);
    expect(second.request?.previousDelegationOffsetMs).toBe(20);
  });

  it("retains overlap and late-arriving fragments without inventing word timing", () => {
    let journal = appendTranscript(createTranscriptJournal(), input("overlap-a", "Move ", 0, 50)).journal;
    journal = appendTranscript(journal, input("overlap-b", "this", 25, 75)).journal;
    const first = captureLiveDelegation(journal, delegation(40), {});
    expect(first.request?.requestText).toBe("Move this");
    // This older interval arrived after the first delegation. A stale provider
    // delegation must not consume it and hide it from the next current one.
    journal = appendTranscript(first.journal, input("late", "carefully ", 10, 20)).journal;
    const stale = captureLiveDelegation(journal, delegation(30, "stale"), {});
    expect(stale.reason).toBe("stale");
    const next = captureLiveDelegation(stale.journal, delegation(80, "current"), {});
    expect(next.request?.newTranscriptRefs.map((fragment) => fragment.eventId)).toEqual(["late"]);
  });

  it("bounds the transcript window without forgetting replay identities", () => {
    let journal = createTranscriptJournal();
    for (let index = 0; index < LIVE_TRANSCRIPT_LIMITS.fragments + 10; index++) {
      journal = appendTranscript(journal, input(`event-${index}`, "x", index, index + 1)).journal;
    }
    expect(journal.fragments).toHaveLength(LIVE_TRANSCRIPT_LIMITS.fragments);
    expect(journal.historyTruncated).toBe(true);
    expect(appendTranscript(journal, input("event-0", "old request")).reason).toBe("duplicate");
    const oversize = appendTranscript(journal, input("oversize", "界".repeat(LIVE_TRANSCRIPT_LIMITS.fragmentBytes)));
    expect(oversize.reason).toBe("invalid");
  });

  it("fails closed at the session identity budget instead of allowing a replay", () => {
    const full = { ...createTranscriptJournal(), seenEventIds: Array.from({ length: LIVE_TRANSCRIPT_LIMITS.eventIds }, (_, i) => `event-${i}`) };
    expect(appendTranscript(full, input("new", "do work")).reason).toBe("capacity");
    expect(captureLiveDelegation(full, delegation(), {}).reason).toBe("capacity");
    expect(appendTranscript(full, input("event-0", "do work again")).reason).toBe("duplicate");
  });
});
