/**
 * An owner lets go of its content references (a closed signal's attached
 * files). The bytes stay until garbage collection finds nothing else holding
 * them; another owner's reference to the same bytes is untouched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { contentStoreRoot } from "../src/main/junto/content/paths";
import { createContentService } from "../src/main/junto/content/service";
import { signalAttachmentOwner } from "../src/main/junto/signals/attachments";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";

let home: string | undefined;
let runtime: ManagedRuntime.ManagedRuntime<StateEngine, unknown> | undefined;

afterEach(async () => {
  await runtime?.dispose();
  if (home) await rm(home, { recursive: true, force: true });
  runtime = undefined;
  home = undefined;
});

describe("ContentService.releaseOwner", () => {
  it("releases only that owner's references", async () => {
    home = await mkdtemp(join(tmpdir(), "junto-content-release-"));
    runtime = ManagedRuntime.make(makeStateEngineLive(join(home, "junto.db")));
    const state = await runtime.runPromise(StateEngine);
    const service = createContentService(state, contentStoreRoot(home));

    const first = signalAttachmentOwner({ signalId: "s1", canvasName: "factory", nodeId: "atlas" });
    const second = signalAttachmentOwner({ signalId: "s2", canvasName: "factory", nodeId: "atlas" });
    const shared = Buffer.from("the same screenshot");
    const put = (source: Buffer, owner: typeof first) =>
      Effect.runPromise(service.put({ source, mediaType: "image/png", displayName: "shot.png", owner }));
    const a = await put(shared, first);
    await put(Buffer.from("only on the first"), first);
    await put(shared, second);

    expect(await Effect.runPromise(service.releaseOwner(first))).toBe(2);
    // The second signal still holds the shared bytes.
    const left = await Effect.runPromise(service.listRefs(a.ref.sha256));
    expect(left.map((row) => row.owner.recordId)).toEqual(["signal:s2"]);
    // Releasing again, or an owner that holds nothing, releases nothing.
    expect(await Effect.runPromise(service.releaseOwner(first))).toBe(0);

    // With its last reference gone and no grace, collection takes the object.
    expect(await Effect.runPromise(service.releaseOwner(second))).toBe(1);
    const report = await Effect.runPromise(service.collectGarbage({ dryRun: true, orphanGraceMs: 0 }));
    expect(JSON.stringify(report)).toContain(a.ref.sha256);
  });
});
