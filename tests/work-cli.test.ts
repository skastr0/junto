import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import {
  TasksClaimArgs,
  TasksCreateArgs,
  TasksUpdateArgs,
  ArtifactPublishCliArgs,
  PreambleArgs,
} from "../src/shared/work-control";
import { loadBatchJsonInput, loadJsonInput } from "../src/cli/core/json";
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
  renderSchemaContract,
} from "../src/cli/core/discovery";
import { materializeArtifactParts } from "../src/cli/core/artifact-parts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("work CLI envelopes", () => {
  it("success is exactly one JSON object on stdout shape", () => {
    const text = renderSuccessEnvelope("tasks claim", { id: "t1" });
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ ok: true, command: "tasks claim", data: { id: "t1" } });
    // single line, no trailing prose
    expect(text.includes("\n")).toBe(false);
  });

  it("failure lands on stderr shape with typed error", () => {
    const err = new InputError({
      message: "bad",
      path: "target",
      hint: "connect the nodes",
    });
    const text = renderFailureEnvelope("tasks claim", err);
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("tasks claim");
    expect(parsed.error.type).toBe("InputError");
    expect(parsed.error.details.path).toBe("target");
  });
});

describe("work CLI json input modes", () => {
  it("decodes inline / @file / batch array", async () => {
    const inline = await Effect.runPromise(
      loadJsonInput(TasksClaimArgs, '{"target":"n7","task":"t1"}'),
    );
    expect(inline.target).toBe("n7");
    await expect(
      Effect.runPromise(
        loadJsonInput(
          TasksClaimArgs,
          '{"target":"n7","task":"t1","actor":"agent"}',
        ),
      ),
    ).rejects.toThrow(/actor|unexpected/i);

    const dir = mkdtempSync(join(tmpdir(), "vellum-cli-json-"));
    const file = join(dir, "claim.json");
    writeFileSync(file, JSON.stringify({ target: "n7", task: "t2" }));
    const fromFile = await Effect.runPromise(loadJsonInput(TasksClaimArgs, `@${file}`));
    expect(fromFile.task).toBe("t2");

    const batch = await Effect.runPromise(
      loadBatchJsonInput('[{"target":"n7","task":"t1"},{"target":"n7","task":"t2"}]'),
    );
    expect(batch).toHaveLength(2);
  });

  it("tasks.create accepts the same authoring fields as task/proposal domain", async () => {
    const created = await Effect.runPromise(
      loadJsonInput(
        TasksCreateArgs,
        JSON.stringify({
          target: "n7",
          brief: "Ship media migration graph",
          reason: "needs prior content-ref work complete",
          dependsOn: ["t_prereq"],
          finishCriteria: {
            description: "graph claimable",
            git: { minCommits: 1 },
          },
          media: [
            {
              kind: "raw",
              bytesBase64: Buffer.from("png").toString("base64"),
              mediaType: "image/png",
            },
          ],
          metadata: {
            title: "Media migration graph",
            details: "Wire ContentRef media and make the graph claimable.",
          },
        }),
      ),
    );
    expect(created.dependsOn).toEqual(["t_prereq"]);
    expect(created.finishCriteria).toEqual({
      description: "graph claimable",
      git: { minCommits: 1 },
    });
    expect(created.media).toHaveLength(1);
    expect(created.media?.[0]?.kind).toBe("raw");
    expect(created.metadata?.details).toBe(
      "Wire ContentRef media and make the graph claimable.",
    );

    // missing description rejected
    await expect(
      Effect.runPromise(
        loadJsonInput(
          TasksCreateArgs,
          '{"target":"n7","brief":"x","metadata":{"title":"x"}}',
        ),
      ),
    ).rejects.toThrow(/description|details/i);

    // excess properties still rejected
    await expect(
      Effect.runPromise(
        loadJsonInput(
          TasksCreateArgs,
          '{"target":"n7","brief":"x","metadata":{"details":"ctx"},"approvedTaskId":"t1"}',
        ),
      ),
    ).rejects.toThrow(/approvedTaskId|unexpected/i);
  });

  it("decodes the seat-local preamble input and rejects excess fields", async () => {
    const parsed = await Effect.runPromise(
      loadJsonInput(PreambleArgs, '{"text":"checking the task"}'),
    );
    expect(parsed.text).toBe("checking the task");
    await expect(
      Effect.runPromise(
        loadJsonInput(PreambleArgs, '{"text":"x","target":"agent"}'),
      ),
    ).rejects.toThrow(/target|unexpected/i);
  });
});

describe("work CLI batch outcomes", () => {
  it("preserves order, indexes, partial_failure exit semantics", async () => {
    const result = await Effect.runPromise(
      runMutationBatch({
        input: JSON.stringify([
          { target: "n7", task: "ok", state: "completed" },
          { target: "n7", task: "bad", state: "completed" },
          { target: "n7", task: "ok2", state: "working" },
        ]),
        concurrency: 2,
        itemSchema: TasksUpdateArgs,
        run: (item) =>
          item.task === "bad"
            ? Effect.fail(new InputError({ message: "boom", path: "task" }))
            : Effect.succeed({ id: item.task, state: item.state }),
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
        input: '{"target":"n7","task":"t1","state":"completed"}',
        concurrency: 0,
        itemSchema: TasksUpdateArgs,
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
      const related = allExamples.filter((e) => e.command_id === contract.command_id);
      for (const example of related) {
        if (example.input !== undefined && !Array.isArray(example.input)) {
          const decoded = Schema.decodeUnknownResult(contract.schema)(example.input);
          expect(Result.isSuccess(decoded)).toBe(true);
        }
      }
    }
  });

  it("discovers the browser surface from schema and live edge grants", () => {
    expect(allSchemas.map((contract) => contract.command_id)).toEqual(
      expect.arrayContaining([
        "browser.pages",
        "browser.open",
        "browser.goto",
        "browser.eval",
        "browser.screenshot",
        "browser.close",
        "browser.stop",
      ]),
    );

    const live = annotateCapabilityInvocations({
      connected: [
        { id: "page-1", grants: ["browser.automate"] },
        { id: "tasks", grants: ["tasks.list"] },
      ],
      capabilities: {
        connected: [{ id: "page-1", grants: ["browser.automate"] }],
      },
    });
    expect(live.connected[0]).toMatchObject({
      id: "page-1",
      invocations: [{
        port: "browser.automate",
        command: "vellum browser",
        discover: "vellum browser pages --json",
      }],
    });
    expect(live.connected[1]).not.toHaveProperty("invocations");
    expect(live.capabilities.connected[0]).toHaveProperty("invocations");
  });

  it("exposes escalation as the sole agent request surface", () => {
    const commandIds = allSchemas.map((contract) => contract.command_id);
    expect(commandIds).toContain("request.escalate");
    expect(commandIds).not.toContain("request.create");
    expect(allExamples.some((example) => example.command_id === "request.create"))
      .toBe(false);
  });

  it("discovers the seat-local preamble command", () => {
    expect(allSchemas.map((contract) => contract.command_id)).toContain("preamble");
    expect(allExamples.some((example) => example.command_id === "preamble")).toBe(true);
  });
});

describe("artifact content admission", () => {
  it("rejects path parts instead of Base64-encoding them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-art-"));
    const path = join(dir, "x.bin");
    writeFileSync(path, Buffer.from([1, 2, 3, 4]));
    await expect(
      Effect.runPromise(
        materializeArtifactParts({
          target: "art1",
          name: "report",
          task: { target: "tasks", id: "task-1" },
          parts: [{ kind: "raw", path }],
        } satisfies Schema.Schema.Type<typeof ArtifactPublishCliArgs>),
      ),
    ).rejects.toThrow(/ContentRef/);
  });

  it("exposes only the exact task reference in artifact publish v2", () => {
    expect(
      allSchemas.find((contract) => contract.command_id === "artifact.publish")
        ?.schema_id,
    ).toBe("artifact.publish.input/v2");

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ArtifactPublishCliArgs, {
          onExcessProperty: "error",
        })({
          target: "art1",
          taskId: "task-1",
          parts: [{ kind: "text", text: "legacy" }],
        }),
      ),
    ).toBe(true);
  });
});
