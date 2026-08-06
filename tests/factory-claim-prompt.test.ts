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
        parts: [{ kind: "text", text: "Ship claim packet contract" }],
      },
    ],
    ...overrides,
  }) as Task;

describe("buildFactoryClaimPrompt", () => {
  it("includes sink target, task id, brief, and copy-paste list/update JSON", () => {
    const sink = "task-01SINKNODE00000000000000";
    const task = baseTask({
      finishCriteria: {
        description: "packet is complete",
        git: { minCommits: 1 },
      },
      metadata: { title: "Claim packet" },
    });
    const text = buildFactoryClaimPrompt({ sinkNodeId: sink, task });

    expect(text).toContain(`[factory claim] task ${task.id}: Ship claim packet contract`);
    expect(text).toContain(`Sink target (tasks node id): ${sink}`);
    expect(text).toContain(`Task id: ${task.id}`);
    expect(text).toContain(`vellum-command tasks list '{"target":"${sink}"}'`);
    expect(text).toContain(
      `vellum-command tasks update '{"target":"${sink}","task":"${task.id}","state":"completed"`,
    );
    expect(text).toContain(
      `vellum-command tasks update '{"target":"${sink}","task":"${task.id}","state":"working"`,
    );
    expect(text).toContain("vellum-command onboard");
    expect(text).toContain("vellum-command escalate");
    expect(text).toContain("Finish criteria (hard gate on complete):");
    expect(text).toContain("packet is complete");
    expect(text).toContain("git: at least 1 commit(s)");
    expect(text).toContain("--- task packet (JSON) ---");
    expect(text).toContain(`"sinkTarget": "${sink}"`);
    expect(text).toContain(`"taskId": "${task.id}"`);
    // Must not tell agents to invent bare CLI without JSON.
    expect(text).not.toMatch(/Run `vellum-command tasks list`(?! ')/u);
  });

  it("embeds enough packet that list is optional to start", () => {
    const text = buildFactoryClaimPrompt({
      sinkNodeId: "n-tasks",
      task: baseTask(),
    });
    const packetStart = text.indexOf("--- task packet (JSON) ---");
    expect(packetStart).toBeGreaterThan(0);
    const json = text.slice(packetStart).split("\n").slice(1).join("\n");
    const packet = JSON.parse(json) as {
      sinkTarget: string;
      taskId: string;
      brief: string;
    };
    expect(packet.sinkTarget).toBe("n-tasks");
    expect(packet.taskId).toBe("01TASKTEST0000000000000000");
    expect(packet.brief).toBe("Ship claim packet contract");
  });
});
