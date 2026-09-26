import { describe, expect, it } from "vitest";
import {
  deadStateCopy,
  isAgentTerminalSeat,
  killActionCopy,
  terminalSurfaceEyebrow,
} from "../src/renderer/lib/terminal-kill-ux";

describe("terminal kill UX copy", () => {
  it("labels shell stop as stopping the process, not kill session", () => {
    const idle = killActionCopy({ phase: "idle", agentSeat: false });
    expect(idle.label).toBe("Stop process");
    expect(idle.ariaLabel).toBe("Stop this terminal's process");
    expect(idle.title.toLowerCase()).toContain("confirm");
    expect(idle.title.toLowerCase()).not.toContain("kill session");

    const armed = killActionCopy({ phase: "armed", agentSeat: false });
    expect(armed.label).toBe("Stop process?");
    expect(armed.title.toLowerCase()).toContain("click again");
  });

  it("says an agent seat stop ends the agent's process and keeps the node", () => {
    const idle = killActionCopy({ phase: "idle", agentSeat: true });
    expect(idle.ariaLabel).toBe("Stop this agent's process");
    expect(idle.title).toMatch(/stays on the canvas/);

    const armed = killActionCopy({ phase: "armed", agentSeat: true });
    expect(armed.title).toBe("Click again to stop this agent's process. The node stays on the canvas.");
    expect(armed.ariaLabel).toBe("Confirm: stop this agent's process");
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
    expect(agent.detail).toMatch(/unassign/i);
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
