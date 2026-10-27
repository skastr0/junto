import { describe, expect, it } from "vitest";
import { decodeTaskFacts } from "../src/shared/task-fact-wire";

const task = {
  id: "01M5YC0000000000000000000B",
  number: 7,
  title: "ship the parser",
  dependsOn: [],
  state: "backlog",
  node: "tasks-docs",
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
};

describe("task facts between machines", () => {
  it("carries a derived task's reference to its origin", () => {
    const facts = [{ kind: "task", task: { ...task, derivedFrom: "01M5YC0000000000000000000A" }, effects: [{ kind: "number-minted", number: 7 }] }];
    expect(decodeTaskFacts(facts)?.[0]?.task.derivedFrom).toBe("01M5YC0000000000000000000A");
  });

  it("folds nothing whose origin is not a task id, or that carries a field it does not know", () => {
    expect(decodeTaskFacts([{ kind: "task", task: { ...task, derivedFrom: "#12" }, effects: [] }])).toBeUndefined();
    expect(decodeTaskFacts([{ kind: "task", task: { ...task, origin: "x" }, effects: [] }])).toBeUndefined();
  });
});
