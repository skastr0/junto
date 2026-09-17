/**
 * Seat collaboration — who a seat should ask, what it asks, and what came
 * back.
 *
 * The binding contract these tests hold:
 *   - one message store: the request IS ordinary crew mail, and the return
 *     path is the reply link crew mail already stamps (`metadata.inReplyTo`)
 *   - honest ranking: a peer is described only by facts visible in the
 *     projection (connected, control state, its own screen, its recent mail),
 *     never by an inferred expertise
 *   - reachable only: no self-asks, no seat without a binding, no gone or
 *     unknown seat, no second ask to a peer that has not answered
 *   - deterministic: the same fleet always ranks the same way
 *   - the wire refuses a malformed ask whole rather than defaulting a field
 */

import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import {
  collaborationRequestMetadata,
  collaborationThreads,
  collaborationThreadsForSource,
  composeCollaborationRequestText,
  normalizeSeatCollaborationAsk,
  SEAT_COLLABORATION_EVIDENCE_MAX,
  SEAT_COLLABORATION_QUESTION_MAX,
  type SeatCollaborationDraft,
} from "../src/shared/seat-collaboration";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { SeatAwarenessAssessment } from "../src/renderer/lib/seat-awareness-contract";
import {
  askSeatPeer,
  awaitingPeerNodeIds,
  closeSeatCollaboration,
  collaborationDraft,
  collaborationEvidence,
  collaborationFleet,
  collaborationPeerSuggestions,
  collaborationQuestion,
  collaborationThreadLine,
  mergeCollaborationThreads,
  openSeatCollaboration,
  rememberSeatCollaboration,
  seatCollaborationSent$,
  seatCollaborationUi$,
  type CollaborationSeatFacts,
} from "../src/renderer/lib/seat-collaboration";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const agentNode = (input: {
  readonly id: string;
  readonly bindingId: string;
  readonly label: string;
  readonly messages?: ReadonlyArray<unknown>;
}): CanvasNode =>
  ({
    id: input.id,
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    text: input.label,
    ether: {
      entity: { kind: "agent" },
      terminal: { bindingId: input.bindingId },
      ...(input.messages === undefined ? {} : { messages: input.messages }),
    },
  }) as unknown as CanvasNode;

const noteNode = (id: string): CanvasNode =>
  ({ id, type: "text", x: 0, y: 0, width: 100, height: 80, text: "note" }) as unknown as CanvasNode;

const seatEvent = (
  bindingId: string,
  state: AgentSeatStateEvent["state"],
): AgentSeatStateEvent => ({
  bindingId,
  epoch: "e1",
  state,
  reason: "test",
  confidence: "high",
  at: 1,
});

const assessment = (input: {
  readonly bindingId: string;
  readonly activity?: SeatAwarenessAssessment["activity"];
  readonly concerns?: ReadonlyArray<string>;
  readonly lines?: ReadonlyArray<string>;
  readonly availability?: SeatAwarenessAssessment["availability"];
}): SeatAwarenessAssessment =>
  ({
    bindingId: input.bindingId,
    assessmentId: `a:${input.bindingId}`,
    availability: input.availability ?? "current",
    observedAt: 1_000,
    activity: input.activity ?? null,
    concerns: (input.concerns ?? []) as SeatAwarenessAssessment["concerns"],
    absences: [],
    unansweredConcerns: [],
    evidence: {
      digest: "d1",
      capturedAt: 1_000,
      lines: (input.lines ?? []).map((text, index) => ({ id: `l${index}`, text })),
    },
    selectedLineId: null,
    unavailableReason: null,
  }) as unknown as SeatAwarenessAssessment;

const fleetOf = (
  doc: CanvasDoc,
  seats: Readonly<Record<string, AgentSeatStateEvent | undefined>>,
  awareness: Readonly<Record<string, SeatAwarenessAssessment | undefined>> = {},
): readonly CollaborationSeatFacts[] =>
  collaborationFleet({ doc, seatByBindingId: seats, awarenessByBindingId: awareness });

const draft = (over: Partial<SeatCollaborationDraft> = {}): SeatCollaborationDraft => ({
  canvas: "main",
  sourceNodeId: "builder",
  sourceLabel: "Builder",
  targetNodeId: "iris",
  targetLabel: "Iris",
  question: "Have you worked on the retry contract?",
  why: "connected and idle",
  evidence: ["status: working"],
  ...over,
});

// ---------------------------------------------------------------------------
// The request on the wire
// ---------------------------------------------------------------------------

describe("seat collaboration request", () => {
  it("carries the question, the reason, the evidence and the reply command", () => {
    const text = composeCollaborationRequestText(draft(), "01REQ");
    expect(text).toContain("[collaboration request from Builder]");
    expect(text).toContain("Have you worked on the retry contract?");
    expect(text).toContain("Why you: connected and idle");
    expect(text).toContain("Builder screen:");
    expect(text).toContain("  status: working");
    // The return path is stated where the question is, not assumed.
    expect(text).toContain('"target":"builder"');
    expect(text).toContain('"inReplyTo":"01REQ"');
    expect(text).toContain("junto msg reply");
  });

  it("stamps the request identity and the reply destination on the message", () => {
    const metadata = collaborationRequestMetadata(draft(), "01REQ");
    expect(metadata.juntoCollaborationRequestId).toBe("01REQ");
    expect(metadata.juntoCollaborationSourceNodeId).toBe("builder");
    expect(metadata.juntoCollaborationQuestion).toBe(
      "Have you worked on the retry contract?",
    );
    // Factory mail: the peer's PTY gets a notify line, the body stays in the
    // mailbox. A multi-line request never derails a seat mid-turn.
    expect(metadata.factoryMail).toBe(true);
  });

  it("refuses a malformed ask whole instead of defaulting a field", () => {
    expect(normalizeSeatCollaborationAsk(null).ok).toBe(false);
    expect(normalizeSeatCollaborationAsk(draft({ canvas: "  " })).ok).toBe(false);
    expect(normalizeSeatCollaborationAsk(draft({ question: "" })).ok).toBe(false);
    expect(
      normalizeSeatCollaborationAsk(draft({ sourceNodeId: "iris" })).ok,
    ).toBe(false);
    expect(
      normalizeSeatCollaborationAsk(
        draft({ question: "x".repeat(SEAT_COLLABORATION_QUESTION_MAX + 1) }),
      ).ok,
    ).toBe(false);
    const normalized = normalizeSeatCollaborationAsk({
      ...draft(),
      evidence: ["  a  ", "", "b", "c", "d", "e"],
      why: "  idle  ",
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.draft.why).toBe("idle");
    expect(normalized.draft.evidence).toEqual(["a", "b", "c", "d"]);
    expect(normalized.draft.evidence.length).toBe(SEAT_COLLABORATION_EVIDENCE_MAX);
  });
});

// ---------------------------------------------------------------------------
// The return path
// ---------------------------------------------------------------------------

describe("collaboration threads", () => {
  const request = (requestId: string, sourceNodeId: string) => ({
    messageId: requestId,
    role: "user" as const,
    parts: [{ kind: "text" as const, text: "please help" }],
    contextId: "main",
    metadata: collaborationRequestMetadata(
      draft({ sourceNodeId, sourceLabel: sourceNodeId }),
      requestId,
    ),
  });

  const reply = (messageId: string, inReplyTo: string, text: string) => ({
    messageId,
    role: "user" as const,
    parts: [{ kind: "text" as const, text }],
    contextId: "main",
    metadata: { inReplyTo, factoryMail: true },
  });

  it("reads the request from the peer mailbox and the reply from the asking seat", () => {
    const doc: CanvasDoc = {
      nodes: [
        agentNode({
          id: "iris",
          bindingId: "b-iris",
          label: "Iris",
          messages: [request("01REQ0000000000000000000000", "builder")],
        }),
        agentNode({
          id: "builder",
          bindingId: "b-builder",
          label: "Builder",
          messages: [reply("01REP0000000000000000000000", "01REQ0000000000000000000000", "retries keep the id")],
        }),
      ],
      edges: [],
    };
    const threads = collaborationThreads(doc);
    expect(threads).toHaveLength(1);
    const [thread] = threads;
    expect(thread?.requestId).toBe("01REQ0000000000000000000000");
    expect(thread?.targetNodeId).toBe("iris");
    expect(thread?.sourceNodeId).toBe("builder");
    expect(thread?.status).toBe("answered");
    expect(thread?.reply?.text).toBe("retries keep the id");
    expect(collaborationThreadLine(thread!)).toBe("answered by Iris");
    expect(collaborationThreadsForSource(threads, "builder")).toHaveLength(1);
    expect(collaborationThreadsForSource(threads, "iris")).toHaveLength(0);
    expect(awaitingPeerNodeIds(threads, "builder")).toEqual([]);
  });

  it("holds a thread open until the reply actually lands", () => {
    const doc: CanvasDoc = {
      nodes: [
        agentNode({
          id: "iris",
          bindingId: "b-iris",
          label: "Iris",
          messages: [request("01REQ0000000000000000000000", "builder")],
        }),
        agentNode({ id: "builder", bindingId: "b-builder", label: "Builder" }),
      ],
      edges: [],
    };
    const threads = collaborationThreads(doc);
    expect(threads[0]?.status).toBe("asked");
    expect(threads[0]?.reply).toBeUndefined();
    expect(collaborationThreadLine(threads[0]!)).toBe("waiting for a reply (Iris)");
    expect(awaitingPeerNodeIds(threads, "builder")).toEqual(["iris"]);
  });

  it("ignores mail that is not a collaboration request", () => {
    const doc: CanvasDoc = {
      nodes: [
        agentNode({
          id: "iris",
          bindingId: "b-iris",
          label: "Iris",
          messages: [
            { messageId: "01X", role: "user", parts: [{ kind: "text", text: "hi" }] },
            reply("01REP0000000000000000000000", "01MISSING000000000000000000", "orphan"),
          ],
        }),
        noteNode("note-1"),
      ],
      edges: [],
    };
    expect(collaborationThreads(doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The fleet and the ranking
// ---------------------------------------------------------------------------

describe("collaboration fleet", () => {
  it("sees only agent seats with a binding, labelled as the card labels them", () => {
    const doc: CanvasDoc = {
      nodes: [
        agentNode({ id: "builder", bindingId: "b-builder", label: "Builder\nsecond line" }),
        agentNode({ id: "iris", bindingId: "b-iris", label: "Iris" }),
        noteNode("note-1"),
        {
          id: "unbound",
          type: "text",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: "Unbound",
          ether: { entity: { kind: "agent" } },
        } as unknown as CanvasNode,
      ],
      edges: [],
    };
    const fleet = fleetOf(doc, {
      "b-builder": seatEvent("b-builder", "working"),
      "b-iris": seatEvent("b-iris", "idle"),
    });
    expect(fleet.map((seat) => seat.nodeId)).toEqual(["builder", "iris", "unbound"]);
    expect(fleet[0]?.label).toBe("Builder");
    expect(fleet[0]?.state).toBe("working");
    expect(fleet[1]?.state).toBe("idle");
    expect(fleet[2]?.bindingId).toBeUndefined();
    expect(fleet[2]?.state).toBe("unknown");
  });

  it("carries the awareness judgment and the recent mailbox text", () => {
    const doc: CanvasDoc = {
      nodes: [
        agentNode({
          id: "iris",
          bindingId: "b-iris",
          label: "Iris",
          messages: [
            { messageId: "01M1", role: "user", parts: [{ kind: "text", text: "shipped the retry contract fix" }] },
          ],
        }),
      ],
      edges: [],
    };
    const fleet = fleetOf(
      doc,
      { "b-iris": seatEvent("b-iris", "idle") },
      {
        "b-iris": assessment({
          bindingId: "b-iris",
          activity: "editing",
          concerns: ["execution_error"],
          lines: ["retry identity mismatch on line 42"],
        }),
      },
    );
    expect(fleet[0]?.activity).toBe("editing");
    expect(fleet[0]?.concerns).toEqual(["execution_error"]);
    expect(fleet[0]?.excerpt).toContain("retry identity mismatch");
    expect(fleet[0]?.mail[0]).toContain("shipped the retry contract fix");
  });
});

describe("collaboration peer suggestions", () => {
  const source = (over: Partial<CollaborationSeatFacts> = {}): CollaborationSeatFacts => ({
    nodeId: "builder",
    bindingId: "b-builder",
    label: "Builder",
    state: "working",
    detail: "turn in progress",
    activity: "editing",
    concerns: ["execution_error"],
    availability: "current",
    excerpt: "retry contract identity mismatch",
    mail: [],
    ...over,
  });

  const peer = (over: Partial<CollaborationSeatFacts> = {}): CollaborationSeatFacts => ({
    nodeId: "iris",
    bindingId: "b-iris",
    label: "Iris",
    state: "idle",
    detail: undefined,
    activity: null,
    concerns: [],
    availability: "not_assessed",
    excerpt: null,
    mail: [],
    ...over,
  });

  it("ranks a peer that shares the asking seat's topic above an unrelated one", () => {
    const peers = collaborationPeerSuggestions({
      source: source(),
      fleet: [
        source(),
        peer({ nodeId: "muse", label: "Muse", mail: ["unrelated gardening notes"] }),
        peer({
          nodeId: "iris",
          label: "Iris",
          mail: ["the retry contract identity is stable now"],
        }),
      ],
    });
    expect(peers[0]?.label).toBe("Iris");
    expect(peers[0]?.basis).toBe("fleet");
    // The shared topic is named from the peer's own mail, not inferred.
    expect(peers[0]?.why).toContain("its recent mail mentions");
  });

  it("marks the awareness basis only when the peer's own screen carries the topic", () => {
    const peers = collaborationPeerSuggestions({
      source: source(),
      fleet: [
        source(),
        peer({
          nodeId: "iris",
          label: "Iris",
          availability: "current",
          activity: "editing",
          excerpt: "patching the retry contract identity check",
        }),
      ],
    });
    expect(peers[0]?.basis).toBe("awareness");
    expect(peers[0]?.why).toContain("Likely editing");
    expect(peers[0]?.why).toContain("its own screen mentions");
  });

  it("keeps an idle peer as an honest fallback when nothing overlaps", () => {
    const peers = collaborationPeerSuggestions({
      source: source(),
      fleet: [source(), peer({ mail: ["completely different subject"] })],
    });
    expect(peers).toHaveLength(1);
    expect(peers[0]?.why).toBe("connected and idle");
  });

  it("never offers itself, an unbound seat, a gone seat, or a seat already asked", () => {
    const peers = collaborationPeerSuggestions({
      source: source(),
      fleet: [
        source(),
        peer({ nodeId: "self-alias", label: "Self", bindingId: "b-builder" }),
        peer({ nodeId: "unbound", bindingId: undefined }),
        peer({ nodeId: "gone", label: "Gone", state: "gone" }),
        peer({ nodeId: "unknown", label: "Unknown", state: "unknown" }),
        peer({ nodeId: "asked", label: "Asked" }),
        peer({ nodeId: "free", label: "Free" }),
      ],
      awaitingNodeIds: ["asked"],
    });
    // Self is excluded by node id, not by binding, so the alias survives; the
    // rest of the unreachable shapes do not. A seat with no live turn is still
    // askable: crew mail queues and wakes it.
    expect(peers.map((entry) => entry.nodeId).sort()).toEqual([
      "free",
      "self-alias",
      "unknown",
    ]);
    const unknownPeer = peers.find((entry) => entry.nodeId === "unknown");
    expect(unknownPeer?.why).toBe("connected, no live turn");
  });

  it("is deterministic and bounded", () => {
    const fleet = [source()];
    for (let index = 0; index < 6; index += 1) {
      fleet.push(peer({ nodeId: `p${index}`, label: `Peer ${index}` }));
    }
    const first = collaborationPeerSuggestions({ source: source(), fleet });
    const second = collaborationPeerSuggestions({ source: source(), fleet });
    expect(first.map((entry) => entry.nodeId)).toEqual(second.map((entry) => entry.nodeId));
    expect(first).toHaveLength(3);
    // Equal scores fall back to the label, so the order is stable.
    expect(first.map((entry) => entry.label)).toEqual(["Peer 0", "Peer 1", "Peer 2"]);
  });
});

describe("collaboration question and evidence", () => {
  const facts = (over: Partial<CollaborationSeatFacts> = {}): CollaborationSeatFacts => ({
    nodeId: "builder",
    bindingId: "b-builder",
    label: "Builder",
    state: "attention",
    detail: "stalled",
    activity: "editing",
    concerns: [],
    availability: "current",
    excerpt: "access denied for the deploy key",
    mail: [],
    ...over,
  });

  it("asks the question the leading concern implies", () => {
    expect(collaborationQuestion(facts({ concerns: ["access_problem"] }))).toContain(
      "access problem",
    );
    expect(collaborationQuestion(facts({ concerns: ["execution_error"] }))).toContain(
      "Have you hit this failure",
    );
    expect(collaborationQuestion(facts({ concerns: ["repetition"] }))).toContain(
      "again and again",
    );
    expect(
      collaborationQuestion(facts({ concerns: ["answer_requested", "access_problem"] })),
    ).toContain("access problem");
    expect(collaborationQuestion(facts({ concerns: [] }))).toContain("Have you worked on");
    expect(
      collaborationQuestion(facts({ concerns: [], excerpt: null, detail: undefined })),
    ).toContain("current screen");
  });

  it("quotes only the asking seat's own screen, bounded", () => {
    expect(collaborationEvidence(facts())).toEqual([
      "status: stalled",
      "activity: Likely editing",
      "access denied for the deploy key",
    ]);
    const long = collaborationEvidence(facts({ excerpt: "x".repeat(400) }));
    expect(long[long.length - 1]?.length).toBe(200);
  });

  it("composes the draft the bridge sends", () => {
    const composed = collaborationDraft({
      canvas: "main",
      source: facts(),
      peer: {
        nodeId: "iris",
        label: "Iris",
        why: "connected and idle",
        question: "Have you worked on \"deploy\"? What did you find?",
        basis: "fleet",
        score: 2,
      },
    });
    expect(composed.canvas).toBe("main");
    expect(composed.targetNodeId).toBe("iris");
    expect(composed.sourceLabel).toBe("Builder");
    expect(composed.evidence).toContain("status: stalled");
  });
});

// ---------------------------------------------------------------------------
// Renderer state: the open slot, the sent window, and the bridge
// ---------------------------------------------------------------------------

describe("collaboration renderer state", () => {
  it("keeps the overlay open across a document rebuild and closes only its own card", () => {
    openSeatCollaboration("builder");
    expect(seatCollaborationUi$.openNodeId.peek()).toBe("builder");
    // A rebuilt card re-reads the same slot: the ask survives the write.
    expect(seatCollaborationUi$.openNodeId.peek()).toBe("builder");
    // A card that never held the slot cannot close it.
    closeSeatCollaboration("iris");
    expect(seatCollaborationUi$.openNodeId.peek()).toBe("builder");
    closeSeatCollaboration("builder");
    expect(seatCollaborationUi$.openNodeId.peek()).toBe("");
  });

  it("shows a request as an open thread before the projection catches up, and never twice", () => {
    rememberSeatCollaboration("01REQ", draft());
    const sent = seatCollaborationSent$.byRequestId.peek();
    expect(sent["01REQ"]?.status).toBe("asked");
    expect(sent["01REQ"]?.targetLabel).toBe("Iris");

    // The mailbox is authority: once the document carries the thread, the
    // local copy is not shown beside it.
    const fromDocument = collaborationThreads({
      nodes: [
        agentNode({
          id: "iris",
          bindingId: "b-iris",
          label: "Iris",
          messages: [
            {
              messageId: "01REQ",
              role: "user",
              parts: [{ kind: "text", text: "please help" }],
              contextId: "main",
              metadata: collaborationRequestMetadata(draft(), "01REQ"),
            },
          ],
        }),
      ],
    });
    const merged = mergeCollaborationThreads(fromDocument, sent);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.targetNodeId).toBe("iris");
  });

  it("reports a missing bridge as a refusal rather than throwing", async () => {
    const result = await askSeatPeer(draft());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("collaboration is unavailable in this build");
  });

  it("refuses a malformed draft before it reaches the bridge", async () => {
    const result = await askSeatPeer(draft({ question: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("question is required");
  });
});
