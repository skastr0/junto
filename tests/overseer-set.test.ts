import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flushCanvasEdits = vi.fn(async () => undefined);

vi.mock("../src/renderer/lib/canvas-editor-flush", () => ({
  flushCanvasEdits: () => flushCanvasEdits(),
}));

import {
  OverseerSetError,
  setOverseerSeat,
} from "../src/renderer/lib/overseer-set";

const modelCommand = vi.fn(async (_command: unknown) => ({ seq: 1 }));

beforeEach(() => {
  flushCanvasEdits.mockClear();
  modelCommand.mockClear();
  modelCommand.mockResolvedValue({ seq: 1 });
  vi.stubGlobal("window", {
    junto: { modelCommand },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("setOverseerSeat", () => {
  it("commits local edits, then sends the grant as its own command", async () => {
    await setOverseerSeat({ canvasName: "workshop", nodeId: "seat", overseer: true });
    expect(flushCanvasEdits).toHaveBeenCalledOnce();
    expect(modelCommand).toHaveBeenCalledExactlyOnceWith({
      _tag: "GrantOverseer",
      canvas: "workshop",
      id: "seat",
      overseer: true,
    });
    expect(flushCanvasEdits.mock.invocationCallOrder[0]).toBeLessThan(modelCommand.mock.invocationCallOrder[0]!);
  });

  it("sends a revoke the same way", async () => {
    await setOverseerSeat({ canvasName: "workshop", nodeId: "seat", overseer: false });
    expect(modelCommand).toHaveBeenCalledExactlyOnceWith({
      _tag: "GrantOverseer",
      canvas: "workshop",
      id: "seat",
      overseer: false,
    });
  });

  it("passes on main's refusal", async () => {
    modelCommand.mockRejectedValueOnce(new Error("Only the operator changes overseer authority"));
    await expect(
      setOverseerSeat({ canvasName: "workshop", nodeId: "seat", overseer: true }),
    ).rejects.toThrow("Only the operator");
  });

  it("refuses when the IPC method is absent", async () => {
    vi.stubGlobal("window", { junto: {} });
    await expect(
      setOverseerSeat({ canvasName: "workshop", nodeId: "seat", overseer: true }),
    ).rejects.toBeInstanceOf(OverseerSetError);
    expect(flushCanvasEdits).not.toHaveBeenCalled();
  });
});
