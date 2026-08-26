import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allExamples,
  renderSchemaContract,
  tasksCreateSchema,
} from "../src/cli/core/discovery";
import { buildNodeKindDoc } from "../src/shared/vellum-docs";

const taskCreateDiscoveryCopy = (): string => {
  const schema = renderSchemaContract(tasksCreateSchema);
  const examples = allExamples.filter(
    (example) => example.command_id === "tasks.create",
  );
  return [
    schema.description,
    ...examples.flatMap((example) => [example.name, example.description]),
  ].join("\n");
};

describe("stable planning Task contract copy", () => {
  it("publishes the stable-ID contract through CLI discovery", () => {
    const copy = taskCreateDiscoveryCopy();

    expect(copy).toContain("stable TaskId");
    expect(copy).toContain("dependsOn accepts existing TaskIds only");
    expect(copy).toContain("local Command Center approval");
    expect(copy).toContain("promotes that same TaskId");
    expect(copy).toContain("Station protocol 1 has no Task approval action");
    expect(copy).toContain("refuses a Remote home");
    expect(copy).toContain("Legacy proposal events remain immutable");
    expect(copy).toContain("same-ID gated Tasks");
    expect(copy).toContain("never infers dependencies");
    expect(copy).toContain("auto-rewires documentary proposals");
    expect(copy).not.toContain("Create an attributed proposal");
    expect(copy).not.toContain("minted Task on approve");
  });

  it("publishes the same contract in generated task-node docs", () => {
    const copy = buildNodeKindDoc("task");

    expect(copy).toBeDefined();
    expect(copy).toContain("one stable TaskId");
    expect(copy).toContain("dependsOn contains TaskIds only");
    expect(copy).toContain("local Command Center approval");
    expect(copy).toContain("Remote-home operator-gated creation is refused");
    expect(copy).toContain("Legacy proposal events stay immutable history");
    expect(copy).toContain("same-ID gated Tasks");
    expect(copy).toContain("approved and rejected documentary proposals");
    expect(copy).toContain("never infers or rewires dependencies from prose");
    expect(copy).not.toContain("optional proposals");
    expect(copy).not.toContain("proposal is minted");
  });

  it("cements identity, locality, and legacy reconciliation in canonical prose", () => {
    const copy = readFileSync(
      join(process.cwd(), "docs/vellum-protocol.md"),
      "utf8",
    );

    expect(copy).toContain(
      "A planning create is a Task create, not a separate proposal identity",
    );
    expect(copy).toContain("`dependsOn` contains `TaskId` values only");
    expect(copy).toContain("same-region dependency scope");
    expect(copy).toContain("Approval is a local Command Center operation");
    expect(copy).toMatch(/does not mint a\s+replacement Task/);
    expect(copy).toContain("Station protocol 1 has no Task approval action");
    expect(copy).toContain("proposal events remain immutable history");
    expect(copy).toContain("same identifier");
    expect(copy).toContain("fixed point");
    expect(copy).toContain("documentary history");
    expect(copy).toContain("not rematerialized or auto-rewired");
    expect(copy).toContain("never infers an edge from proposal prose");
    expect(copy).not.toContain(
      "Command Center approval may mint a submitted task",
    );
  });
});
