// @vitest-environment jsdom
/**
 * Every reader of the needs-you feed gets the one feed built for the stores
 * as they stand, not a copy each. The needs-you button, the desktop
 * notifications and the open feed each built their own on every seat change
 * (0.11.10 trace: 532 ms in 30 s with the feed open under cmd+K).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentSeat$ } from "../src/window/lib/agent-seat-state";
import type { OperatorFeed } from "../src/shared/wire/operator-feed";
import { useOperatorFeed } from "../src/window/lib/operator-feed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const seen: Record<"button" | "feed", OperatorFeed[]> = { button: [], feed: [] };

function Reader({ as }: { readonly as: "button" | "feed" }) {
  seen[as].push(useOperatorFeed());
  return null;
}

beforeEach(() => {
  seen.button = [];
  seen.feed = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("hands two readers the same feed, and a new one to both when a seat changes", async () => {
  await act(async () =>
    root.render(
      <>
        <Reader as="button" />
        <Reader as="feed" />
      </>,
    ),
  );
  expect(seen.button.at(-1)).toBe(seen.feed.at(-1));

  const before = seen.button.at(-1);
  await act(async () => agentSeat$.rev.set(agentSeat$.rev.peek() + 1));
  expect(seen.button.at(-1)).not.toBe(before);
  expect(seen.button.at(-1)).toBe(seen.feed.at(-1));
});
