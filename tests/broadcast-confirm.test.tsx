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
      "3 seats cross the edge of Big and are not included.",
      "1 seat crosses the edge of Small and is not included.",
    ]);
    expect(described()).toBe(
      "Each gets its own thread. | 3 seats cross the edge of Big and are not included. | 1 seat crosses the edge of Small and is not included.",
    );
  });

  it("list the seats that cross under a heading of their own, apart from the seats that get the thread", async () => {
    await mount([{ region: "Big", seats: [seat("x", "Xena"), seat("y", "Yori")] }]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="quick-thread-confirm-names"] button')!.click());
    const apart = host.querySelector('[data-testid="quick-thread-names-apart"]')!;
    expect(apart.textContent).toContain("Cross the edge of Big, not included");
    expect([...apart.querySelectorAll('[data-testid="quick-thread-name-apart"]')].map((row) => row.textContent)).toEqual(["Xena", "Yori"]);
    // The seats that get it are listed apart from them.
    expect([...host.querySelectorAll('[data-testid="quick-thread-name"]')].map((row) => row.getAttribute("data-seat"))).toEqual(["a", "b"]);
  });
});
