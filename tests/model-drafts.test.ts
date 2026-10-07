import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { Node, NodeDraft, SEAT_FIELDS_MAIN_WORKS_OUT, Wire, WireDraft } from "../src/shared/model";

// A draft is the model's node or wire with only what main decides left out.

const decodes = (schema: Schema.Top, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema as never)(input, { onExcessProperty: "error" }));

const at = { x: 0, y: 0, width: 200, height: 100 };
/** A seat as asked for: the harness, and nothing main works out. */
const seat = { kind: "agent", ...at, harness: "claude" };
/** The same seat as the model holds it once main has worked it out. */
const seated = {
  ...seat, agentKey: "local:claude", label: "Builder", host: "local", onRemove: "detach",
  overseer: false, bindingId: "seat-1",
};

describe("a node draft", () => {
  it("is every model kind without an id or a place in the stack", () => {
    const drafts: ReadonlyArray<Record<string, unknown>> = [
      seat,
      { kind: "terminal", ...at, host: "local", bindingId: "term-1", onRemove: "detach" },
      { kind: "page", ...at, host: "local", url: "https://example.com", profile: "default", onRemove: "kill-session" },
      { kind: "task", ...at },
      { kind: "requests", ...at },
      { kind: "artifacts", ...at },
      { kind: "board", ...at },
      { kind: "pad", ...at },
      { kind: "sheet", ...at },
      { kind: "cron", ...at, host: "local", expression: "0 9 * * 1" },
      { kind: "relay", ...at, host: "local" },
      { kind: "watcher", ...at, host: "local" },
      { kind: "note", ...at, text: "hello" },
      { kind: "label", ...at, text: "hello" },
      { kind: "file", ...at, path: "/tmp/a.md" },
      { kind: "link", ...at, url: "https://example.com" },
      { kind: "git", ...at, cwd: "/tmp/repo" },
      { kind: "region", ...at, hold: true },
    ];
    for (const draft of drafts) {
      expect(decodes(NodeDraft, draft), `${String(draft["kind"])} draft`).toBe(true);
      // The same thing with an id and a place is the model's node; without
      // them it is not.
      const placed = { ...(draft["kind"] === "agent" ? seated : draft), id: "n1", z: 3 };
      expect(decodes(Node, placed), `${String(draft["kind"])} node`).toBe(true);
      expect(decodes(Node, draft), `${String(draft["kind"])} draft as a node`).toBe(false);
    }
  });

  it("types a draft's id as a node id", () => {
    const draft: NodeDraft = { kind: "note", ...at, text: "x" };
    const id: string | undefined = draft.id;
    expect(id).toBeUndefined();
  });

  it("may name its id, and may not say where it stacks", () => {
    expect(decodes(NodeDraft, { kind: "note", ...at, text: "x", id: "mine" })).toBe(true);
    expect(decodes(NodeDraft, { kind: "note", ...at, text: "x", z: 1 })).toBe(false);
  });

  it("drafts a seat by its harness and dials, and nothing main works out", () => {
    expect(decodes(NodeDraft, {
      ...seat, label: "Builder", host: "studio", profile: "work", model: "opus", effort: "high",
      mode: "ultra", permissionMode: "plan", cwd: "/repo", onRemove: "kill-session", color: "#aabbcc",
    })).toBe(true);
    for (const field of SEAT_FIELDS_MAIN_WORKS_OUT) {
      const value = field === "overseer" ? false : field === "launch" ? { kind: "harness", argv: ["claude"] } : "x";
      expect(decodes(NodeDraft, { ...seat, [field]: value }), field).toBe(false);
    }
    expect(decodes(NodeDraft, { kind: "agent", ...at })).toBe(false);
    expect(decodes(NodeDraft, { ...seat, model: "" })).toBe(false);
  });

  it("drafts a terminal with the command it runs", () => {
    const shell = { kind: "terminal", ...at, host: "local", onRemove: "detach" };
    expect(decodes(NodeDraft, shell)).toBe(true);
    expect(decodes(NodeDraft, { ...shell, bindingId: "term-1", launch: { kind: "command", argv: ["htop"] } })).toBe(true);
  });

  it("refuses a field its kind does not have, and a kind the model does not have", () => {
    expect(decodes(NodeDraft, { kind: "note", ...at, text: "x", url: "https://example.com" })).toBe(false);
    expect(decodes(NodeDraft, { kind: "widget", ...at })).toBe(false);
    expect(decodes(NodeDraft, { type: "text", text: "x", ...at })).toBe(false);
  });
});

describe("a wire draft", () => {
  it("is the model's wire with the id and the verb optional", () => {
    expect(decodes(WireDraft, { from: "a", to: "b" })).toBe(true);
    expect(decodes(WireDraft, { id: "w1", from: "a", to: "b", verb: "messages", mask: ["msg.send"], fromSide: "left", toSide: "right" })).toBe(true);
    expect(decodes(Wire, { from: "a", to: "b" })).toBe(false);
    expect(decodes(Wire, { id: "w1", from: "a", to: "b", verb: "messages" })).toBe(true);
  });

  it("keeps the model's rules: two different ends, a known verb, no stray field", () => {
    expect(decodes(WireDraft, { from: "a", to: "a" })).toBe(false);
    expect(decodes(WireDraft, { from: "a", to: "b", verb: "likes" })).toBe(false);
    expect(decodes(WireDraft, { fromNode: "a", toNode: "b" })).toBe(false);
    expect(decodes(WireDraft, { from: "a", to: "b", label: "x" })).toBe(false);
  });
});
