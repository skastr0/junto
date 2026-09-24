import { describe, expect, it } from "vitest";
import { buildFactoryClaimPrompt } from "../src/shared/factory-claim-prompt";
import type { Task } from "../src/shared/work-model";

const baseTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "01TASKTEST0000000000000000",
    state: "working",
    history: [
      {
        messageId: "01MSGTEST00000000000000000",
        role: "user",
        parts: [{ kind: "text", text: "Ship task briefing contract" }],
      },
    ],
    ...overrides,
  }) as Task;

describe("buildFactoryClaimPrompt", () => {
  it("includes sink target, task id, brief, and copy-paste list/update JSON", () => {
    const sink = "task-01SINKNODE00000000000000";
    const task = baseTask({
      finishCriteria: {
        description: "briefing is complete",
        git: { minCommits: 1 },
      },
      metadata: { title: "Task briefing" },
    });
    const text = buildFactoryClaimPrompt({ boardId: sink, task });

    expect(text).toContain(`Task claimed ${task.id}: Ship task briefing contract`);
    expect(text).toContain(`Board target (Tasks node id): ${sink}`);
    expect(text).toContain(`Task id: ${task.id}`);
    expect(text).toContain(`junto tasks list '{"target":"${sink}"}'`);
    expect(text).toContain(
      `junto tasks update '{"target":"${sink}","task":"${task.id}","state":"completed"`,
    );
    expect(text).toContain(
      `junto tasks update '{"target":"${sink}","task":"${task.id}","state":"working"`,
    );
    expect(text).toContain("junto onboard");
    expect(text).toContain("junto escalate");
    expect(text).toContain("Finish criteria (hard gate on complete):");
    expect(text).toContain("briefing is complete");
    expect(text).toContain("git: at least 1 commit(s)");
    expect(text).toContain("--- task briefing (JSON) ---");
    expect(text).toContain(`"target": "${sink}"`);
    expect(text).toContain(`"taskId": "${task.id}"`);
    // Must not tell agents to invent bare CLI without JSON.
    expect(text).not.toMatch(/Run `junto tasks list`(?! ')/u);
  });

  it("embeds enough briefing that list is optional to start", () => {
    const text = buildFactoryClaimPrompt({
      boardId: "n-tasks",
      task: baseTask(),
    });
    const briefingStart = text.indexOf("--- task briefing (JSON) ---");
    expect(briefingStart).toBeGreaterThan(0);
    const json = text.slice(briefingStart).split("\n").slice(1).join("\n");
    const briefing = JSON.parse(json) as {
      target: string;
      taskId: string;
      brief: string;
    };
    expect(briefing.target).toBe("n-tasks");
    expect(briefing.taskId).toBe("01TASKTEST0000000000000000");
    expect(briefing.brief).toBe("Ship task briefing contract");
  });
});
