/**
 * The session record at close: what Junto observed while a seat session ran,
 * read from the real stores (mail, signals, the session row) and written
 * beside the session's notes. The shaping is pure and tested apart.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { seat, wire } from "./support/model-nodes";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import {
  buildSessionRecord,
  recordSessionAtClose,
  sessionRecordPathOf,
  type SessionFacts,
} from "../src/main/junto/seat-sessions/session-record";
import { SESSION_RECORD_LIST_MAX, SESSION_RECORD_TEXT_MAX, type SessionRecord } from "../src/shared/seat-session-record";
import type { ActorRef } from "../src/shared/work-protocol";

const CANVAS = "records";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      makeSeatSessionRepositoryLive(join(root, "seats")),
      AgentSignalRepositoryLive,
      makeMachineRepositoryLive({ defaultName: () => "workbench" }),
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  return ManagedRuntime.make(Layer.provideMerge(WorkLive, Layer.provideMerge(ModelStoresLive, repositoriesLive)));
};

const agent = (id: string, x: number) =>
  seat(id, {
    x,
    host: "workbench",
    width: 120,
    height: 48,
    bindingId: `bind-${id}` as never,
    launch: { kind: "harness", argv: ["claude"] },
  });

let root: string;
let runtime: ReturnType<typeof makeRuntime>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-session-record-"));
  runtime = makeRuntime(root);
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(settings.setMachinePreferences({ supervisedPreferred: true }));
  await runtime.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.configureName("workbench")));
  await runtime.runPromise(
    seedCanvas(CANVAS, [agent("agent", 0), agent("peer", 200)], [wire("edge-mail", "agent", "peer", "messages")]),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const actorOf = async (nodeId: string): Promise<ActorRef> => {
  const refs = (await runtime.runPromise(
    Effect.flatMap(ModelActorRefs, (actors) => actors.read(CANVAS)) as never,
  )) as ReadonlyArray<ActorRef>;
  const actor = refs.find((candidate) => candidate.nodeId === nodeId);
  if (actor === undefined) throw new Error(`missing actor ref for ${nodeId}`);
  return actor;
};

describe("the session record at close", () => {
  it("records the session's mail and signals, each read from its store, beside the notes", async () => {
    const cwd = join(root, "repo");
    const transcript = join(root, "transcript.jsonl");
    await runtime.runPromise(
      Effect.flatMap(SeatSessionRepository, (sessions) =>
        sessions.record({ seatId: "agent", bindingId: "bind-agent", sessionId: "s1", harness: "claude", cwd }),
      ),
    );

    const peer = await actorOf("peer");
    const self = await actorOf("agent");
    const append = (to: string, sender: ActorRef, messageId: string, text: string, metadata: Record<string, unknown>) =>
      runtime.runPromise(
        Effect.flatMap(WorkService, (work) =>
          work.workMessageAppend(CANVAS, to, null, { messageId, role: "user", parts: [{ kind: "text", text }], metadata }, sender),
        ) as never,
      );
    await append("agent", peer, "m-in-1", "Please   look at\nthe sync bug.", { senderNodeId: "peer", senderName: "peer-lead" });
    await append("agent", peer, "m-in-2", "Unanswered note.", { senderNodeId: "peer", senderName: "peer-lead" });
    await append("peer", self, "m-out-1", "Fixed, see the commit.", { senderNodeId: "agent", senderName: "agent", inReplyTo: "m-in-1" });

    const signal = await runtime.runPromise(
      Effect.flatMap(AgentSignalRepository, (signals) =>
        signals.raise({ canvasName: CANVAS, nodeId: "agent", kind: "blocked", text: "Which store?" }),
      ),
    );
    await runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) => signals.answer(signal.signalId, "Use sqlite")));

    // The harness's transcript path, as session capture would have recorded it.
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe("UPDATE seat_sessions SET transcript_path = ? WHERE seat_id = 'agent' AND session_id = 's1'", [transcript]),
      ),
    );

    const endedAt = Date.now() + 1_000;
    const logs: string[] = [];
    await runtime.runPromise(
      recordSessionAtClose(
        { seat: { canvasName: CANVAS, seatId: "agent" }, sessionId: "s1", endedAt, endedBy: "automatic" },
        { now: () => endedAt, log: (line) => logs.push(line) },
      ),
    );
    expect(logs).toEqual([]);

    const notesPath = await runtime.runPromise(Effect.map(SeatSessionRepository, (sessions) => sessions.notesPathFor("agent", "s1")));
    const record = JSON.parse(await readFile(sessionRecordPathOf(notesPath), "utf8")) as SessionRecord;

    expect(record.kind).toBe("junto_observation");
    expect(record.session).toMatchObject({ id: "s1", harness: "claude", ended_by: "automatic", cwd, transcript_path: transcript });
    expect(record.mail_in).toMatchObject({
      read: true,
      more: 0,
      items: [
        { id: "m-in-1", from: "peer-lead", text: "Please look at the sync bug.", answered: true },
        { id: "m-in-2", from: "peer-lead", answered: false },
      ],
    });
    expect(record.mail_out).toMatchObject({
      read: true,
      items: [{ id: "m-out-1", to: "peer", text: "Fixed, see the commit.", in_reply_to: "m-in-1" }],
    });
    expect(record.signals).toMatchObject({
      read: true,
      items: [{ kind: "blocked", text: "Which store?", state: "answered", answer: { text: "Use sqlite" } }],
    });
    expect(record.tasks).toEqual({ read: true, items: [], more: 0 });
  });
});

describe("buildSessionRecord", () => {
  const facts = (overrides: Partial<SessionFacts> = {}): SessionFacts => ({
    session: { id: "s", harness: "codex", startedAt: 0, endedAt: 60_000, endedBy: "agent", cwd: null, transcriptPath: null },
    mailIn: { read: true, items: [] },
    mailOut: { read: true, items: [] },
    signals: { read: true, items: [] },
    tasks: { read: true, items: [] },
    ...overrides,
  });

  it("keeps the newest items past the cap, oldest first, and counts the rest", () => {
    const items = Array.from({ length: SESSION_RECORD_LIST_MAX + 3 }, (_, index) => ({
      id: `m${index}`,
      from: "peer",
      at: new Date(index * 1_000).toISOString(),
      text: `mail ${index}`,
      readAt: null,
    }));
    const record = buildSessionRecord(facts({ mailIn: { read: true, items: [...items].reverse() } }), 0);
    expect(record.mail_in.read && record.mail_in.more).toBe(3);
    expect(record.mail_in.read && record.mail_in.items[0]?.id).toBe("m3");
    expect(record.mail_in.read && record.mail_in.items.at(-1)?.id).toBe(`m${SESSION_RECORD_LIST_MAX + 2}`);
  });

  it("passes an unread source through as unread", () => {
    const record = buildSessionRecord(facts({ signals: { read: false, reason: "this seat's signals took too long to read" } }), 0);
    expect(record.signals).toEqual({ read: false, reason: "this seat's signals took too long to read" });
  });

  it("bounds words to one line", () => {
    const long = "word ".repeat(SESSION_RECORD_TEXT_MAX);
    const record = buildSessionRecord(
      facts({ mailOut: { read: true, items: [{ id: "o", to: "peer", at: "2026-01-01T00:00:00.000Z", text: long, inReplyTo: null }] } }),
      0,
    );
    const text = record.mail_out.read ? record.mail_out.items[0]!.text : "";
    expect(text.length).toBe(SESSION_RECORD_TEXT_MAX);
    expect(text.endsWith("…")).toBe(true);
  });
});
