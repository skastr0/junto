import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { AUTOMATION_SIGNALS_ENABLED, CODE_STEPS_ENABLED } from "../src/shared/features";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { AUTOMATION_WRITE_DESCRIPTIONS, automationWriteArgs, codeFilesOf, withSources } from "../src/cli/commands/overseer-automation";
import { AUTOMATION_VALUES, valueRefusal } from "../src/shared/automation";
import { DATE_PATTERN_WORDS, VALUE_FORMATS } from "../src/shared/automation-formats";
import { parseMentionHref } from "../src/shared/mention";

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

  it.runIf(AUTOMATION_SIGNALS_ENABLED)("shows only junto:// links that parse, as mentionLink writes them", () => {
    const shows = overseerExamples.flatMap((example) =>
      ((example.input as { then?: ReadonlyArray<{ show?: ReadonlyArray<string> }> }).then ?? []).flatMap((action) => action.show ?? []),
    );
    expect(shows.length).toBeGreaterThan(0);
    for (const show of shows) expect(parseMentionHref(show), show).toBeDefined();
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

  it("names every value of every trigger, the formats, and the prompt action, in create's and edit's help", () => {
    for (const verb of ["automation.create", "automation.edit"] as const) {
      const help = AUTOMATION_WRITE_DESCRIPTIONS[verb];
      for (const [trigger, names] of Object.entries(AUTOMATION_VALUES)) {
        // An answered watch rides the signal gate (answeredWatchRefusal), so its values are said only where signals are.
        const said = trigger !== "answered" || AUTOMATION_SIGNALS_ENABLED;
        for (const name of names) {
          if (trigger === "answered" && (AUTOMATION_VALUES.signal as ReadonlyArray<string>).includes(name)) continue;
          expect(help.includes(`{{${name}}}`), name).toBe(said);
        }
      }
      expect(help.includes("{{raised.<name>}}"), "raised").toBe(AUTOMATION_SIGNALS_ENABLED);
      for (const format of VALUE_FORMATS) expect(help, format).toContain(format);
      expect(help).toContain("{{fired.at|date:YYYY-MM-DD}}");
      expect(help).toContain(DATE_PATTERN_WORDS);
    }
    const create = AUTOMATION_WRITE_DESCRIPTIONS["automation.create"];
    expect(create).toContain("kind: prompt");
    for (const word of ["labelled", "create-artifact", "append-artifact", "label-artifact", "{fired: true}"]) expect(create).toContain(word);
    // Code steps and the signal action are said only where the build carries them (0.11 gates).
    for (const word of ["kind: code", "{{code.<field>}}"]) expect(create.includes(word), word).toBe(CODE_STEPS_ENABLED);
    const signalWords = [
      "kind: signal", "escalate (a question, waiting on the operator), blocked, or feedback", "notice, only to read", "form?", "kind: artifact, node, title?, labels?, minWords?", "kind: secret, name", "kind: proof",
      "answerTo?", "{kind: seat, to: @seat}", "{kind: document, node, title}", "{kind: append, to: <artifact>}", "id?",
      "{kind: answered, automation: {node, automationId}, step?, signal?}", "one per firing, never merged",
    ];
    for (const word of signalWords) expect(create.includes(word), word).toBe(AUTOMATION_SIGNALS_ENABLED);
    // work went with 0.11/09: escalate with a form asks for the same.
    for (const word of ["notice or work", "dueInMs", "work {"]) expect(create, word).not.toContain(word);
  });

  it.runIf(AUTOMATION_SIGNALS_ENABLED)("has signal examples the save takes: seat kinds, answerTo, an answered watch, values and formats", () => {
    const creates = overseerExamples.filter((example) => example.command_id === "overseer.automation.create");
    const signals = creates.flatMap((example) =>
      ((example.input as { then: ReadonlyArray<{ kind: string; signal?: string; answerTo?: { kind: string } }> }).then).filter((step) => step.kind === "signal"));
    expect(signals.map((step) => step.signal)).toEqual(["escalate", "feedback"]);
    expect(signals.map((step) => step.answerTo?.kind)).toContain("seat");
    const answered = creates.find((example) => (example.input as { trigger: { on?: { kind: string } } }).trigger.on?.kind === "answered");
    expect(answered, "an answered example").toBeDefined();
    // The step it names is the raising example's id, on the same Automations node.
    expect((answered!.input as { trigger: { on: { step: string } } }).trigger.on.step).toBe("writing");
    for (const example of creates) {
      expect(valueRefusal(example.input as never), example.name).toBeUndefined();
    }
    const badFormat = {
      ...(answered!.input as object),
      then: [{ kind: "create-artifact", node: "Reviews", title: "Review {{fired.at|dat:YYYY}}" }],
    };
    expect(valueRefusal(badFormat as never)?.message).toContain("{{fired.at|dat:YYYY}}");
  });

  it("sends a prompt example naming values as written, for main to check against its trigger", () => {
    const prompt = overseerExamples.find((example) => example.name.startsWith("prompt a seat"))!;
    const args = Effect.runSync(writeArgs("automation.create", JSON.stringify(prompt.input), Option.none()));
    const wire = decodeOverseerArgs("automation.create", args);
    if (Result.isFailure(wire)) throw new Error(wire.failure.message);
    expect(wire.success.then).toEqual([{ kind: "prompt", to: "@product-verify", text: "{{task.title}} is done ({{task.link}}), check it in the real app." }]);
  });

  it.runIf(CODE_STEPS_ENABLED)("finds each code step that names a file, by language, and refuses file with source or an unknown language", () => {
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

  it.runIf(CODE_STEPS_ENABLED)("stages a code step's file and sends its ref as source, which the wire takes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junto-code-step-"));
    const file = join(dir, "check.ts");
    await writeFile(file, "export default async () => ({ continue: { status: 'ok' } })\n");
    const ref = { sha256: "b".repeat(64), byteLength: 61, mediaType: "text/typescript" };
    const staged: Array<unknown> = [];
    const stager = WorkSocket.of({ call: (op, args) => Effect.sync(() => (staged.push({ op, args }), { ref })) as never });
    const example = overseerExamples.find((entry) => entry.name.startsWith("check a service"))!;
    const input = { ...(example.input as Record<string, unknown>), then: [{ kind: "code", language: "typescript", file, timeoutMs: 30_000 }, (example.input as { then: unknown[] }).then[1]] };
    try {
      const args = await Effect.runPromise(automationWriteArgs("automation.create", JSON.stringify(input), Option.none()).pipe(Effect.provideService(WorkSocket, stager)));
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({ op: "content.stage", args: { done: { mediaType: "text/typescript" } } });
      const wire = decodeOverseerArgs("automation.create", args);
      if (Result.isFailure(wire)) throw new Error(wire.failure.message);
      expect(wire.success.then[0]).toEqual({ kind: "code", language: "typescript", source: ref, timeoutMs: 30_000 });
      expect(JSON.stringify(args)).not.toContain(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("folds every label a write names, and refuses one in both add and remove at its place in remove", () => {
    const create = {
      target: "A", name: "n",
      trigger: { kind: "change", on: { kind: "artifact", artifact: { node: "Shelf" }, event: "labelled", label: " Review " } },
      then: [
        { kind: "create-artifact", node: "Shelf", title: "t", labels: ["Q4", "draft", "q4"] },
        { kind: "label-artifact", to: { fired: true }, add: ["Shipped"], remove: ["review"] },
      ],
    };
    const args = Effect.runSync(writeArgs("automation.create", JSON.stringify(create), Option.none())) as unknown as typeof create;
    expect(args.trigger.on.label).toBe("review");
    expect(args.then[0]).toMatchObject({ labels: ["draft", "q4"] });
    expect(args.then[1]).toMatchObject({ add: ["shipped"], remove: ["review"] });

    const overlap = { ...create, then: [{ kind: "label-artifact", to: { fired: true }, add: ["a", "b"], remove: ["c", " B "] }] };
    const refused = Effect.runSyncExit(writeArgs("automation.create", JSON.stringify(overlap), Option.none()));
    expect(JSON.stringify(refused)).toContain("then[0].remove[1]");
    const edit = { target: "A", automation: "n", baseVersion: 1, change: { then: [{ kind: "label-artifact", to: "@x", add: ["a//b"] }] } };
    expect(JSON.stringify(Effect.runSyncExit(writeArgs("automation.edit", JSON.stringify(edit), Option.none())))).toContain("change.then[0].add[0]");
  });

  it("checks the write before staging, so one that would be refused sends no bytes", () => {
    calls.length = 0;
    const bad = { target: "A", name: "n", trigger: { kind: "poll", everyMs: 1 }, then: [{ kind: "code", language: "typescript", file: "./missing.ts" }] };
    expect(Effect.runSyncExit(writeArgs("automation.create", JSON.stringify(bad), Option.none()))._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });
});
