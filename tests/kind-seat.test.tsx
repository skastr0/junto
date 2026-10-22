import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KIND_RING, KindSeat, kindStateOf } from "../src/renderer/components/nodes/KindSeat";
import { KIND_ICON_KINDS } from "../src/shared/kind-icon";

const attr = (html: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

describe("KindSeat", () => {
  it("is the seat's row: the seat ring around an icon, the name, one line", () => {
    const html = renderToStaticMarkup(<KindSeat kind="task" name="Ship 0.10" line="14 tasks, 1 needs you" state="needs" />);
    expect(html).toContain("junto-seat kind-seat");
    expect(html).toContain('data-mark-size="seat"');
    expect(attr(html, "data-mark-ring")).toBe("call");
    expect(html).toContain('class="kind-icon"');
    expect(html).toContain("Ship 0.10");
    expect(html).toContain("14 tasks, 1 needs you");
    expect(html).toContain("text-amber-fg");
    expect(html).toContain('data-kind="task"');
    expect(html).toContain('data-state="needs"');
  });

  it("every kind draws, in every state, with the seat's tones", () => {
    for (const kind of KIND_ICON_KINDS) {
      for (const state of Object.keys(KIND_RING) as (keyof typeof KIND_RING)[]) {
        const html = renderToStaticMarkup(<KindSeat kind={kind} name={kind} line="a line" state={state} />);
        expect(html, `${kind} ${state}`).toContain("kind-band");
        expect(attr(html, "data-activity-tone")).toBe(KIND_RING[state].tone);
      }
    }
  });

  it("holds at most one moving band part, named by its motion", () => {
    for (const state of ["working", "needs", "blocked", "done"] as const) {
      const html = renderToStaticMarkup(<KindSeat kind="page" name="docs" line="page" state={state} />);
      expect(html.match(/data-motion=/g)?.length ?? 0, state).toBeLessThanOrEqual(1);
    }
    const working = renderToStaticMarkup(<KindSeat kind="automations" name="Nightly" line="firing" state="working" />);
    expect(working).toContain('data-motion="hand"');
    const idle = renderToStaticMarkup(<KindSeat kind="automations" name="Nightly" line="2 on" />);
    expect(idle).not.toContain("data-motion");
  });

  it("maps a node status to the seat's states", () => {
    expect(kindStateOf(undefined)).toBe("idle");
    expect(kindStateOf(undefined, true)).toBe("done");
    expect(kindStateOf("blocked")).toBe("blocked");
    expect(kindStateOf("failed")).toBe("blocked");
    expect(kindStateOf("needs-you")).toBe("needs");
    expect(kindStateOf("working")).toBe("working");
    expect(kindStateOf("off")).toBe("off");
    expect(kindStateOf("retired")).toBe("off");
  });

  it("the trailing instrument sits on the name row", () => {
    const html = renderToStaticMarkup(<KindSeat kind="task" name="Ship" line="1" trailing={<button type="button">+</button>} />);
    expect(html.indexOf("Ship")).toBeLessThan(html.indexOf("<button"));
  });
});
