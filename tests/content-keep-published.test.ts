/**
 * A pulled body, published in the store, is kept under its owner: the
 * manifest then holds it verified, so reads and garbage collection see it.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, it } from "vitest";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { receiveContentTransfer } from "../src/main/junto/content/transfer-local";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import type { ContentRef } from "../src/shared/wire/content-ref";

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("keeps a published object under its owner, and only then holds it verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-keep-"));
  roots.push(root);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
      Layer.mergeAll(makeStateEngineLive(join(root, "state", "junto.db")), makeInstallOpsLive(join(root, "state", "install-ops.db"))),
    ),
  );
  runtimes.push(runtime);
  const store = await runtime.runPromise(ContentService);
  const bytes = Buffer.from("an artifact body\n".repeat(4096));
  const ref = { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, mediaType: "text/markdown" } as ContentRef;
  await receiveContentTransfer({ root: store.root, ref, source: bytes, expectedOffset: 0 });
  expect(await runtime.runPromise(store.heldVerified(ref))).toBe(false);

  const owner = { kind: "artifact" as const, canvasName: "factory", nodeId: "artifacts-1", recordId: "artifact-1@3" };
  await runtime.runPromise(store.keepPublished({ ref, owner }));
  await runtime.runPromise(store.keepPublished({ ref, owner }));

  expect(await runtime.runPromise(store.heldVerified(ref))).toBe(true);
  expect(await runtime.runPromise(store.heldVerified({ ...ref, byteLength: ref.byteLength + 1 }))).toBe(false);
  expect((await runtime.runPromise(store.availability(ref))).state).toBe("verified");
  expect((await runtime.runPromise(store.listRefs(ref.sha256))).map((row) => row.owner)).toEqual([owner]);
  await runtime.runPromise(Effect.void);
});
