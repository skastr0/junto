// @vitest-environment jsdom
/**
 * The Broadcast confirm says the seats that cross a chosen region's edge:
 * one line per region in its description, and the seats under a heading of
 * their own in the names list, apart from the seats that get the thread.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BroadcastSeat } from "../src/shared/broadcast";
import { BroadcastConfirm } from "../src/window/components/quick-thread/BroadcastParts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seat = (nodeId: string, name = nodeId): BroadcastSeat => ({ canvasName: "c", nodeId, name, running: true, elsewhere: false });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async (crossing: ReadonlyArray<{ region: string; seats: ReadonlyArray<BroadcastSeat> }>) =>
  act(async () =>
    root.render(
      <BroadcastConfirm
        seats={[seat("a"), seat("b")]}
        unread={[]}
        crossing={crossing}
        regionOf={() => "Big"}
        sending={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
        onAddThem={() => undefined}
      />,
    ),
  );
const group = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="quick-thread-confirm"]')!;
const described = (): string =>
  (group().getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" | ");

describe("the confirm's edge lines", () => {
  it("say each region's seats that cross its edge, in the description, only when there are some", async () => {
    await mount([]);
    expect(host.querySelector('[data-testid="quick-thread-crossing"]')).toBeNull();
    expect(described()).toBe("Each gets its own thread.");
    await mount([
      { region: "Big", seats: [seat("x"), seat("y"), seat("z")] },
      { region: "Small", seats: [seat("w")] },
    ]);
    expect([...host.querySelectorAll('[data-testid="quick-thread-crossing"]')].map((line) => line.textContent)).toEqual([
      "3 seats are partly inside Big and are not included.",
      "1 seat is partly inside Small and is not included.",
    ]);
    expect(described()).toBe(
      "Each gets its own thread. | 3 seats are partly inside Big and are not included. | 1 seat is partly inside Small and is not included.",
    );
  });

  it("list the seats that cross in a disclosure of their own, apart from the seats that get the thread", async () => {
    await mount([{ region: "Big", seats: [seat("x", "Xena"), seat("y", "Yori")] }]);
    // Two toggles: the seats that get it, and the seats that cross; the first counts only its own.
    const toggles = [...host.querySelectorAll<HTMLButtonElement>(".quick-thread__disclosure-toggle")];
    expect(toggles.map((toggle) => toggle.getAttribute("aria-label"))).toEqual(["Show the 2 seats", "Show the 2 seats partly inside Big"]);
    await act(async () => toggles[0]!.click());
    await act(async () => toggles[1]!.click());
    const regions = [...host.querySelectorAll<HTMLElement>('[role="region"]')];
    expect(regions.map((region) => region.getAttribute("aria-label"))).toEqual([
      "The 2 seats that get it",
      "The 2 seats partly inside Big, not included",
    ]);
    expect([...regions[0]!.querySelectorAll('[data-testid="quick-thread-name"]')].map((row) => row.getAttribute("data-seat"))).toEqual(["a", "b"]);
    expect([...regions[1]!.querySelectorAll('[data-testid="quick-thread-name"]')].map((row) => row.textContent)).toEqual(["Xena", "Yori"]);
    // They are not sent to, so none is marked as getting it when back, whether or not it is running.
    expect(regions[1]!.textContent).not.toContain("gets it when back");
  });

  it("names every list: the ids a list is labelled by hold no spaces", async () => {
    await mount([{ region: "Big", seats: [seat("x", "Xena")] }]);
    for (const toggle of host.querySelectorAll<HTMLButtonElement>(".quick-thread__disclosure-toggle")) await act(async () => toggle.click());
    for (const list of host.querySelectorAll("[aria-labelledby]")) {
      const ids = (list.getAttribute("aria-labelledby") ?? "").split(" ");
      expect(ids.every((id) => document.getElementById(id) !== null), `${list.getAttribute("aria-labelledby")} names a heading`).toBe(true);
    }
  });
});
