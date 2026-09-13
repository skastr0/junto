import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import type { LiveSnapshot } from "../src/shared/overseer-live";
import { LiveConversationBody } from "../src/renderer/components/live/LiveConversation";
import { canStartOverseerLive, openOverseerLive, overseerLive$, readLiveAttention } from "../src/renderer/lib/overseer-live-state";
import { state$ } from "../src/renderer/lib/state";

const snapshot: LiveSnapshot = {
  sessionId: "s1", canvasName: "Factory", nodeId: "overseer", connectionEpoch: 2,
  connection: "ready", authority: "active", controller: "working", elapsedSeconds: 95,
  voiceCostUsd: 0.015, limitSeconds: 600,
  transcript: [{ id: "t1", speaker: "operator", text: "Move the task beside the worker" }],
  requests: [{ requestId: "r1", intentRevision: 1, text: "Move the task", status: "executing" }],
  actions: [{ id: "a1", requestId: "r1", label: "Move task", status: "committed", targetRefs: ["Factory/task"] }],
};
const noop = () => undefined;
const controls = { onStart: noop, onMute: noop, onEnd: noop, onSettings: noop, onPlayback: noop, onStop: noop, onCancel: noop, onSteer: noop };

describe("live conversation controls", () => {
  it("shows muted microphone, active work, request correction/cancel, and voice budget independently", () => {
    const html = renderToStaticMarkup(<LiveConversationBody snapshot={snapshot} media={{ connection: "ready", microphone: "muted", playback: "playing" }} error="" busy={false} {...controls} />);
    for (const text of ["Microphone muted", "Audio on", "Taking action", "Correct request", "Cancel request", "End call", "Stop actions", "1:35 / 10:00 call limit", "$0.015", "committed"]) expect(html).toContain(text);
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("\u00b7");
  });

  it("keeps pending request controls after voice ends", () => {
    const html = renderToStaticMarkup(<LiveConversationBody snapshot={{ ...snapshot, connection: "closed" }} media={{ connection: "closed", microphone: "off", playback: "off" }} error="" busy={false} {...controls} />);
    expect(html).toContain("The call is closed. Pending requests continue");
    expect(html).toContain("Cancel request");
    expect(html).toContain("Start live conversation");
  });

  it("never labels an interrupted or failed operation as committed", () => {
    const html = renderToStaticMarkup(<LiveConversationBody snapshot={{ ...snapshot, actions: [{ ...snapshot.actions[0]!, status: "failed" }], requests: [{ ...snapshot.requests[0]!, status: "cancelled" }] }} media={{ connection: "closed", microphone: "off", playback: "off" }} error="" busy={false} {...controls} />);
    expect(html).toContain("failed");
    expect(html).not.toContain("committed");
    expect(html).not.toContain("Cancel request");
    expect(html).not.toContain("Correct request");
  });

  it("offers settings recovery without taking a credential through conversation", () => {
    const html = renderToStaticMarkup(<LiveConversationBody snapshot={null} media={{ connection: "idle", microphone: "off", playback: "off" }} error="Add your OpenAI API key in Settings > Providers." busy={false} {...controls} />);
    expect(html).toContain("Open settings");
    expect(html).not.toContain('type="password"');
    expect(html).toContain("Microphone off");
  });
});

describe("live conversation seat and attention", () => {
  const seat: CanvasNode = { id: "o1", type: "text", text: "Overseer", x: 0, y: 0, width: 240, height: 96, ether: { entity: { kind: "agent" }, overseer: true, terminal: { bindingId: "binding", harness: "vellum-overseer" } } };
  it("requires a granted native controller seat and never upgrades an ordinary worker", () => {
    expect(canStartOverseerLive(seat)).toBe(true);
    expect(canStartOverseerLive({ ...seat, ether: { ...seat.ether, overseer: false } })).toBe(false);
    expect(canStartOverseerLive({ ...seat, ether: { ...seat.ether, terminal: { bindingId: "worker", harness: "codex" } } })).toBe(false);
  });

  it("does not replace a call's occupant when another seat is opened", () => {
    overseerLive$.target.set(null);
    openOverseerLive({ canvasName: "Factory", nodeId: "first", title: "First" });
    openOverseerLive({ canvasName: "Factory", nodeId: "second", title: "Second" });
    expect(overseerLive$.target.peek()?.nodeId).toBe("first");
    expect(overseerLive$.expanded.peek()).toBe(true);
    overseerLive$.target.set(null);
    overseerLive$.expanded.set(false);
  });

  it("captures selected IDs without moving the viewport or changing selection", () => {
    state$.canvasName.set("Factory");
    state$.selectedNodeIds.set(["task", "worker"]);
    state$.selectedNodeId.set("worker");
    state$.focusNodeId.set("");
    const attention = readLiveAttention();
    state$.selectedNodeIds.set(["later"]);
    expect(attention).toEqual({ canvasName: "Factory", selectedNodeIds: ["task", "worker"] });
    expect(state$.focusNodeId.peek()).toBe("");
  });
});
