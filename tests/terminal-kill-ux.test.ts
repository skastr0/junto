import { describe, expect, it } from "vitest";
import {
  deadStateCopy,
  isAgentTerminalSeat,
  killActionCopy,
  terminalSurfaceEyebrow,
} from "../src/renderer/lib/terminal-kill-ux";

describe("terminal kill UX copy", () => {
  it("labels shell stop as Stop process, not kill session", () => {
    const idle = killActionCopy({ phase: "idle", agentSeat: false });
    expect(idle.label).toBe("Stop");
    expect(idle.ariaLabel).toBe("Stop process");
    expect(idle.title.toLowerCase()).toContain("confirm");
    expect(idle.title.toLowerCase()).not.toContain("kill session");

    const armed = killActionCopy({ phase: "armed", agentSeat: false });
    expect(armed.label).toBe("Confirm");
    expect(armed.title.toLowerCase()).toContain("click again");
  });

  it("names agent-seat severity on arm and idle", () => {
    const idle = killActionCopy({ phase: "idle", agentSeat: true });
    expect(idle.title).toMatch(/agent/i);
    expect(idle.ariaLabel).toBe("Stop agent");

    const armed = killActionCopy({ phase: "armed", agentSeat: true });
    expect(armed.title).toMatch(/agent/i);
  });

  it("shows in-flight Stopping state as disabled", () => {
    const stopping = killActionCopy({ phase: "stopping", agentSeat: false });
    expect(stopping.label).toBe("Stopping…");
    expect(stopping.disabled).toBe(true);
  });

  it("dead overlay distinguishes agent seats", () => {
    const shell = deadStateCopy({ agentSeat: false });
    expect(shell.headline).toBe("Process stopped");
    expect(shell.detail).toMatch(/frozen/i);
    expect(shell.reopenLabel).toBe("Reopen");
    expect(shell.closeViewLabel).toBe("Close view");

    const agent = deadStateCopy({ agentSeat: true });
    expect(agent.headline).toBe("Agent stopped");
    expect(agent.detail).toMatch(/unclaim/i);
  });

  it("detects agent seats from harness or agentKey", () => {
    expect(isAgentTerminalSeat({ harness: "claude" })).toBe(true);
    expect(isAgentTerminalSeat({ agentKey: "local:worker" })).toBe(true);
    expect(isAgentTerminalSeat({ harness: "  " })).toBe(false);
    expect(isAgentTerminalSeat({})).toBe(false);
  });

  it("eyebrow stays plain", () => {
    const line = terminalSurfaceEyebrow("local");
    expect(line).toBe("terminal — local");
  });
});
