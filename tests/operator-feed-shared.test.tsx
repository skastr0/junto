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
import { agentSignals$ } from "../src/window/lib/agent-signals-state";
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

it("hands two readers the same feed, and a new one to both when a signal lands", async () => {
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
  await act(async () =>
    agentSignals$["sig-1"].set({
      signalId: "sig-1",
      canvasName: "",
      nodeId: "seat-1",
      kind: "blocked",
      text: "the seat is blocked",
      createdAt: 1,
      state: "open",
    }),
  );
  expect(seen.button.at(-1)).not.toBe(before);
  expect(seen.button.at(-1)).toBe(seen.feed.at(-1));
});

it("keeps the one feed when a seat report changes nothing the feed draws", async () => {
  await act(async () =>
    root.render(
      <>
        <Reader as="button" />
        <Reader as="feed" />
      </>,
    ),
  );
  const renders = seen.button.length;
  // A working/idle flip is a real seat event, but it carries no attention,
  // no stopped need and no health reading: the feed's signature does not
  // move, so the readers do not even re-render.
  await act(async () =>
    agentSeat$.byBindingId["seat-x"].set({
      bindingId: "seat-x",
      epoch: "e1",
      state: "working",
      reason: "turn",
      confidence: "high",
      at: 1,
    }),
  );
  expect(seen.button).toHaveLength(renders);
});
