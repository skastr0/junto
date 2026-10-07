import { afterEach, describe, expect, it } from "vitest";
import {
  closeOperatorModal,
  isOperatorModalOpen,
  openOperatorModal,
  openOperatorModalFrom,
  operatorModal$,
  takeOperatorModalPlace,
  toggleOperatorModal,
} from "../src/renderer/lib/operator-modal";

describe("the operator slot", () => {
  afterEach(() => {
    // Twice: a modal opened from another closes back to it first.
    closeOperatorModal();
    closeOperatorModal();
  });

  it("holds one modal: opening another swaps it", () => {
    openOperatorModal("search");
    expect(isOperatorModalOpen("search")).toBe(true);
    openOperatorModal("feed");
    expect(operatorModal$.open.peek()).toBe("feed");
    expect(isOperatorModalOpen("search")).toBe(false);
  });

  it("closes on a modal's own chord and swaps on the other's", () => {
    toggleOperatorModal("search");
    toggleOperatorModal("feed");
    expect(operatorModal$.open.peek()).toBe("feed");
    toggleOperatorModal("feed");
    expect(isOperatorModalOpen()).toBe(false);
  });

  it("a modal that closes itself after handing over leaves the next one open", () => {
    openOperatorModal("search");
    openOperatorModal("feed");
    closeOperatorModal("search");
    expect(operatorModal$.open.peek()).toBe("feed");
  });

  describe("a modal opened from another, and the way back", () => {
    const place = { itemId: "signal:one", expanded: ["signal:one"], scrollTop: 480 };

    it("swaps, and closing it comes back to the first modal at its place, once", () => {
      openOperatorModal("feed");
      openOperatorModalFrom("feed", "search", place);
      expect(operatorModal$.open.peek()).toBe("search");
      // Not back yet: nothing to take.
      expect(takeOperatorModalPlace("feed")).toBeUndefined();

      closeOperatorModal("search");
      expect(operatorModal$.open.peek()).toBe("feed");
      expect(takeOperatorModalPlace("feed")).toEqual(place);
      expect(takeOperatorModalPlace("feed")).toBeUndefined();

      // From here the feed closes as it always does.
      closeOperatorModal("feed");
      expect(isOperatorModalOpen()).toBe(false);
    });

    it("does nothing unless the modal it is opened from is the one open", () => {
      openOperatorModalFrom("feed", "search", place);
      expect(isOperatorModalOpen()).toBe(false);
      openOperatorModal("search");
      openOperatorModalFrom("feed", "search", place);
      closeOperatorModal();
      expect(isOperatorModalOpen()).toBe(false);
    });

    it("going back by the first modal's own chord still returns to its place", () => {
      openOperatorModal("feed");
      openOperatorModalFrom("feed", "search", place);
      toggleOperatorModal("feed");
      expect(operatorModal$.open.peek()).toBe("feed");
      expect(takeOperatorModalPlace("feed")).toEqual(place);
    });

    it("an ordinary open never carries an old place", () => {
      openOperatorModal("feed");
      openOperatorModalFrom("feed", "search", place);
      closeOperatorModal("search");
      // Back at the feed, which did not take its place before it was closed.
      closeOperatorModal("feed");
      openOperatorModal("feed");
      expect(takeOperatorModalPlace("feed")).toBeUndefined();
    });
  });
});
