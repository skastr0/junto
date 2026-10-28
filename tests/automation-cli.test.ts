import { describe, expect, it } from "vitest";
import { Effect, Option, Result, Schema } from "effect";
import { AUTOMATION_READ_OPS, AUTOMATION_WRITE_OPS } from "../src/shared/automation-control";
import { decodeOverseerArgs } from "../src/shared/overseer-control";
import { allExamples, allSchemas, commandCapabilities, renderSchemaContract } from "../src/cli/core/discovery";
import { AUTOMATION_READ_SCHEMAS, automationExamples, automationRead, automationSchemas } from "../src/cli/commands/automation";
import { WireError } from "../src/cli/core/errors";
import { renderFailureEnvelope } from "../src/cli/core/output";
import { WorkSocket } from "../src/cli/core/socket";
import { overseerExamples, overseerSchemas } from "../src/cli/commands/overseer";
import { automationWriteArgs, codeFilesOf, withSources } from "../src/cli/commands/overseer-automation";

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

  it("describes the writes as they behave: ruled on the editing machine, never queued", () => {
    const writes = overseerSchemas.filter((s) => s.command_id.startsWith("overseer.automation."));
    for (const { command_id, description } of [...writes, ...commandCapabilities.filter((c) => c.command_id.startsWith("automation."))]) {
      expect(description, command_id).not.toMatch(/queued|until .* ships?|answers empty/i);
    }
    for (const { command_id, description } of [...writes, ...automationSchemas]) {
      expect(description, command_id).toContain("refused not_available");
    }
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

describe("junto automation reads off the editing machine", () => {
  // Main's refusal as the socket hands it over (c2f41fbd0).
  const refusal = new WireError({
    type: "InputError",
    message: `automations on "factory" are kept on Studio Mac, the machine that edits it`,
    details: { reason: "not_available", retryable: false, next_step: `Open "factory" on Studio Mac to read or change its automations` },
  });
  const socket = WorkSocket.of({ call: () => Effect.fail(refusal) });

  it("print main's not_available refusal with its next_step, for list, show and history", () => {
    for (const verb of ["list", "show", "history"] as const) {
      const input = JSON.stringify(automationExamples.find((example) => example.command_id === `automation.${verb}`)!.input);
      const exit = Effect.runSyncExit(automationRead(verb, AUTOMATION_READ_SCHEMAS[verb], input, Option.none()).pipe(
        Effect.provideService(WorkSocket, socket),
      ));
      if (exit._tag !== "Failure") throw new Error(`${verb} succeeded`);
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      expect(JSON.parse(renderFailureEnvelope(`automation ${verb}`, failure?._tag === "Fail" ? failure.error : undefined)), verb).toEqual({
        ok: false,
        command: `automation ${verb}`,
        error: {
          type: "InputError",
          message: refusal.message,
          details: { reason: "not_available", retryable: false, next_step: `Open "factory" on Studio Mac to read or change its automations` },
        },
      });
    }
  });
});

describe("overseer automation writes", () => {
  const create = overseerExamples.find((example) => example.command_id === "overseer.automation.create")!;
  // A write with no code file never calls the socket; one that stages records it.
  const calls: Array<{ op: string; args: unknown }> = [];
  const socket = WorkSocket.of({ call: (op, args) => Effect.sync(() => void calls.push({ op, args })).pipe(Effect.andThen(Effect.die("no socket here"))) });
  const writeArgs = (...given: Parameters<typeof automationWriteArgs>) => automationWriteArgs(...given).pipe(Effect.provideService(WorkSocket, socket));

  it("mints the opId, names the created automation by it, and fills the defaults", () => {
    const args = Effect.runSync(writeArgs("automation.create", JSON.stringify(create.input), Option.none()));
    const wire = decodeOverseerArgs("automation.create", args);
    if (Result.isFailure(wire)) throw new Error(wire.failure.message);
    expect(wire.success.automationId).toBe(wire.success.opId);
    expect(wire.success.enabled).toBe(false);
    expect(wire.success.limits).toEqual({ minIntervalMs: 60_000, maxPerHour: 12 });
  });

  it("resends under the given opId, so a retried create names the same automation", () => {
    const args = Effect.runSync(writeArgs("automation.create", JSON.stringify(create.input), Option.some(OP)));
    expect(args).toMatchObject({ opId: OP, automationId: OP });
    const run = Effect.runSync(writeArgs("automation.run", JSON.stringify({ target: "A", automation: "x" }), Option.some(OP)));
    expect(Result.isSuccess(decodeOverseerArgs("automation.run", run))).toBe(true);
    expect(Effect.runSyncExit(writeArgs("automation.run", "{}", Option.some("op-1")))._tag).toBe("Failure");
  });

  it("finds each code step that names a file, by language, and refuses file with source or an unknown language", () => {
    const step = (extra: object) => ({ then: [{ kind: "mail", to: "@a", text: "x" }, { kind: "code", ...extra }] });
    expect(Effect.runSync(codeFilesOf("automation.create", step({ language: "typescript", file: "./a.ts" }))))
      .toEqual([{ index: 1, file: "./a.ts", mediaType: "text/typescript" }]);
    expect(Effect.runSync(codeFilesOf("automation.edit", { change: step({ language: "shell", file: "run.sh" }) })))
      .toEqual([{ index: 1, file: "run.sh", mediaType: "text/x-shellscript" }]);
    // A code step that already names its source stages nothing.
    expect(Effect.runSync(codeFilesOf("automation.create", step({ language: "typescript", source: {} })))).toEqual([]);
    const both = Effect.runSyncExit(codeFilesOf("automation.create", step({ language: "typescript", file: "a.ts", source: {} })));
    expect(JSON.stringify(both)).toContain("then[1].file");
    const python = Effect.runSyncExit(codeFilesOf("automation.edit", { change: step({ language: "python", file: "a.py" }) }));
    expect(JSON.stringify(python)).toContain("change.then[1].language");
  });

  it("swaps each staged file for its ref as source and leaves every other step as written", () => {
    const ref = { sha256: "a".repeat(64), byteLength: 3, mediaType: "text/typescript" } as never;
    const input = { target: "A", then: [{ kind: "mail", to: "@a", text: "x" }, { kind: "code", language: "typescript", file: "a.ts", timeoutMs: 5000 }] };
    expect(withSources("automation.create", input, new Map([[1, ref]]))).toEqual({
      target: "A",
      then: [{ kind: "mail", to: "@a", text: "x" }, { kind: "code", language: "typescript", source: ref, timeoutMs: 5000 }],
    });
    expect(withSources("automation.edit", { change: { then: input.then } }, new Map([[1, ref]]))).toMatchObject({ change: { then: [{}, { source: ref }] } });
  });

  it("checks the write before staging, so one that would be refused sends no bytes", () => {
    calls.length = 0;
    const bad = { target: "A", name: "n", trigger: { kind: "poll", everyMs: 1 }, then: [{ kind: "code", language: "typescript", file: "./missing.ts" }] };
    expect(Effect.runSyncExit(writeArgs("automation.create", JSON.stringify(bad), Option.none()))._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });
});
