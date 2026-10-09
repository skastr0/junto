import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Context, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/shared/work-model";
import type { Canvas, Node, Wire } from "../src/shared/model";
import type { ActorRef } from "../src/shared/work-protocol";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { ModelStoresLive, readSeeded, seedCanvas } from "./support/seed-canvas";
import { seat, taskBoard, wire } from "./support/model-nodes";

/**
 * The shared test database holds many canvases, so every seat carries a
 * binding unique to its canvas or its descriptor would conflict with a
 * same-named seat elsewhere.
 */
const agentNode = (id: string, canvasName: string, hostId: string = THIS_MACHINE) =>
  seat(id, {
    label: "profile-13",
    host: hostId,
    agentKey: `${hostId}:${id}`,
    bindingId: `binding-${id}-${canvasName}` as never,
    launch: { kind: "harness", argv: ["claude"] },
  });

/** Make a canvas of these nodes and wires, as the operator would. */
const write = (name: string, nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire>) =>
  workRuntime.runPromise(seedCanvas(name, nodes, wires) as never);
const seqOf = async (name: string): Promise<number> =>
  ((await workRuntime.runPromise(readSeeded(name) as never)) as Canvas).seq;

const mail = (messageId: string, text: string, role: Message["role"] = "user"): Message => ({
  messageId,
  role,
  parts: [{ kind: "text", text }],
});

const mockCanvasesHome = join(tmpdir(), `junto-work-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

vi.mock("@shared/seed", () => import("../src/shared/seed"));

import { WorkLive, WorkService } from "../src/main/junto/work/service";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import {
  makeSettingsLive,
  SettingsService,
} from "../src/main/junto/settings/service";
import {
  makeContentServiceLive,
} from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { THIS_MACHINE } from "./support/machines";

const makeWorkRuntime = (databasePath: string) => {
  const installRoot = join(databasePath, "..");
  const stateLive = makeStateEngineLive(databasePath);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
      makeSettingsLive(),
      makeContentServiceLive({
        root: join(installRoot, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(installRoot, "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(
    ModelStoresLive,
    repositoriesLive
  );
  return ManagedRuntime.make(((
    Layer.provideMerge(
      WorkLive,
      canvasesLive as never) as never)
    )
  );
};

const workRuntime = makeWorkRuntime(
  join(mockCanvasesHome, "state", "junto.db")
);
let work: Context.Service.Shape<typeof WorkService>;
let repository: Context.Service.Shape<typeof WorkRepository>;

beforeAll(async () => {
  const settings = await workRuntime.runPromise(SettingsService);
  await workRuntime.runPromise(
    settings.setMachinePreferences({ supervisedPreferred: true })
  );
  work = await workRuntime.runPromise(WorkService);
  repository = await workRuntime.runPromise(WorkRepository);
});

afterAll(async () => {
  await workRuntime.dispose();
  await rm(mockCanvasesHome, { recursive: true, force: true });
});

const actorOf = async (name: string, nodeId: string) => {
  const refs = (await workRuntime.runPromise(
    Effect.flatMap(ModelActorRefs, (actors) => actors.read(name)) as never,
  )) as ReadonlyArray<ActorRef>;
  const actor = refs.find((candidate) => candidate.nodeId === nodeId);
  if (actor === undefined) throw new Error(`missing actor ref for ${nodeId}`);
  return actor;
};

describe("WorkService — mail", () => {
  it("persists inbox mail without moving the canvas", async () => {
    const name = "work-mail-lane";
    await write(
      name,
      [agentNode("sender", name), agentNode("recipient", name), taskBoard("tasks")],
      [wire("edge-message", "sender", "recipient", "messages")],
    );
    const sender = await actorOf(name, "sender");
    const seqBefore = await seqOf(name);

    const kernelChanges: Array<[string | undefined, string | undefined]> = [];
    const offKernel = work.subscribeWorkChanges((canvas, nodeId) => kernelChanges.push([canvas, nodeId]));
    const appended = await workRuntime.runPromise(
      work.workMessageAppend(name, "recipient", null, mail("inbox-lane-1", "start"), sender)
    );
    if (!appended.ok) {
      throw new Error(`${appended.code}: ${appended.message}`);
    }

    expect(appended).not.toHaveProperty("doc");
    expect(appended).not.toHaveProperty("revision");
    expect(kernelChanges).toEqual([]);
    const created = await workRuntime.runPromise(work.workTaskCreate(name, "tasks", "A kernel-visible task", { details: "Run a task." }));
    if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
    expect(kernelChanges).toEqual([[name, "tasks"]]);
    offKernel();
    await workRuntime.runPromise(work.workTaskCreate(name, "tasks", "After unsubscribe", { details: "Run another task." }));
    expect(kernelChanges).toEqual([[name, "tasks"]]);
    const messages = await workRuntime.runPromise(repository.mailbox(name, "recipient"));
    expect(
      messages
    ).toEqual([expect.objectContaining({ messageId: "inbox-lane-1" })]);
    // Mail and tasks are work: the canvas itself did not move.
    expect(await seqOf(name)).toBe(seqBefore);
  });

  it("binds a mailbox ack once, and only to mail that exists", async () => {
    const name = "work-mail-react";
    await write(
      name,
      [agentNode("sender", name), agentNode("owner", name)],
      [wire("edge-mail", "sender", "owner", "messages")],
    );
    const sender = await actorOf(name, "sender");
    const owner = await actorOf(name, "owner");
    const delivered = await workRuntime.runPromise(
      work.workMessageAppend(name, "owner", null, mail("mailbox-note-1", "ping"), sender)
    );
    expect(delivered.ok).toBe(true);

    const reacted = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-1", "ack", owner)
    );
    expect(reacted.ok).toBe(true);
    if (!reacted.ok) return;
    expect(reacted.data.messageId).toBe("mailbox-note-1");
    expect(reacted.data.reaction).toBe("ack");
    // The receipt is durable: re-reacting reads the first one back.
    const again = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-1", "ack", owner)
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.reactedAt).toBe(reacted.data.reactedAt);
    // A reaction binds to a message that exists — nothing else.
    const missing = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-2", "ack", owner)
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("not found in mailbox");
  });
});
