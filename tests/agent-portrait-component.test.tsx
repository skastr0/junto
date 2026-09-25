import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/lib/theme-mode", async () => {
  const { observable } = await import("@legendapp/state");
  return { themeMode$: observable<"dark" | "bright">("dark") };
});

const { AgentPortrait, agentPortraitSrc } = await import("../src/renderer/components/AgentPortrait");
const { state$ } = await import("../src/renderer/lib/state");
const { seatPortraitMood } = await import("../src/renderer/lib/portrait-mood");
const { defaultSettings } = await import("../src/shared/settings");

describe("AgentPortrait", () => {
  it("renders one cached portrait image plus a harness badge", () => {
    const html = renderToStaticMarkup(<AgentPortrait identity="node-1" harness="claude" size={28} />);
    expect(html.match(/<img/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("agent-portrait__badge");
    expect(html).toContain(agentPortraitSrc("node-1", "dark", "glyph").slice(0, 80));
    expect(agentPortraitSrc("node-1", "dark", "glyph")).toBe(agentPortraitSrc("node-1", "dark", "glyph"));
  });

  it("drops the badge without a managed harness", () => {
    const html = renderToStaticMarkup(<AgentPortrait identity="node-1" size={48} />);
    expect(html).not.toContain("agent-portrait__badge");
  });

  it("paints a pinned theme and a round frame on request", () => {
    const html = renderToStaticMarkup(
      <AgentPortrait identity="node-1" size={40} theme="bright" frame="round" outline={false} harness="codex" />,
    );
    expect(html).toContain('data-frame="round"');
    expect(html).not.toContain("data-outline");
    expect(html).toContain("border-radius:50%");
    expect(agentPortraitSrc("node-1", "bright", "card", "round")).not.toBe(agentPortraitSrc("node-1", "bright", "card"));
  });

  it("wears the seat's saved override and picks a face from its mood", () => {
    state$.settings.set({ ...defaultSettings(), portraits: { bySeat: { "node-9": { temperament: 1, shape: "toast" } } } });
    const html = renderToStaticMarkup(
      <AgentPortrait identity="node-9" size={36} frame="round" mood={{ activity: "work", health: "stuck" }} />,
    );
    expect(html).toContain('data-expression="determined"');
    expect(html).toContain(
      agentPortraitSrc("node-9", "dark", "card", "round", { temperament: 1, shape: "toast" }, "determined").slice(-120),
    );
    const moody = renderToStaticMarkup(
      <AgentPortrait identity="node-9" size={36} config={{ temperament: -1 }} mood={{ activity: "rest" }} />,
    );
    expect(moody).toContain('data-expression="grumpy"');
    expect(renderToStaticMarkup(<AgentPortrait identity="node-9" size={36} />)).toContain('data-expression="resting"');
  });

  it("reads mood from the ring's inputs and drops a stale health reading", () => {
    const working = { mode: "wave", tone: "cyan", label: "working" } as const;
    expect(seatPortraitMood(working, { value: "stuck" }, "blocked")).toEqual({
      activity: "work",
      signal: "blocked",
      health: "stuck",
    });
    expect(seatPortraitMood(working, { value: "stuck", healthStale: true })).toEqual({ activity: "work" });
    expect(seatPortraitMood({ mode: "pulse", tone: "green", label: "done" })).toEqual({ activity: "done" });
  });
});
