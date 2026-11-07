/**
 * The link's status channel: a machine's own status, or its log for the
 * asking peer. The owner socket's schemas answer both (`MachinePeerStatus`,
 * `MachineLogRead`), so the link and the socket are one definition.
 *
 * Neither request has a typed refusal. A handler failure crosses as the
 * link's own `LinkRequestFailed`, carrying its scrubbed encoded failure, as
 * it always has; the asking end shows that failure as the reason.
 */
import { Effect } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { MachinePeerStatus } from "@shared/machine-control";
import { MachineLogQuery, MachineLogRead } from "@shared/machine-log";
import { bindLinkChannel, linkContract, type LinkContractChannel } from "./contract";
import type { LinkHello } from "./types";

export const StatusLink = linkContract("status", RpcGroup.make(
  Rpc.make("Machine", { success: MachinePeerStatus }),
  Rpc.make("Logs", { payload: { query: MachineLogQuery }, success: MachineLogRead }),
));

export interface StatusAnswers {
  readonly machine: Effect.Effect<typeof MachinePeerStatus.Type, unknown>;
  /** Only rows the asking peer may read: the peer is the admitted hello's. */
  readonly logs: (peer: LinkHello, query: MachineLogQuery) => Effect.Effect<MachineLogRead, unknown>;
}

/** The answering end, over this machine's own status and log. */
export const makeStatusChannel = (answers: StatusAnswers): LinkContractChannel => bindLinkChannel(StatusLink, {
  requests: {
    // An untyped failure is the link's to carry, so it leaves the typed channel here.
    Machine: () => Effect.orDie(answers.machine),
    Logs: ({ query }, context) => Effect.orDie(answers.logs(context.peer, query)),
  },
});
