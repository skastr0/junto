// @vitest-environment jsdom
/**
 * The far-zoom hidden-seat sheet is written only when the gathered seats
 * change. A rewrite is a style rule change, and the browser restyles every
 * seat and ring part on the board for it; it was rewritten on every seat's
 * ring change, most of the window's time at far zoom with seats reporting.
 */
import { afterEach, expect, it, vi } from "vitest";

// jsdom has no CSS.escape; these ids need none.
vi.stubGlobal("CSS", { escape: (value: string) => value });
const { clustersKey, writeHidden } = await import("../src/window/components/SeatClusterLayer");

const sheet = (): HTMLElement | null => document.getElementById("junto-seat-clusters");

/** Writes to the sheet's text from here on. */
const watchWrites = (el: HTMLElement): { readonly count: () => Promise<number> } => {
  let writes = 0;
  const observer = new MutationObserver((records) => {
    writes += records.length;
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });
  return {
    count: async () => {
      await Promise.resolve();
      return writes;
    },
  };
};

afterEach(() => writeHidden([]));

it("writes the sheet when the gathered seats change, and leaves it when they do not", async () => {
  writeHidden(["seat-a", "seat-b"]);
  const el = sheet()!;
  expect(el.textContent).toContain('[data-id="seat-a"]');
  const writes = watchWrites(el);

  // The same seats, in any order: nothing is written.
  writeHidden(["seat-b", "seat-a"]);
  writeHidden(["seat-a", "seat-b"]);
  expect(await writes.count()).toBe(0);

  // A seat parts: the sheet is written, without it.
  writeHidden(["seat-a"]);
  expect(await writes.count()).toBeGreaterThan(0);
  expect(el.textContent).not.toContain('[data-id="seat-b"]');

  // None gathered: the sheet goes, and stays gone.
  writeHidden([]);
  expect(sheet()).toBeNull();
  writeHidden([]);
  expect(sheet()).toBeNull();
});

it("keys the badges on what they draw: a member's ring, not a ring outside them", () => {
  const clusters = [{ key: "seat-a", members: ["seat-a", "seat-b"], x: 10, y: 20, partsAt: 0.3 }];
  const before = clustersKey(clusters, new Map([["seat-a", "work"], ["seat-b", "rest"], ["seat-z", "rest"]]));
  expect(clustersKey(clusters, new Map([["seat-a", "work"], ["seat-b", "rest"], ["seat-z", "done"]]))).toBe(before);
  expect(clustersKey(clusters, new Map([["seat-a", "work"], ["seat-b", "done"], ["seat-z", "rest"]]))).not.toBe(before);
  expect(clustersKey([{ ...clusters[0]!, x: 11 }], new Map([["seat-a", "work"], ["seat-b", "rest"]]))).not.toBe(before);
});
