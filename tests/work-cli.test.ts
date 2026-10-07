import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import { MsgPromptArgs, PreambleArgs } from "../src/shared/work-control";
import { loadBatchJsonInput, loadJsonInput } from "../src/cli/core/json";
import {
  loadSignalRaiseArgs as loadSignalRaiseArgsWithSocket,
  planSignalInvocation,
} from "../src/cli/core/signal-input";
import { WorkSocket } from "../src/cli/core/socket";
import { runMutationBatch } from "../src/cli/core/batch";
import {
  renderFailureEnvelope,
  renderSuccessEnvelope,
  toErrorDetails,
} from "../src/cli/core/output";
import { InputError } from "../src/cli/core/errors";
import {
  allSchemas,
  allExamples,
  annotateCapabilityInvocations,
  commandCapabilities,
  renderSchemaContract,
} from "../src/cli/core/discovery";
import { BROWSER_ENABLED } from "../src/shared/features";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// No file is attached in this suite, so the socket is never called.
const loadSignalRaiseArgs = (...args: Parameters<typeof loadSignalRaiseArgsWithSocket>) =>
  loadSignalRaiseArgsWithSocket(...args).pipe(
    Effect.provideService(WorkSocket, WorkSocket.of({ call: () => Effect.die("no socket in this suite") })),
  );

describe("work CLI envelopes", () => {
  it("success is exactly one JSON object on stdout shape", () => {
    const text = renderSuccessEnvelope("msg send", { id: "t1" });
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      ok: true,
      command: "msg send",
      data: { id: "t1" },
    });
    // single line, no trailing prose
    expect(text.includes("\n")).toBe(false);
  });

  it("failure lands on stderr shape with typed error", () => {
    const err = new InputError({
      message: "bad",
      path: "target",
      hint: "connect the nodes",
    });
    const text = renderFailureEnvelope("msg send", err);
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("msg send");
    expect(parsed.error.type).toBe("InputError");
    expect(parsed.error.details.path).toBe("target");
  });
});

describe("work CLI json input modes", () => {
  it("decodes inline / @file / batch array", async () => {
    const inline = await Effect.runPromise(
      loadJsonInput(MsgPromptArgs, '{"target":"n7","text":"t1"}'),
    );
    expect(inline.target).toBe("n7");
    await expect(
      Effect.runPromise(
        loadJsonInput(
          MsgPromptArgs,
          '{"target":"n7","text":"t1","actor":"agent"}',
        ),
      ),
    ).rejects.toThrow(/actor|unexpected/i);

    const dir = mkdtempSync(join(tmpdir(), "junto-cli-json-"));
    const file = join(dir, "send.json");
    writeFileSync(file, JSON.stringify({ target: "n7", text: "t2" }));
    const fromFile = await Effect.runPromise(
      loadJsonInput(MsgPromptArgs, `@${file}`),
    );
    expect(fromFile.text).toBe("t2");

    const batch = await Effect.runPromise(
      loadBatchJsonInput(
        '[{"target":"n7","text":"t1"},{"target":"n7","text":"t2"}]',
      ),
    );
    expect(batch).toHaveLength(2);
  });

  it("decodes the seat-local preamble input and rejects excess fields", async () => {
    const parsed = await Effect.runPromise(
      loadJsonInput(PreambleArgs, '{"text":"checking the build"}'),
    );
    expect(parsed.text).toBe("checking the build");
    await expect(
      Effect.runPromise(
        loadJsonInput(PreambleArgs, '{"text":"x","target":"agent"}'),
      ),
    ).rejects.toThrow(/target|unexpected/i);
  });

});

describe("agent signal CLI input", () => {
  it("reads a plain sentence as the text, with --detail inline", async () => {
    const args = await Effect.runPromise(
      loadSignalRaiseArgs("blocked", "Need the staging key.", "Vault path is empty."),
    );
    expect(args).toEqual({
      kind: "blocked",
      text: "Need the staging key.",
      detail: "Vault path is empty.",
    });
  });

  it("reads a JSON object inline, with the kind set by the command", async () => {
    const args = await Effect.runPromise(
      loadSignalRaiseArgs("feedback", '{"text":"ready for review","detail":"## notes"}', undefined),
    );
    expect(args).toEqual({ kind: "feedback", text: "ready for review", detail: "## notes" });
  });

  it("reads the sentence and detail from files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junto-signal-cli-"));
    try {
      const input = join(dir, "signal.json");
      const detail = join(dir, "detail.md");
      writeFileSync(input, '{"text":"pick a database"}');
      writeFileSync(detail, "Postgres or SQLite?");
      const args = await Effect.runPromise(
        loadSignalRaiseArgs("escalate", `@${input}`, `@${detail}`),
      );
      expect(args).toEqual({
        kind: "escalate",
        text: "pick a database",
        detail: "Postgres or SQLite?",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the kind inside JSON, an empty sentence, and detail given twice", async () => {
    await expect(
      Effect.runPromise(loadSignalRaiseArgs("escalate", '{"text":"x","kind":"blocked"}', undefined)),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(loadSignalRaiseArgs("escalate", "  ", undefined)),
    ).rejects.toThrow(/one sentence/);
    await expect(
      Effect.runPromise(loadSignalRaiseArgs("escalate", '{"text":"x","detail":"a"}', "b")),
    ).rejects.toThrow(/detail given twice/);
  });

  it("lets stdin feed the input or --detail, never both", () => {
    const both = planSignalInvocation("-", "-");
    expect(both.ok).toBe(false);
    const detailOnly = planSignalInvocation("Need a key.", "-");
    expect(detailOnly.ok && detailOnly.plan).toMatchObject({
      input: { kind: "inline", json: false },
      detail: { kind: "stdin" },
    });
    const jsonStdin = planSignalInvocation("-", undefined);
    expect(jsonStdin.ok && jsonStdin.plan.input).toMatchObject({ kind: "stdin", json: true });
  });
});

describe("work CLI batch outcomes", () => {
  it("preserves order, indexes, partial_failure exit semantics", async () => {
    const result = await Effect.runPromise(
      runMutationBatch({
        input: JSON.stringify([
          { target: "n7", text: "ok" },
          { target: "n7", text: "bad" },
          { target: "n8", text: "ok2" },
        ]),
        concurrency: 2,
        itemSchema: MsgPromptArgs,
        run: (item) =>
          item.text === "bad"
            ? Effect.fail(new InputError({ message: "boom", path: "text" }))
            : Effect.succeed({ target: item.target, text: item.text }),
      }),
    );

    expect(result.outcome).toBe("partial_failure");
    expect(result.total).toBe(3);
    expect(result.success_count).toBe(2);
    expect(result.error_count).toBe(1);
    expect(result.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[1]?.ok).toBe(false);
    expect(result.results[2]?.ok).toBe(true);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("rejects concurrency <= 0", async () => {
    const outcome = await Effect.runPromise(
      runMutationBatch({
        input: '{"target":"n7","text":"t1"}',
        concurrency: 0,
        itemSchema: MsgPromptArgs,
        run: () => Effect.succeed({}),
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(toErrorDetails(outcome.failure).type).toBe("InputError");
    }
  });
});

describe("schema/examples from validating schemas", () => {
  it("every schema contract produces JSON Schema", () => {
    for (const contract of allSchemas) {
      const rendered = renderSchemaContract(contract);
      expect(rendered.schema_id).toBe(contract.schema_id);
      expect(rendered.schema).toBeTypeOf("object");
      // examples reference real command ids
      const related = allExamples.filter(
        (e) => e.command_id === contract.command_id,
      );
      for (const example of related) {
        if (example.input !== undefined && !Array.isArray(example.input)) {
          const decoded = Schema.decodeUnknownResult(contract.schema as never)(
            example.input,
          );
          expect(Result.isSuccess(decoded)).toBe(true);
        }
      }
    }
  });

  it("matches browser discovery to the compiled product surface", () => {
    const browserCommandIds = [
      "browser.pages",
      "browser.open",
      "browser.goto",
      "browser.eval",
      "browser.screenshot",
      "browser.close",
      "browser.stop",
    ];
    const schemaIds = allSchemas.map((contract) => contract.command_id);
    const capabilityIds = commandCapabilities.map(
      (capability) => capability.command_id,
    );
    const exampleIds = allExamples.map((example) => example.command_id);

    if (BROWSER_ENABLED) {
      expect(schemaIds).toEqual(expect.arrayContaining(browserCommandIds));
      expect(capabilityIds).toEqual(expect.arrayContaining(browserCommandIds));
      expect(exampleIds).toEqual(
        expect.arrayContaining(["browser.pages", "browser.open"]),
      );
    } else {
      expect(schemaIds).not.toEqual(expect.arrayContaining(browserCommandIds));
      expect(capabilityIds).not.toEqual(
        expect.arrayContaining(browserCommandIds),
      );
      expect(exampleIds).not.toEqual(
        expect.arrayContaining(["browser.pages", "browser.open"]),
      );
    }

    const live = annotateCapabilityInvocations({
      connected: [
        { id: "page-1", grants: ["browser.automate"] },
        { id: "peer", grants: ["msg.send"] },
      ],
      capabilities: {
        connected: [{ id: "page-1", grants: ["browser.automate"] }],
      },
    });
    if (BROWSER_ENABLED) {
      expect(live.connected[0]).toMatchObject({
        id: "page-1",
        invocations: [
          {
            port: "browser.automate",
            command: "junto browser",
            discover: "junto browser pages --json",
          },
        ],
      });
    } else {
      expect(live.connected[0]).not.toHaveProperty("invocations");
    }
    expect(live.connected[1]).not.toHaveProperty("invocations");
    if (BROWSER_ENABLED) {
      expect(live.capabilities.connected[0]).toHaveProperty("invocations");
    } else {
      expect(live.capabilities.connected[0]).not.toHaveProperty("invocations");
    }
  });

  it("exposes agent signals as the sole way a seat raises its hand", () => {
    const commandIds = allSchemas.map((contract) => contract.command_id);
    for (const id of ["signal.escalate", "signal.blocked", "signal.feedback", "signal.list", "signal.clear"]) {
      expect(commandIds).toContain(id);
    }
    expect(commandIds).not.toContain("request.escalate");
    expect(commandIds).not.toContain("request.create");
    expect(
      allExamples.some((example) => example.command_id === "request.create"),
    ).toBe(false);
  });

  it("discovers the seat-local preamble command", () => {
    expect(allSchemas.map((contract) => contract.command_id)).toContain(
      "preamble",
    );
    expect(
      allExamples.some((example) => example.command_id === "preamble"),
    ).toBe(true);
  });
});
