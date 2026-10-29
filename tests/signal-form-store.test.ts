/**
 * A signal stores who raised it, when its work is due and what reply it asks
 * for (0.11/07, N1), and reads them back as they were. A row whose column this
 * build cannot decode is left out rather than guessed at, so one bad row
 * never breaks a listing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { artifactLabelOf } from "../src/shared/artifact-labels";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-signal-form-"));
  runtime = ManagedRuntime.make(AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, AgentSignalRepository>) => runtime.runPromise(effect);
const seat = { canvasName: "factory", nodeId: "agent-a" };
const automation = { canvasName: "factory", nodeId: "automations-1" };

describe("a signal's source, timing and form", () => {
  it("stores an automation's work signal and reads it back as it was raised", async () => {
    const form = { kind: "artifact", nodeId: "shelf", title: "Morning pages", labels: [artifactLabelOf("daily")!], minWords: 500 } as const;
    const work = { dueAt: 1_790_000_000_000, urgent: true };
    const source = { kind: "automation", automationId: "01M62Q58WDSXMG4YBXNKR2RB91", nodeId: "automations-1" } as const;
    const raised = await run(
      Effect.flatMap(AgentSignalRepository, (r) => r.raise({ ...automation, kind: "work", text: "Write 500 words.", source, work, form })),
    );
    expect(raised).toMatchObject({ kind: "work", source, work, form });

    const listed = await run(Effect.flatMap(AgentSignalRepository, (r) => r.listCanvas("factory")));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ signalId: raised.signalId, source, work, form });
    const read = await run(Effect.flatMap(AgentSignalRepository, (r) => r.get(raised.signalId)));
    expect(read.form).toEqual(form);
  });

  it("stores a notice with no form and no timing", async () => {
    const raised = await run(
      Effect.flatMap(AgentSignalRepository, (r) =>
        r.raise({
          ...automation,
          kind: "notice",
          text: "A run finished.",
          source: { kind: "automation", automationId: "01M62Q58WDSXMG4YBXNKR2RB91", nodeId: "automations-1" },
        }),
      ),
    );
    expect(raised.kind).toBe("notice");
    expect(raised.form).toBeUndefined();
    expect(raised.work).toBeUndefined();
  });

  it("reads a seat's own signal with no source, and keeps its form", async () => {
    const plain = await run(Effect.flatMap(AgentSignalRepository, (r) => r.raise({ ...seat, kind: "blocked", text: "Need the key." })));
    expect(plain.source).toBeUndefined();

    const raised = await run(
      Effect.flatMap(AgentSignalRepository, (r) => r.raise({ ...seat, kind: "escalate", text: "Which store?", form: { kind: "proof" } })),
    );
    const read = await run(Effect.flatMap(AgentSignalRepository, (r) => r.get(raised.signalId)));
    expect(read.form).toEqual({ kind: "proof" });
  });
});
