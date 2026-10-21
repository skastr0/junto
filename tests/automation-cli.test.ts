import { describe, expect, it } from "vitest";
import { Effect, Option, Result, Schema } from "effect";
import { AUTOMATION_READ_OPS, AUTOMATION_WRITE_OPS } from "../src/shared/automation-control";
import { decodeOverseerArgs } from "../src/shared/overseer-control";
import { allExamples, allSchemas, commandCapabilities, renderSchemaContract } from "../src/cli/core/discovery";
import { automationExamples, automationSchemas } from "../src/cli/commands/automation";
import { overseerExamples, overseerSchemas } from "../src/cli/commands/overseer";
import { automationWriteArgs } from "../src/cli/commands/overseer-automation";

const OP = "01M5ESM1XHCJ7JYJDBC37MREBZ";

describe("junto automation discovery", () => {
  it("offers seats the reads only, one schema and one capability per verb", () => {
    const ids = [...AUTOMATION_READ_OPS].sort();
    expect(allSchemas.filter((s) => s.command_id.startsWith("automation.")).map((s) => s.command_id).sort()).toEqual(ids);
    expect(commandCapabilities.filter((c) => c.command_id.startsWith("automation.")).map((c) => c.command_id).sort()).toEqual(ids);
  });

  it("puts every write under overseer automation", () => {
    expect(overseerSchemas.filter((s) => s.command_id.startsWith("overseer.automation.")).map((s) => s.command_id)).toEqual(
      AUTOMATION_WRITE_OPS.map((op) => `overseer.${op}`),
    );
  });

  it("prints every schema as JSON Schema, inline, @file or stdin", () => {
    for (const contract of [...automationSchemas, ...overseerSchemas.filter((s) => s.command_id.startsWith("overseer.automation."))]) {
      const rendered = renderSchemaContract(contract);
      expect(rendered.schema, contract.command_id).toBeTypeOf("object");
    }
    for (const contract of automationSchemas) expect(renderSchemaContract(contract).input_modes).toEqual(["inline-json", "@file", "stdin"]);
  });

  it("has examples that decode under their own schema", () => {
    const writes = overseerExamples.filter((example) => example.command_id.startsWith("overseer.automation."));
    expect(writes.length).toBeGreaterThan(0);
    for (const example of [...automationExamples, ...writes]) {
      const contract = [...automationSchemas, ...overseerSchemas].find((s) => s.command_id === example.command_id)!;
      expect(() => Schema.decodeUnknownSync(contract.schema as never, { onExcessProperty: "error" })(example.input), example.name).not.toThrow();
      expect(allExamples).toContainEqual(example);
    }
  });
});

describe("overseer automation writes", () => {
  const create = overseerExamples.find((example) => example.command_id === "overseer.automation.create")!;

  it("mints the opId, names the created automation by it, and fills the defaults", () => {
    const args = Effect.runSync(automationWriteArgs("automation.create", JSON.stringify(create.input), Option.none()));
    const wire = decodeOverseerArgs("automation.create", args);
    if (Result.isFailure(wire)) throw new Error(wire.failure.message);
    expect(wire.success.automationId).toBe(wire.success.opId);
    expect(wire.success.enabled).toBe(false);
    expect(wire.success.limits).toEqual({ minIntervalMs: 60_000, maxPerHour: 12 });
  });

  it("resends under the given opId, so a retried create names the same automation", () => {
    const args = Effect.runSync(automationWriteArgs("automation.create", JSON.stringify(create.input), Option.some(OP)));
    expect(args).toMatchObject({ opId: OP, automationId: OP });
    const run = Effect.runSync(automationWriteArgs("automation.run", JSON.stringify({ target: "A", automation: "x" }), Option.some(OP)));
    expect(Result.isSuccess(decodeOverseerArgs("automation.run", run))).toBe(true);
    expect(Effect.runSyncExit(automationWriteArgs("automation.run", "{}", Option.some("op-1")))._tag).toBe("Failure");
  });
});
