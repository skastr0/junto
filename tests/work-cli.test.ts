import { describe, expect, it } from "vitest";
import { Effect, Either, Schema } from "effect";
import {
  TasksClaimArgs,
  TasksUpdateArgs,
  ArtifactPublishCliArgs,
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
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(toErrorDetails(outcome.left).type).toBe("InputError");
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
          const decoded = Schema.decodeUnknownEither(contract.schema)(example.input);
          expect(Either.isRight(decoded)).toBe(true);
        }
      }
    }
  });
});

describe("artifact path materialization", () => {
  it("reads path parts to base64 raw parts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-art-"));
    const path = join(dir, "x.bin");
    writeFileSync(path, Buffer.from([1, 2, 3, 4]));
    const wire = await Effect.runPromise(
      materializeArtifactParts({
        target: "art1",
        name: "report",
        task: { target: "tasks", id: "task-1" },
        parts: [{ kind: "raw", path }],
      } satisfies Schema.Schema.Type<typeof ArtifactPublishCliArgs>),
    );
    expect(wire.parts[0]).toEqual({
      kind: "raw",
      bytesBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    expect("path" in (wire.parts[0] as object)).toBe(false);
    expect(wire.task).toEqual({ target: "tasks", id: "task-1" });
  });

  it("exposes only the exact task reference in artifact publish v2", () => {
    expect(
      allSchemas.find((contract) => contract.command_id === "artifact.publish")
        ?.schema_id,
    ).toBe("artifact.publish.input/v2");

    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(ArtifactPublishCliArgs, {
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
