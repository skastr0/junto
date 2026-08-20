import { describe, expect, it } from "vitest";
import {
  BASE_CONTRACT,
  buildInjectionText,
} from "../src/shared/managed-terminal-injection";

const seatWithTasks = {
  seatBound: true,
  connected: true,
  seatRef: "agent-1",
  connectedTargets: [{ id: "tasks-main", kind: "task" }],
} as const;

describe("doctrine — pipeline verbs", () => {
  it("teaches the tasks slot every verb a station move needs", () => {
    const text = buildInjectionText(seatWithTasks)!;
    for (const command of [
      `vellum-command tasks show '{"target":"tasks-main","task":"<taskId>"}'`,
      `vellum-command tasks claims '{"target":"tasks-main","task":"<taskId>"}'`,
      `vellum-command tasks board '{"target":"tasks-main","task":"<taskId>"}'`,
    ]) {
      expect(text).toContain(command);
    }
  });

  it("states how claims are answered and how a task moves on", () => {
    const text = buildInjectionText(seatWithTasks)!;
    expect(text).toContain("### Claims — the station's standing law");
    expect(text).toContain("completionEvidence.responses");
    expect(text).toContain("completionEvidence.claimWaivers");
    expect(text).toContain("### Forwarding — one station at a time");
    expect(text).toContain('"next":"<station>"');
    expect(text).toContain('"defect"');
    expect(text).toContain('"holdFor":"12h"');
  });

  it("puts rulings in the base contract, where every seat sees it", () => {
    expect(BASE_CONTRACT).toContain("vellum-command rulings");
    const isolated = buildInjectionText({ seatBound: true, connected: false })!;
    expect(isolated).toContain("vellum-command rulings");
    expect(isolated).not.toContain("### Edge contract — tasks");
  });
});
