import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import {
  allExamples,
  allSchemas,
  annotateCapabilityInvocations,
  commandCapabilities,
  renderSchemaContract,
} from "../src/cli/core/discovery";
import { loadJsonInput } from "../src/cli/core/json";
import { MsgPromptArgs, MsgSentArgs, VerdictPostArgs } from "../src/shared/work-control";
import { SeatReadArgs, SeatWaitArgs, TaskWaitArgs } from "../src/shared/seat-control";

const crewSchemas = [
  ["msg.prompt", MsgPromptArgs],
  ["msg.sent", MsgSentArgs],
  ["seat.wait", SeatWaitArgs],
  ["seat.read", SeatReadArgs],
  ["tasks.wait", TaskWaitArgs],
  ["verdict.post", VerdictPostArgs],
] as const;

describe("crew CLI discovery", () => {
  it.each(crewSchemas)("%s publishes the canonical schema and executable inputs", (id, schema) => {
    const contracts = allSchemas.filter((entry) => entry.command_id === id);
    expect(contracts).toHaveLength(1);
    const contract = contracts[0]!;
    expect(contract.schema).toBe(schema);
    const rendered = renderSchemaContract(contract);
    expect(rendered.input_modes).toEqual(["inline-json", "@file", "stdin"]);
    expect(rendered.accepts_batch).toBe(id === "verdict.post" || id === "msg.prompt");
    expect(rendered.schema).toEqual(Schema.toJsonSchemaDocument(schema).schema);

    const capabilities = commandCapabilities.filter((entry) => entry.command_id === id);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]!.schemas).toEqual([contract]);
    const examples = allExamples.filter((entry) => entry.command_id === id);
    expect(examples.length).toBeGreaterThan(0);
    expect(capabilities[0]!.examples).toEqual(examples);
    for (const example of examples) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(schema)(example.input))).toBe(true);
      expect(example.args?.slice(0, contract.command.split(" ").length).join(" ")).toBe(contract.command);
      const jsonArgument = example.args?.find((arg) => arg.startsWith("{"));
      if (jsonArgument !== undefined) expect(JSON.parse(jsonArgument)).toEqual(example.input);
    }
  });

  it("takes a prompt as target and full text, of any length, with nothing to retry", async () => {
    const schema = MsgPromptArgs;
    expect(allSchemas.find((entry) => entry.command_id === "msg.prompt")!.schema).toBe(schema);
    for (const input of [
      { target: "peer", text: "Review the change." },
      { target: "peer", text: "a".repeat(5_000) },
    ]) {
      await expect(Effect.runPromise(loadJsonInput(schema, JSON.stringify(input)))).resolves.toEqual(input);
    }
    for (const input of [
      { target: "peer", messageId: "mail-1" },
      { target: "peer", text: "Review the change.", fallback: "notice" },
      { target: "peer", text: "Review the change.", interrupt: true },
    ]) {
      await expect(Effect.runPromise(loadJsonInput(schema, JSON.stringify(input)))).rejects.toThrow();
    }
  });

  it("preserves bounded observation and generation requirements in discovered inputs", async () => {
    const invalid = [
      ["seat.wait", SeatWaitArgs, { target: "peer", any: true, until: "idle" }],
      ["seat.wait", SeatWaitArgs, { until: "idle" }],
      ["seat.wait", SeatWaitArgs, { target: "peer", until: "idle", timeoutMs: 600001 }],
      ["seat.read", SeatReadArgs, { target: "peer", since: 12 }],
      ["seat.read", SeatReadArgs, { target: "peer", lines: 2001 }],
      ["seat.read", SeatReadArgs, { target: "peer", follow: true, maxSeconds: 601 }],
      ["seat.read", SeatReadArgs, { target: "peer", input: "\r" }],
      ["tasks.wait", TaskWaitArgs, { target: "tasks", task: "t1", until: "completed" }],
    ] as const;
    for (const [id, schema, input] of invalid) {
      expect(allSchemas.find((entry) => entry.command_id === id)!.schema).toBe(schema);
      await expect(Effect.runPromise(loadJsonInput(schema, JSON.stringify(input)))).rejects.toThrow();
    }
  });

  it("offers crew invocation hints only for the exact live held grants", () => {
    const connected = [
      { target: "peer-prompt", grants: ["msg.prompt"] },
      { target: "peer-wait", grants: ["seat.wait"] },
      { target: "peer-read", grants: ["terminal.read"] },
      { target: "review-target", grants: ["verdict.post"] },
      { target: "ordinary-peer", grants: ["msg.send", "msg.read"] },
      { target: "wrong-vocabulary", grants: ["seat.read", "reviews"] },
    ];
    const expected = [
      { ...connected[0], invocations: [{ port: "msg.prompt", command: "junto msg send --prompt", discover: "junto schema show msg.prompt" }] },
      { ...connected[1], invocations: [{ port: "seat.wait", command: "junto seat wait", discover: "junto schema show seat.wait" }] },
      { ...connected[2], invocations: [{ port: "terminal.read", command: "junto seat read", discover: "junto schema show seat.read" }] },
      { ...connected[3], invocations: [{ port: "verdict.post", command: "junto verdict post", discover: "junto schema show verdict.post" }] },
      connected[4],
      connected[5],
    ];
    const original = structuredClone(connected);
    expect(annotateCapabilityInvocations({ connected }).connected).toEqual(expected);
    expect(annotateCapabilityInvocations({ capabilities: { connected } }).capabilities.connected).toEqual(expected);
    expect(connected).toEqual(original);
  });
});
