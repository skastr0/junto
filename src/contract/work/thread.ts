/**
 * The work socket's thread.* ops, as one Effect `RpcGroup`: a seat's threads,
 * those with the operator and those between seats, read from a seat. Owned by cli-protocol. The core serves
 * the group (`src/core/work-control/thread.ts`) and the CLI calls it
 * (`src/cli/commands/thread.ts`).
 *
 * Each op's tag is its v1 name, and the wire stays v1: the arguments are the
 * frame's `args`, the answer its `data`, and the refusal its `error`.
 */
import { Rpc, RpcGroup } from "effect/rpc";
import { ThreadListAnswer, ThreadListArgs, ThreadShowAnswer, ThreadShowArgs } from "../../shared/thread-control";
import { WorkFailure, WorkInputHint } from "./failure";

export const ThreadList = Rpc.make("thread.list", { payload: ThreadListArgs, success: ThreadListAnswer, error: WorkFailure })
  .annotate(WorkInputHint, "junto schema show thread.list");
export const ThreadShow = Rpc.make("thread.show", { payload: ThreadShowArgs, success: ThreadShowAnswer, error: WorkFailure })
  .annotate(WorkInputHint, "junto schema show thread.show");

/** Decoded strictly where the core serves it: an argument or an answer field the contract does not name is refused. */
export const ThreadRpcs = RpcGroup.make(ThreadList, ThreadShow).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });
