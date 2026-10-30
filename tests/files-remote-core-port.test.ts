import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { coreOpBody } from "../src/main/core-process/ops";
// The group registers its bodies where the core boots (entry.ts): one line here too.
import "../src/main/core-process/ops/index";
import { coreFilesRemote } from "../src/main/core-process/main-side/files-remote";
import { FILES_REMOTE_CHANGED } from "../src/main/core-process/channels";
import { publish } from "../src/main/core-process/push";
import type { FilesRemote } from "../src/main/junto/files/link-client";
import { holdFilesRemote } from "../src/main/junto/files/remote-holder";

const ref = { canvas: "c", node: "n" } as never;

/** The core as main sees it: each call runs its operation's body. */
const core = {
  call: (name: string, input: unknown) => Effect.runPromise(coreOpBody(name)!(input as never) as Effect.Effect<never>),
} as never;

afterEach(() => holdFilesRemote(undefined));

it("main's port asks the core's link client and hears its changes", async () => {
  const unreachable = { ok: false, error: "unreachable", machine: "mini", lastReachedAt: null } as const;
  const open = vi.fn(async () => unreachable);
  holdFilesRemote({ open } as unknown as FilesRemote);
  const port = coreFilesRemote(core);
  expect(await port.open("mini", ref)).toEqual(unreachable);
  expect(open).toHaveBeenCalledWith("mini", ref);

  const heard = vi.fn();
  const stop = port.onChange(heard);
  const change = { machine: "mini", change: { node: "n", kind: "back" } };
  publish(FILES_REMOTE_CHANGED, change);
  stop();
  expect(heard).toHaveBeenCalledWith(change);
});

it("with no link client, or a core that cannot answer, a call is failed and never throws", async () => {
  expect(await coreFilesRemote(core).open("mini", ref)).toEqual({ ok: false, error: "failed" });
  const down = { call: () => Promise.reject(new Error("the core stopped")) } as never;
  expect(await coreFilesRemote(down).count("mini", ref)).toEqual({ ok: false, error: "failed" });
});
