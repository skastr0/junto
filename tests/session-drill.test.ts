import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { explodeSessionsInto, type ExplodeSession } from "../src/shared/explode";
import { parseSessionKey, sessionKey } from "../src/shared/refs";

const sessions: ReadonlyArray<ExplodeSession> = [
  {
    sessionId: "kimi:7887d11d0a29c9c28f017377e8ceae14",
    provider: "kimi",
    title: undefined,
    messageCount: 40,
  },
  {
    sessionId: "codex:222c0dd3771430f49b7dead9da385392",
    provider: "codex",
    title: "Disclosure review",
    messageCount: 623,
  },
  {
    sessionId: "claude:abc123",
    provider: "claude",
    title: undefined,
    messageCount: 7,
  },
];

describe("explodeSessionsInto", () => {
  it("produces a valid JSON Canvas document", () => {
    const doc = explodeSessionsInto({ nodes: [], edges: [] }, "prism", sessions);
    expect(Either.isRight(decodeCanvasDoc(doc))).toBe(true);
  });

  it("creates exactly one group node for the project", () => {
    const doc = explodeSessionsInto({ nodes: [], edges: [] }, "prism", sessions);
    const groups = doc.nodes.filter((n) => n.type === "group");
    expect(groups.map((g) => g.id)).toEqual(["ses-grp-prism"]);
    expect(groups[0] && "label" in groups[0] ? groups[0].label : undefined).toBe("prism · sessions");
  });

  it("creates one text node per session", () => {
    const doc = explodeSessionsInto({ nodes: [], edges: [] }, "prism", sessions);
    const textNodes = doc.nodes.filter((n) => n.type === "text");
    expect(textNodes.length).toBe(sessions.length);
  });

  it("binds each session node with a key equal to sessionKey(sessionId)", () => {
    const doc = explodeSessionsInto({ nodes: [], edges: [] }, "prism", sessions);
    for (const session of sessions) {
      const node = doc.nodes.find((n) =>
        n.ether?.bindings?.some(
          (b) => b.source === "quasar" && b.ref.type === "session" && b.ref.key === sessionKey(session.sessionId),
        ),
      );
      expect(node, `expected a node bound to ${session.sessionId}`).toBeDefined();
      expect(node?.type).toBe("text");
      expect(node?.ether?.entity?.kind).toBe("session");
    }
  });

  it("renders text as provider · title, falling back to '<n> msgs' when title is absent", () => {
    const doc = explodeSessionsInto({ nodes: [], edges: [] }, "prism", sessions);
    const withTitle = doc.nodes.find((n) => n.id === "ses-codex-222c0dd3771430f49b7dead9da385392");
    expect(withTitle && "text" in withTitle ? withTitle.text : undefined).toBe("codex · Disclosure review");

    const withoutTitle = doc.nodes.find((n) => n.id === "ses-claude-abc123");
    expect(withoutTitle && "text" in withoutTitle ? withoutTitle.text : undefined).toBe("claude · 7 msgs");
  });

  it("truncates a long title to ~36 chars in the node text", () => {
    const longTitle = "A".repeat(80);
    const doc = explodeSessionsInto(
      { nodes: [], edges: [] },
      "prism",
      [{ sessionId: "kimi:999", provider: "kimi", title: longTitle, messageCount: 1 }],
    );
    const node = doc.nodes.find((n) => n.id === "ses-kimi-999");
    expect(node?.type).toBe("text");
    expect(node && "text" in node ? node.text.length : 0).toBeLessThan(60);
  });

  it("preserves all existing nodes and edges", () => {
    const existing: CanvasDoc = {
      nodes: [{ id: "n1", type: "text", text: "keep me", x: 0, y: 0, width: 100, height: 40 }],
      edges: [],
    };
    const doc = explodeSessionsInto(existing, "prism", sessions);
    expect(doc.nodes.find((n) => n.id === "n1")).toBeDefined();
  });

  it("is idempotent: running twice adds no new nodes", () => {
    const first = explodeSessionsInto({ nodes: [], edges: [] }, "prism", sessions);
    const again = explodeSessionsInto(first, "prism", sessions);
    expect(again.nodes.length).toBe(first.nodes.length);
    expect(again.nodes.map((n) => n.id).sort()).toEqual(first.nodes.map((n) => n.id).sort());
  });

  it("adds nothing for an empty session list", () => {
    const doc = explodeSessionsInto({ nodes: [], edges: [] }, "prism", []);
    expect(doc.nodes.length).toBe(0);
  });
});

describe("session ref key round-trip", () => {
  it("parseSessionKey(sessionKey(x)) recovers the original session id", () => {
    const id = "kimi:7887d11d0a29c9c28f017377e8ceae14";
    expect(parseSessionKey(sessionKey(id))).toBe(id);
  });

  it("round-trips a session id that itself contains a colon", () => {
    const id = "codex:222c0dd3771430f49b7dead9da385392";
    expect(parseSessionKey(sessionKey(id))).toBe(id);
  });

  it("parseSessionKey rejects a non-session key", () => {
    expect(parseSessionKey("glyph:prism/forge/WFE-010")).toBeUndefined();
    expect(parseSessionKey("prism")).toBeUndefined();
  });
});
