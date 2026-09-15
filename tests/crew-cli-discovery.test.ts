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
import { MsgPromptArgs, MsgSentArgs } from "../src/shared/work-control";
import { SeatReadArgs, SeatWaitArgs, TaskWaitArgs } from "../src/shared/seat-control";
import { MANAGED_PROMPT_IMMEDIATE_MAX } from "../src/shared/managed-prompt";

const crewSchemas = [
  ["msg.prompt", MsgPromptArgs],
  ["msg.sent", MsgSentArgs],
  ["seat.wait", SeatWaitArgs],
  ["seat.read", SeatReadArgs],
  ["tasks.wait", TaskWaitArgs],
] as const;

describe("crew CLI discovery", () => {
  it.each(crewSchemas)("%s publishes the canonical schema and executable inputs", (id, schema) => {
    const contracts = allSchemas.filter((entry) => entry.command_id === id);
    expect(contracts).toHaveLength(1);
    const contract = contracts[0]!;
    expect(contract.schema).toBe(schema);
    const rendered = renderSchemaContract(contract);
    expect(rendered.input_modes).toEqual(["inline-json", "@file", "stdin"]);
    expect(rendered.accepts_batch).toBe(false);
    expect(rendered.schema).toEqual(Schema.toJsonSchemaDocument(schema).schema);

    const capabilities = commandCapabilities.filter((entry) => entry.command_id === id);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]!.schemas).toEqual([contract]);
    const examples = allExamples.filter((entry) => entry.command_id === id);
    expect(examples.length).toBeGreaterThan(0);
    expect(capabilities[0]!.examples).toEqual(examples);
    for (const example of examples) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(schema)(example.input))).toBe(true);
      expect(example.args?.slice(0, 2).join(" ")).toBe(contract.command);
      const jsonArgument = example.args?.find((arg) => arg.startsWith("{"));
      if (jsonArgument !== undefined) expect(JSON.parse(jsonArgument)).toEqual(example.input);
    }
  });

  it("keeps prompt creation and retry disjoint through the public JSON loader", async () => {
    const schema = MsgPromptArgs;
    expect(allSchemas.find((entry) => entry.command_id === "msg.prompt")!.schema).toBe(schema);
    for (const input of [
      { target: "peer", text: "Review the change." },
      { target: "peer", messageId: "mail-1", fallback: "notice" },
      // Oversize bodies remain valid durable input: admission decides refusal
      // or the explicitly requested notice fallback after the row exists.
      { target: "peer", text: "a".repeat(MANAGED_PROMPT_IMMEDIATE_MAX + 1), fallback: "notice" },
    ]) {
      await expect(Effect.runPromise(loadJsonInput(schema, JSON.stringify(input)))).resolves.toEqual(input);
    }
    for (const input of [
      { target: "peer", messageId: "mail-1", text: "Replacement body" },
      { target: "peer", messageId: "mail-1", subject: "Replacement subject" },
      { target: "peer", messageId: "mail-1", refs: [] },
      { target: "peer", messageId: "" },
      { target: "peer", text: "Review the change.", interrupt: true },
      { target: "peer", text: "Review the change.", fallback: "interrupt" },
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
      { ...connected[0], invocations: [{ port: "msg.prompt", command: "vellum-command msg prompt", discover: "vellum-command schema show msg.prompt" }] },
      { ...connected[1], invocations: [{ port: "seat.wait", command: "vellum-command seat wait", discover: "vellum-command schema show seat.wait" }] },
      { ...connected[2], invocations: [{ port: "terminal.read", command: "vellum-command seat read", discover: "vellum-command schema show seat.read" }] },
      { ...connected[3], invocations: [{ port: "verdict.post", command: "vellum-command verdict post", discover: "vellum-command verdict post --help" }] },
      connected[4],
      connected[5],
    ];
    const original = structuredClone(connected);
    expect(annotateCapabilityInvocations({ connected }).connected).toEqual(expected);
    expect(annotateCapabilityInvocations({ capabilities: { connected } }).capabilities.connected).toEqual(expected);
    expect(connected).toEqual(original);
  });
});
