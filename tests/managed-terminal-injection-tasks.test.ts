import { describe, expect, it } from "vitest";
import {
  BASE_CONTRACT,
  buildInjectionText,
} from "../src/shared/managed-terminal-injection";

const seatWithTasks = {
  seatBound: true,
  connected: true,
  seatRef: "agent-1",
  connectedTargets: [{ id: "tasks-main", kind: "task", ports: ["tasks.list", "tasks.update", "tasks.claim"] }],
} as const;

describe("doctrine — task path verbs", () => {
  it("teaches the tasks slot every verb a board move needs", () => {
    const text = buildInjectionText(seatWithTasks)!;
    for (const command of [
      `vellum-command tasks show '{"target":"tasks-main","task":"<taskId>"}'`,
      `vellum-command tasks rules '{"target":"tasks-main","task":"<taskId>"}'`,
      `vellum-command tasks check '{"target":"tasks-main","task":"<taskId>"}'`,
    ]) {
      expect(text).toContain(command);
    }
  });

  it("states how rules are answered and how a task moves on", () => {
    const text = buildInjectionText(seatWithTasks)!;
    expect(text).toContain("### Rules in force");
    expect(text).toContain("completionEvidence.claims");
    expect(text).toContain("completionEvidence.waivers");
    expect(text).toContain("### Path — one board at a time");
    expect(text).toContain('"next":"<board>"');
    expect(text).toContain('"defect"');
    expect(text).toContain('"waitFor":"12h"');
  });

  it("puts rulings in the base contract, where every seat sees it", () => {
    expect(BASE_CONTRACT).toContain("vellum-command rulings");
    const isolated = buildInjectionText({ seatBound: true, connected: false })!;
    expect(isolated).toContain("vellum-command rulings");
    expect(isolated).not.toContain("### Edge contract — tasks");
  });
});
