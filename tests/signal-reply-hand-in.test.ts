/**
 * The operator hands in the work a signal asks for (0.11/07, N1): the form's
 * condition is ruled before anything is written, a document is created in the
 * form's Artifacts node as the operator under the window's reply id, and the
 * signal records what the reply made, never a value.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { replyAgentSignal, type SignalReplyPorts } from "../src/main/junto/signals/operator";
import { WorkService } from "../src/main/junto/work/service";
import { canvasOf, artifacts, seat, region } from "./support/model-nodes";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId, OpId } from "../src/shared/work-ids";
import { artifactLabelOf } from "../src/shared/artifact-labels";
import type { ResourceCommand } from "../src/shared/resource-command";
import type { ArtifactOp } from "../src/shared/artifact";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository | WorkService, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-signal-reply-"));
  const mail = { workSystemMailboxNotify: () => Effect.succeed({ ok: true as const, data: { messageId: "m-answer" } }) };
  runtime = ManagedRuntime.make(
    Layer.merge(
      AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))),
      Layer.succeed(WorkService, mail as never),
    ),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, AgentSignalRepository | WorkService>) => runtime.runPromise(effect);
const SEAT = { canvasName: "factory", nodeId: "agent-a" };

const canvas = canvasOf(
  [
    seat("agent-a", { x: 0, y: 0, width: 100, height: 40 }),
    region("forge", { x: -20, y: -20, width: 620, height: 120 }, { label: "Forge", instruction: "ship" }),
    artifacts("shelf", { x: 0, y: 0, width: 100, height: 40, label: "Shelf" }),
  ],
  [],
);

const words = (count: number): string => Array.from({ length: count }, () => "word").join(" ");

/** The artifact port as a spy: the ruling machine answers applied, and every command is kept. */
const spyPorts = (): { readonly ports: SignalReplyPorts; readonly written: Array<ResourceCommand<ArtifactOp>> } => {
  const written: Array<ResourceCommand<ArtifactOp>> = [];
  return {
    written,
    ports: {
      topology: () => Effect.succeed(canvas),
      artifacts: {
        submit: (command) => {
          written.push(command);
          return Effect.succeed({ kind: "applied" as const, opId: command.opId, artifactId: command.target.itemId!, version: 1 as never, facts: [] });
        },
      },
    },
  };
};

describe("handing work in through a signal", () => {
  it("rules the words first, then writes the document and records it on the answer", async () => {
    const { ports, written } = spyPorts();
    const raised = await run(
      Effect.flatMap(AgentSignalRepository, (r) =>
        r.raise({
          ...SEAT,
          kind: "blocked",
          text: "Write the post.",
          form: {
            kind: "artifact",
            nodeId: asNodeId("shelf"),
            title: "Morning pages",
            labels: [artifactLabelOf("daily")!],
            minWords: 5,
          },
        }),
      ),
    );

    const short = await run(
      replyAgentSignal(raised.signalId, { kind: "artifact", markdown: words(4), replyId: "01M62Q58WDSXMG4YBXNKR2RB91" }, ports),
    );
    expect(short).toEqual({ ok: false, message: "the document holds 4 words of 5" });
    expect(written).toEqual([]);

    const replyId = "01M62Q58WDSXMG4YBXNKR2RB92";
    const handed = await run(replyAgentSignal(raised.signalId, { kind: "artifact", markdown: words(5), replyId }, ports));
    expect(handed.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      opId: OpId.make(replyId),
      canvasName: "factory",
      actor: { kind: "operator" },
      target: { kind: "artifact", nodeId: "shelf" },
      op: { op: "create", title: "Morning pages", body: { type: "document", markdown: words(5) }, labels: ["daily"] },
    });

    const signal = handed.ok ? handed.signal : undefined;
    expect(signal?.state).toBe("answered");
    expect(signal?.response?.text).toBe("Morning pages is written, 5 words.");
    expect(signal?.response?.artifact).toMatchObject({ nodeId: "shelf", title: "Morning pages", words: 5 });
    expect(signal?.response?.artifact?.artifactId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(handed.ok && handed.messageId).toBe("m-answer");

    // A hand-in after the signal closed writes nothing.
    const again = await run(replyAgentSignal(raised.signalId, { kind: "artifact", markdown: words(5), replyId }, ports));
    expect(again).toEqual({ ok: false, message: "this signal is already answered" });
    expect(written).toHaveLength(1);
  }, 20_000);

  it("keeps proof's words and addresses, and refuses an address the wire refuses", async () => {
    const { ports } = spyPorts();
    const raised = await run(
      Effect.flatMap(AgentSignalRepository, (r) => r.raise({ ...SEAT, kind: "escalate", text: "Show it working.", form: { kind: "proof" } })),
    );
    const bad = await run(
      replyAgentSignal(raised.signalId, { kind: "proof", text: "shipped", links: ["nope"], replyId: "01M62Q58WDSXMG4YBXNKR2RB93" }, ports),
    );
    expect(bad).toEqual({ ok: false, message: "nope: not a web address." });

    const handed = await run(
      replyAgentSignal(
        raised.signalId,
        { kind: "proof", text: "The run passed.", links: ["https://example.com/run/1"], replyId: "01M62Q58WDSXMG4YBXNKR2RB94" },
        ports,
      ),
    );
    expect(handed.ok).toBe(true);
    // The seat reads the proof's words and its addresses: the record keeps both, the mail says both.
    expect(handed.ok && handed.signal.response).toMatchObject({
      text: "The run passed.\n\nhttps://example.com/run/1",
      links: ["https://example.com/run/1"],
    });
  }, 20_000);

  it("refuses a hand-in on a signal that asks for nothing", async () => {
    const { ports } = spyPorts();
    const raised = await run(Effect.flatMap(AgentSignalRepository, (r) => r.raise({ ...SEAT, kind: "blocked", text: "Which store?" })));
    const refused = await run(
      replyAgentSignal(raised.signalId, { kind: "proof", text: "here", links: [], replyId: "01M62Q58WDSXMG4YBXNKR2RB95" }, ports),
    );
    expect(refused).toEqual({ ok: false, message: "this signal asks for no work: answer it instead of handing work in" });
  });
});

void ItemId;
