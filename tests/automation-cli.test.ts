import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AUTOMATION_OPS } from "../src/shared/automation-control";
import { allExamples, allSchemas, commandCapabilities, renderSchemaContract } from "../src/cli/core/discovery";
import { automationExamples, automationSchemas } from "../src/cli/commands/automation";

describe("junto automation discovery", () => {
  it("offers one schema and one capability per verb, under the op's own id", () => {
    const ids = AUTOMATION_OPS.map((op) => op);
    expect(allSchemas.filter((s) => s.command_id.startsWith("automation.")).map((s) => s.command_id).sort()).toEqual([...ids].sort());
    expect(commandCapabilities.filter((c) => c.command_id.startsWith("automation.")).map((c) => c.command_id).sort()).toEqual(
      [...ids].sort(),
    );
  });

  it("prints every schema as JSON Schema, inline, @file or stdin", () => {
    for (const contract of automationSchemas) {
      const rendered = renderSchemaContract(contract);
      expect(rendered.input_modes).toEqual(["inline-json", "@file", "stdin"]);
      expect(rendered.schema).toBeTypeOf("object");
    }
  });

  it("has examples that decode under their own schema", () => {
    for (const example of automationExamples) {
      const contract = automationSchemas.find((s) => s.command_id === example.command_id)!;
      expect(() => Schema.decodeUnknownSync(contract.schema as never, { onExcessProperty: "error" })(example.input), example.name).not.toThrow();
      expect(example.args?.[0]).toBe("automation");
      expect(allExamples).toContainEqual(example);
    }
  });
});
