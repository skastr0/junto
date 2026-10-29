import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PulseHold, PulseStrips } from "../src/renderer/components/edges/WirePulse";

const WIRE = "M0,0 L92,0 Q100,0 100,8 L100,100";

describe("the wire pulse's strips", () => {
  it("draws one clipped strip per leg, each a mover carrying one dash, in the kind's colour", () => {
    const html = renderToStaticMarkup(<PulseStrips path={WIRE} kind="prompt" reverse={false} />);
    expect(html.match(/class="junto-wire-pulse__run"/g)).toHaveLength(2);
    expect(html.match(/class="junto-wire-pulse__mover"/g)).toHaveLength(2);
    expect(html.match(/class="junto-wire-pulse__dash"/g)).toHaveLength(2);
    expect(html).toContain('data-direction="forward"');
    expect(html).toContain("color:var(--color-amber-hi)");
    expect(html).toContain("transform:rotate(90deg)");
    // No stroke animates: the strips are boxes, not a dashed path.
    expect(html).not.toMatch(/<path|stroke-dash|pathLength/);
  });

  it("marks the run direction and the impact cone for the stylesheet", () => {
    const html = renderToStaticMarkup(<PulseStrips path={WIRE} kind="answer" reverse impactIn />);
    expect(html).toContain('data-direction="reverse"');
    expect(html).toContain('data-impact-in=""');
    expect(renderToStaticMarkup(<PulseStrips path={WIRE} kind="answer" reverse={false} />)).not.toContain("data-impact-in");
  });

  it("keeps the reduced-motion hold as the wire's own path, undashed", () => {
    const html = renderToStaticMarkup(
      <svg>
        <PulseHold path={WIRE} kind="notice" />
      </svg>,
    );
    expect(html).toContain('class="junto-wire-pulse-hold"');
    expect(html).toContain(`d="${WIRE}"`);
    expect(html).toContain("stroke:var(--color-violet)");
    expect(html).not.toMatch(/pathLength|stroke-dash/);
  });
});
