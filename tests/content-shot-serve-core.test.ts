/**
 * The core's own content channel serves a page comment's shot through the
 * real layer: the canvas seats and the placement the core feeds the check
 * are its own, so a mis-wired placement cannot serve or refuse everything.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Exit, Schema } from "effect";
import { expect, it } from "vitest";
import { MachineCoreRows } from "../src/main/core-runtime";
import { ContentService } from "../src/main/junto/content/service";
import { startCore } from "../src/main/junto/core";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import type { LinkChannelContext } from "../src/main/junto/link/types";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { WorkRepository } from "../src/main/junto/work/repository";
import { ContentPullRefusal } from "../src/shared/content-pull";
import type { MailMessageId } from "../src/shared/crew";
import { InstallationId } from "../src/shared/installation-id";
import { MachineName } from "../src/shared/machine-control";
import type { NodeId } from "../src/shared/model/base";
import { subjectNoticeRow } from "../src/shared/subject-notice";
import { threadSubjectMetadata, type ResourceSubject } from "../src/shared/thread-subject";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { ActorSeatId } from "../src/shared/work-protocol";
import { page, seat } from "./support/model-nodes";
import { seedCanvas } from "./support/seed-canvas";

const id = Schema.decodeUnknownSync(InstallationId);
const name = Schema.decodeUnknownSync(MachineName);
const MINI = id("mini-installation");
const THIRD = id("third-installation");
const COMMENT = "01M5F80000000000000000000C";
const at = "2026-10-21T12:00:00.000Z";

it("serves the shot to the machine whose seat its notice reached, and refuses a linked machine it did not", async () => {
  const home = await mkdtemp("/tmp/junto-shot-serve-");
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build: "a".repeat(64), bundles: {} });
    const self = await core.runtime.runPromise(Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(name("book"));
      yield* machines.pinPeer({ machineName: name("mini"), installationId: MINI });
      yield* machines.pinPeer({ machineName: name("third"), installationId: THIRD });
      return yield* machines.installationId;
    }));
    // Both other machines are linked for the canvas: each has a seat on it.
    await core.runtime.runPromise(seedCanvas("factory", [
      seat("lead", { host: name("book") }), seat("peer", { host: name("mini") }), seat("idle", { host: name("third") }), page("page-1", { y: 400 }),
    ]));
    const bytes = Buffer.from("a page box, as main shot it");
    const put = await core.runtime.runPromise(Effect.flatMap(ContentService, (store) => store.put({
      source: bytes, mediaType: "image/png", owner: { kind: "message", canvasName: "factory", nodeId: "page-1", recordId: COMMENT },
    })));
    const shot = put.ref as ContentRef;
    expect(shot.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    // The comment on the page, and its notice to the seat on the mini, as main writes them.
    const subject = { kind: "page", nodeId: "page-1", anchor: { kind: "box", x: 0, y: 0, w: 10, h: 10, url: "https://x.example/", scroll: { x: 0, y: 0 }, shot } } as ResourceSubject;
    const notice = subjectNoticeRow({
      kind: "comment", installationId: self, sourceId: COMMENT as MailMessageId, subject, threadId: COMMENT as MailMessageId,
      recipient: "peer" as NodeId, text: "a box", sender: { senderNodeId: "lead", senderName: "lead" } as never,
    });
    const sentBy = { seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"1".repeat(64)}`), canvasName: "factory", nodeId: "lead" };
    await core.runtime.runPromise(Effect.gen(function* () {
      const work = yield* WorkRepository;
      for (const [nodeId, messageId, metadata] of [
        ["page-1", COMMENT, { factoryMail: true, ...threadSubjectMetadata(subject), threadId: COMMENT }],
        ["peer", notice.messageId, notice.metadata],
      ] as const) {
        yield* work.appendMessage({
          sink: { canvasName: "factory", nodeId },
          basis: { kind: "canvas", canvasName: "factory", seq: 1 },
          message: { messageId, role: "user", parts: [{ kind: "text", text: "a box" }], metadata } as never,
          sentBy: sentBy as never,
          destination: { kind: "mailbox" },
          originAt: at,
          receivedAt: at,
        });
      }
    }));

    const rows = await core.runtime.runPromise(MachineCoreRows);
    const ask = (peer: InstallationId, machineName: string) =>
      core!.runtime.runPromiseExit(rows.content.handleRequest!(
        { peer: Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId: peer, machineName }) } as LinkChannelContext,
        rows.content.decodeRequest({ canvasName: "factory", sha256: shot.sha256, byteLength: shot.byteLength, offset: 0 }),
      ));

    const served = await ask(MINI, "mini");
    expect(Exit.isSuccess(served) && Buffer.from((served.value as { bytes: string }).bytes, "base64").equals(bytes)).toBe(true);
    const refused = await ask(THIRD, "third");
    expect(Exit.isFailure(refused)).toBe(true);
    const cause = Exit.isFailure(refused) ? (refused.cause as unknown as { reasons?: ReadonlyArray<{ error?: unknown }> }) : undefined;
    const error = cause?.reasons?.find((reason) => reason.error !== undefined)?.error;
    expect(error).toBeInstanceOf(ContentPullRefusal);
    expect(error).toMatchObject({ reason: "not-held" });
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
