import { afterEach, describe, expect, it } from "vitest";
import { KEY_ACTIONS } from "../src/window/lib/key-actions";
import { closeOperatorModal, isOperatorModalOpen, openOperatorModal } from "../src/window/lib/operator-modal";

const hit = { id: "threads.open" } as const;
const event = {} as KeyboardEvent;

describe("the Open threads key", () => {
  afterEach(() => closeOperatorModal());

  it("opens Threads, and closes it when it is open", () => {
    KEY_ACTIONS["threads.open"]!(hit, event);
    expect(isOperatorModalOpen("threads")).toBe(true);
    KEY_ACTIONS["threads.open"]!(hit, event);
    expect(isOperatorModalOpen()).toBe(false);
  });

  it("swaps the needs-you feed for Threads, as the feed key swaps search", () => {
    openOperatorModal("feed");
    KEY_ACTIONS["threads.open"]!(hit, event);
    expect(isOperatorModalOpen("threads")).toBe(true);
  });
});
