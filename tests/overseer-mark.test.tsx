import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverseerMark } from "../src/renderer/components/OverseerMark";

describe("OverseerMark", () => {
  it("reads OVERSEER in indigo, never amber or crimson", () => {
    const html = renderToStaticMarkup(<OverseerMark size="card" />);
    expect(html).toContain("OVERSEER");
    expect(html).toContain('data-testid="overseer-mark"');
    expect(html).toContain('data-overseer="true"');
    expect(html).toContain("var(--color-indigo)");
    expect(html).not.toContain("var(--color-amber)");
    expect(html).not.toContain("var(--color-crimson)");
  });

  it("session mark is larger than the card glance", () => {
    const card = renderToStaticMarkup(<OverseerMark size="card" />);
    const session = renderToStaticMarkup(<OverseerMark size="session" />);
    expect(card).toContain('data-size="card"');
    expect(session).toContain('data-size="session"');
    expect(session).toContain("OVERSEER");
  });
});
