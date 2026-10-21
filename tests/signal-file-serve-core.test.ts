/**
 * The seat's machine serves a signal's file through the core's own content
 * channel (plan 02): the placement and the signal store the core feeds the
 * check are its own, so a mis-wired one cannot serve or refuse everything.
 * This core is the mini, which runs the seat; the book edits the canvas.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Exit, Schema } from "effect";
import { expect, it } from "vitest";
import { MachineCoreRows } from "../src/main/core-runtime";
import { ContentService } from "../src/main/junto/content/service";
import { startCore } from "../src/main/junto/core";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import type { LinkChannelContext } from "../src/main/junto/link/types";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { signalAttachmentOwner } from "../src/main/junto/signals/attachments";
import { AgentSignalRepository } from "../src/main/junto/signals/repository";
import { ContentPullRefusal } from "../src/shared/content-pull";
import { InstallationId } from "../src/shared/installation-id";
import { MachineName } from "../src/shared/machine-control";
import { asCanvasName } from "../src/shared/model";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const name = Schema.decodeUnknownSync(MachineName);
const BOOK = id("book-installation");
const THIRD = id("third-installation");
const canvas = asCanvasName("factory");

it("serves the editing machine a signal's file while the seat is here and the signal open, and no one else", async () => {
  const home = await mkdtemp("/tmp/junto-signal-serve-");
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build: "a".repeat(64), bundles: {} });
    await core.runtime.runPromise(Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(name("mini"));
      yield* machines.pinPeer({ machineName: name("book"), installationId: BOOK });
      yield* machines.pinPeer({ machineName: name("third"), installationId: THIRD });
    }));
    // The book's copy: the seat lives on this machine, a second seat on the third.
    const install = (seq: number, peerHost: string) =>
      core!.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.installCopy({
        canvas, canvasId: "canvas-factory", seq, editor: BOOK,
        nodes: [seat("peer", { host: name(peerHost) }), seat("idle", { host: name("third"), y: 200 })], wires: [],
      })));
    await install(1, "mini");
    const bytes = Buffer.from("what the seat attached\n");
    const signalId = "01M5FJ000000000000000000S1";
    const owner = signalAttachmentOwner({ signalId, canvasName: canvas, nodeId: "peer" });
    const put = await core.runtime.runPromise(Effect.flatMap(ContentService, (store) =>
      store.put({ source: bytes, mediaType: "text/plain", displayName: "notes.txt", owner })));
    const ref = put.ref as ContentRef;
    await core.runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) =>
      signals.raise({ canvasName: canvas, nodeId: "peer", kind: "blocked", text: "look", signalId, attachments: [{ ref }] })));

    const rows = await core.runtime.runPromise(MachineCoreRows);
    const ask = (peer: InstallationId, machineName: string) =>
      core!.runtime.runPromiseExit(rows.content.handleRequest!(
        { peer: Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId: peer, machineName }) } as LinkChannelContext,
        rows.content.decodeRequest({ canvasName: canvas, sha256: ref.sha256, byteLength: ref.byteLength, offset: 0 }),
      ));
    const refusal = (exit: Exit.Exit<unknown, unknown>) => {
      const cause = Exit.isFailure(exit) ? (exit.cause as unknown as { reasons?: ReadonlyArray<{ error?: unknown }> }) : undefined;
      return cause?.reasons?.find((reason) => reason.error !== undefined)?.error;
    };
    const served = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isSuccess(exit) && Buffer.from((exit.value as { bytes: string }).bytes, "base64").equals(bytes);

    expect(served(await ask(BOOK, "book"))).toBe(true);
    const third = refusal(await ask(THIRD, "third"));
    expect(third).toBeInstanceOf(ContentPullRefusal);
    expect(third).toMatchObject({ reason: "not-editor" });

    // The seat moved to the third machine: this one serves its file to no one.
    await install(2, "third");
    expect(refusal(await ask(BOOK, "book"))).toMatchObject({ reason: "not-editor" });
    await install(3, "mini");
    expect(served(await ask(BOOK, "book"))).toBe(true);

    // The seat withdrew it: a closed signal serves nothing.
    await core.runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) =>
      signals.withdraw({ canvasName: canvas, nodeId: "peer" }, signalId)));
    expect(refusal(await ask(BOOK, "book"))).toMatchObject({ reason: "not-editor" });
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
