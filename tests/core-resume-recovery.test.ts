import { mkdtemp, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { MachineCoreMail } from "../src/main/core-runtime";
import { startCore } from "../src/main/junto/core";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { seatStateRuntime } from "../src/main/junto/term/agent-state/runtime";
import { terminalObserverPlane } from "../src/main/junto/term/observer";
import { termPlane } from "../src/main/junto/term/plane";

const frame = (lines: readonly string[]) => ({ lines, signals: { modes: { bracketedPaste: false } } }) as never;
const SELECTOR = ["Resume from summary", "Resume full session as-is", "Enter to confirm", "Esc to cancel"];

it("a machine core with no window accepts Claude's resume selector, once per generation", async () => {
  const home = await mkdtemp("/tmp/junto-core-resume-");
  const core = await startCore({ home, build: "a".repeat(64), bundles: {} });
  try {
    const { seats } = await core.runtime.runPromise(MachineCoreMail);
    const submit = vi.spyOn(seats.drive, "submitRecoveryCr").mockResolvedValue(true);
    let harness = "claude";
    vi.spyOn(seatStateRuntime.machine, "getSlot").mockImplementation(() => ({ harness }) as never);
    vi.spyOn(termPlane.host, "get").mockReturnValue({ status: "running", epoch: "e1" } as never);
    const screen = vi.spyOn(terminalObserverPlane, "snapshot").mockReturnValue(frame(SELECTOR));
    const seatEvent = (state: AgentSeatStateEvent["state"]): void => {
      const listeners = (seatStateRuntime as unknown as { eventListeners: Set<(event: AgentSeatStateEvent) => void> }).eventListeners;
      for (const listener of listeners) listener({ bindingId: "seat", epoch: "e1", state, reason: "test", confidence: "high", at: 1 });
    };

    seatEvent("idle");
    expect(submit).not.toHaveBeenCalled();
    harness = "codex";
    seatEvent("attention");
    expect(submit).not.toHaveBeenCalled();
    harness = "claude";
    screen.mockReturnValue(frame(["Do you want to proceed?", "Enter to select"]));
    seatEvent("attention");
    expect(submit).not.toHaveBeenCalled();

    screen.mockReturnValue(frame(SELECTOR));
    seatEvent("attention");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("seat");
    seatEvent("attention");
    expect(submit).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await core.close();
    await rm(home, { recursive: true, force: true });
  }
});
