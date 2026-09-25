import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/lib/theme-mode", async () => {
  const { observable } = await import("@legendapp/state");
  return { themeMode$: observable<"dark" | "bright">("dark") };
});

const { AgentPortrait, agentPortraitSrc } = await import("../src/renderer/components/AgentPortrait");

describe("AgentPortrait", () => {
  it("renders one cached portrait image plus a harness badge", () => {
    const html = renderToStaticMarkup(<AgentPortrait seed="node-1" harness="claude" size={28} />);
    expect(html.match(/<img/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("agent-portrait__badge");
    expect(html).toContain(agentPortraitSrc("node-1", "dark", "glyph").slice(0, 80));
    expect(agentPortraitSrc("node-1", "dark", "glyph")).toBe(agentPortraitSrc("node-1", "dark", "glyph"));
  });

  it("drops the badge without a managed harness", () => {
    const html = renderToStaticMarkup(<AgentPortrait seed="node-1" size={48} />);
    expect(html).not.toContain("agent-portrait__badge");
  });
});
