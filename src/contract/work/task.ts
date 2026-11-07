/**
 * The work socket's task.* and rulings ops, as one Effect `RpcGroup`. Owned by cli-external.
 *
 * Empty until its ops move here from the control plane's if chain: an op
 * in this group is answered through RPC (`servesWorkRpc`), and every other
 * op still takes the chain. Write each op as `src/contract/work/msg.ts` does:
 * its v1 name as the tag, its arguments as the payload, its answer as the
 * success, and `WorkFailure` as the error.
 */
import { Rpc, RpcGroup } from "effect/rpc";

export const TaskRpcs = RpcGroup.make().annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });
