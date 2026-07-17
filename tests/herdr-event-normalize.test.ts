import { describe, expect, it } from "vitest";
import {
  flattenHerdrEventData,
  normalizeHerdrEvent,
  normalizeHerdrEventKind,
} from "../src/main/vellum/herdr/event-normalize";

describe("normalizeHerdrEventKind", () => {
  it("maps snake_case lifecycle kinds to dotted", () => {
    expect(normalizeHerdrEventKind("workspace_created")).toBe("workspace.created");
    expect(normalizeHerdrEventKind("pane_agent_status_changed")).toBe("pane.agent_status_changed");
    expect(normalizeHerdrEventKind("layout_updated")).toBe("layout.updated");
  });

  it("leaves already-dotted subscription kinds alone", () => {
    expect(normalizeHerdrEventKind("pane.agent_status_changed")).toBe("pane.agent_status_changed");
    expect(normalizeHerdrEventKind("workspace.created")).toBe("workspace.created");
  });
});

describe("normalizeHerdrEvent — herdr wire (api_ping / schema)", () => {
  it("parses lifecycle EventEnvelope with nested entity", () => {
    const n = normalizeHerdrEvent({
      event: "workspace_created",
      data: {
        type: "workspace_created",
        workspace: { workspace_id: "w2", label: "new", tab_count: 0 },
      },
    });
    expect(n?.kind).toBe("workspace.created");
    expect(n?.body.workspace_id).toBe("w2");
    expect(n?.body.label).toBe("new");
  });

  it("parses subscription agent_status_changed with flat data", () => {
    const n = normalizeHerdrEvent({
      event: "pane.agent_status_changed",
      data: {
        pane_id: "w1:p1",
        workspace_id: "w1",
        agent_status: "idle",
        agent: "claude",
      },
    });
    expect(n?.kind).toBe("pane.agent_status_changed");
    expect(n?.body).toMatchObject({
      pane_id: "w1:p1",
      agent_status: "idle",
      agent: "claude",
    });
  });

  it("parses pane_created with nested pane", () => {
    const n = normalizeHerdrEvent({
      event: "pane_created",
      data: {
        type: "pane_created",
        pane: {
          pane_id: "w1:p2",
          workspace_id: "w1",
          tab_id: "w1:t1",
          terminal_id: "term_2",
          agent_status: "unknown",
        },
      },
    });
    expect(n?.kind).toBe("pane.created");
    expect(n?.body.pane_id).toBe("w1:p2");
    expect(n?.body.terminal_id).toBe("term_2");
  });

  it("still accepts legacy flat type shapes", () => {
    const n = normalizeHerdrEvent({
      type: "pane.agent_status_changed",
      pane_id: "w1:p1",
      agent_status: "working",
    });
    expect(n?.kind).toBe("pane.agent_status_changed");
    expect(n?.body.agent_status).toBe("working");
  });

  it("returns null when kind is missing", () => {
    expect(normalizeHerdrEvent({ data: { pane_id: "x" } })).toBeNull();
    expect(normalizeHerdrEvent(null)).toBeNull();
  });
});

describe("flattenHerdrEventData", () => {
  it("merges nested workspace over data shell", () => {
    const body = flattenHerdrEventData({
      type: "workspace_created",
      workspace: { workspace_id: "w9", label: "x" },
    });
    expect(body.workspace_id).toBe("w9");
    expect(body.label).toBe("x");
    expect(body.workspace).toBeUndefined();
    expect(body.type).toBeUndefined();
  });
});
