import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KIND_STATES, KindSeat, kindRing, kindStateOf } from "../src/renderer/components/nodes/KindSeat";
import { KIND_ICON_KINDS } from "../src/shared/kind-icon";
import { SeatUrgency } from "../src/shared/wire/urgency";

const G = SeatUrgency.group;

const attr = (html: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

describe("KindSeat", () => {
  it("is the seat's row: the seat ring around an icon, the name, one line", () => {
    const html = renderToStaticMarkup(<KindSeat kind="task" name="Ship 0.10" line="14 tasks, 1 needs you" state={G.waiting} />);
    expect(html).toContain("junto-seat kind-seat");
    expect(html).toContain('data-mark-size="seat"');
    expect(attr(html, "data-mark-ring")).toBe("call");
    expect(html).toContain('class="kind-icon"');
    expect(html).toContain("Ship 0.10");
    expect(html).toContain("14 tasks, 1 needs you");
    expect(html).toContain("text-amber-fg");
    expect(html).toContain('data-kind="task"');
    expect(html).toContain('data-state="waiting"');
  });

  it("every kind draws, in every state, with the seat's tones", () => {
    for (const kind of KIND_ICON_KINDS) {
      for (const state of KIND_STATES) {
        const html = renderToStaticMarkup(<KindSeat kind={kind} name={kind} line="a line" state={state} />);
        expect(html, `${kind} ${state}`).toContain("kind-band");
        expect(attr(html, "data-activity-tone")).toBe(kindRing(state).tone);
      }
    }
  });

  it("holds at most one moving band part, named by its motion", () => {
    for (const state of [G.working, G.waiting, G.blocked, G.done]) {
      const html = renderToStaticMarkup(<KindSeat kind="page" name="docs" line="page" state={state} />);
      expect(html.match(/data-motion=/g)?.length ?? 0, state).toBeLessThanOrEqual(1);
    }
    const working = renderToStaticMarkup(<KindSeat kind="automations" name="Nightly" line="firing" state={G.working} />);
    expect(working).toContain('data-motion="hand"');
    const idle = renderToStaticMarkup(<KindSeat kind="automations" name="Nightly" line="2 on" />);
    expect(idle).not.toContain("data-motion");
  });

  it("maps a node status to the seat's states", () => {
    expect(kindStateOf(undefined)).toBe(G.resting);
    expect(kindStateOf(undefined, true)).toBe(G.done);
    expect(kindStateOf("blocked")).toBe(G.blocked);
    expect(kindStateOf("failed")).toBe(G.blocked);
    expect(kindStateOf("needs-you")).toBe(G.waiting);
    expect(kindStateOf("working")).toBe(G.working);
    expect(kindStateOf("off")).toBe(G.offline);
    expect(kindStateOf("retired")).toBe(G.offline);
  });

  it("the trailing instrument sits on the name row", () => {
    const html = renderToStaticMarkup(<KindSeat kind="task" name="Ship" line="1" trailing={<button type="button">+</button>} />);
    expect(html.indexOf("Ship")).toBeLessThan(html.indexOf("<button"));
  });
});
