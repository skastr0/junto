import { afterEach, describe, expect, it } from "vitest";
import {
  closeOperatorModal,
  isOperatorModalOpen,
  openOperatorModal,
  operatorModal$,
  toggleOperatorModal,
} from "../src/renderer/lib/operator-modal";

describe("the operator slot", () => {
  afterEach(() => closeOperatorModal());

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
});
