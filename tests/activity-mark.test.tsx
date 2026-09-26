/**
 * ActivityMark: one element per mark, addressed into the ring atlas.
 * Structure, a11y and the seat slot. The ring rules themselves live in
 * activity-atlas.test.ts; motion CSS in canvas-attention-motion.test.ts.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityMark, ActivityMarkFromSpec } from "../src/renderer/components/ActivityMark";
import { terminalActivity } from "../src/renderer/lib/activity";

const attr = (html: string, name: string): string | undefined =>
  new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

describe("ActivityMark structure", () => {
  it("is a single element: no per-cell children", () => {
    const html = renderToStaticMarkup(<ActivityMark mode="wave" tone="cyan" label="working" />);
    expect(html.match(/<span/g)?.length).toBe(1);
    expect(html).toContain('class="junto-mark"');
    expect(attr(html, "data-mark-ring")).toBe("work");
    expect(attr(html, "data-mark-motion")).toBe("loop");
    expect(html).toContain("--mark-col:");
    expect(html).toContain("--mark-row:");
  });

  it("done lands once, then keeps a quiet loop until read", () => {
    const html = renderToStaticMarkup(<ActivityMark mode="pulse" tone="green" label="done" />);
    expect(attr(html, "data-mark-ring")).toBe("done");
    expect(attr(html, "data-mark-motion")).toBe("loop");
    expect(html).toContain("data-mark-land");
    expect(html).toContain("--mark-lrow:");
  });

  it("a still seat that waits on you orbits, whatever its control mode", () => {
    const html = renderToStaticMarkup(<ActivityMark mode="static" tone="steel" label="idle" signal="escalate" />);
    expect(attr(html, "data-mark-ring")).toBe("wait");
    expect(attr(html, "data-mark-motion")).toBe("loop");
    const resting = renderToStaticMarkup(<ActivityMark mode="static" tone="steel" label="idle" />);
    expect(attr(resting, "data-mark-motion")).toBe("still");
  });

  it("an overseer seat wears a crest and says so", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="static" tone="steel" label="resting" size="seat" crest>
        <img alt="" />
      </ActivityMark>,
    );
    expect(html).toContain('data-testid="overseer-crest"');
    expect(attr(html, "aria-label")).toBe("Overseer, resting");
    const plain = renderToStaticMarkup(<ActivityMark mode="static" tone="steel" label="resting" size="seat" />);
    expect(plain).not.toContain("overseer-crest");
  });

  it("active=false freezes a loop at its rest pose", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="crimson" label="blocked" active={false} />,
    );
    expect(attr(html, "data-mark-ring")).toBe("halt");
    expect(attr(html, "data-mark-motion")).toBe("still");
  });

  it("standalone marks carry a hub; a seat holds its portrait instead", () => {
    const standalone = renderToStaticMarkup(<ActivityMark mode="wave" tone="cyan" label="working" />);
    expect(standalone).toContain("data-mark-hub");
    expect(standalone).toContain("--mark-hub:");
    const seat = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="cyan" label="working" size="seat">
        <img alt="" />
      </ActivityMark>,
    );
    expect(seat).not.toContain("data-mark-hub");
    expect(seat).toContain('class="junto-mark__seat"');
    expect(attr(seat, "data-mark-size")).toBe("seat");
  });

  it("gone draws the powered-down ring", () => {
    const html = renderToStaticMarkup(<ActivityMarkFromSpec spec={terminalActivity({ seatState: "gone" })} />);
    expect(attr(html, "data-mark-ring")).toBe("off");
  });
});

describe("ActivityMark health and signals", () => {
  it("a trouble reading bends a working ring and never uses crimson", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="cyan" label="working" health="trouble" healthValue="thrashing" />,
    );
    expect(attr(html, "data-mark-ring")).toBe("snake");
    expect(html).not.toContain("--color-crimson");
  });

  it("joins health and signal into the accessible name, with commas", () => {
    const html = renderToStaticMarkup(
      <ActivityMark
        mode="wave"
        tone="cyan"
        label="working"
        health="good"
        healthLabel="AI reads: going well"
        signal="blocked"
        signalCount={3}
      />,
    );
    expect(attr(html, "aria-label")).toBe("working, AI reads: going well, 3 open signals, worst blocked");
    expect(attr(html, "title")).toBe(attr(html, "aria-label"));
    expect(html).toContain("data-mark-band");
    expect(html).not.toContain("\u00B7");
  });

  it("the flag is a click target only when the seat can open its signals", () => {
    const passive = renderToStaticMarkup(<ActivityMark mode="static" tone="steel" label="idle" signal="escalate" />);
    expect(passive).not.toContain("<button");
    const live = renderToStaticMarkup(
      <ActivityMark mode="static" tone="steel" label="idle" signal="escalate" onSignalOpen={() => undefined} />,
    );
    expect(live).toContain('class="junto-mark__flag nodrag nopan"');
    expect(live).toContain('aria-label="1 open signal, escalate, open signals"');
  });
});

describe("ActivityMark a11y and sizing", () => {
  it("keeps role, aria-label and title for every mode", () => {
    for (const mode of ["wave", "pulse", "static"] as const) {
      const html = renderToStaticMarkup(<ActivityMark mode={mode} tone="cyan" label={`state-${mode}`} />);
      expect(html).toContain('role="status"');
      expect(attr(html, "aria-label")).toBe(`state-${mode}`);
      expect(attr(html, "title")).toBe(`state-${mode}`);
    }
  });

  it("carries size on the element; the sheet maps it to a unit", () => {
    for (const size of ["node", "inline", "seat"] as const) {
      const html = renderToStaticMarkup(<ActivityMark mode="wave" tone="cyan" label="w" size={size} />);
      expect(attr(html, "data-mark-size")).toBe(size);
      expect(attr(html, "data-activity-size")).toBe(size);
    }
  });
});
