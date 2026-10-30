/**
 * `junto authority` (plan 0.11/06, F5): what this machine knows of each
 * canvas's authority, and the operator's one path to divergence.
 *
 * All three are owner commands over the owner ops `authority.status`,
 * `authority.alone` and `authority.list` (remote-window, F5c), reached through
 * `AuthorityOwner` so the commands are tested over a stand-in. The root entry
 * exists only behind AUTHORITY_ENABLED.
 */
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  AuthorityListArgs,
  authorityMachineLine,
  type AuthorityAloneArgs,
  type AuthorityAloneData,
  type AuthorityCanvasStatus,
  type AuthorityListData,
  type AuthorityMachineFacts,
  type AuthorityMachineView,
  type AuthorityStatusArgs,
  type AuthorityStatusData,
} from "@shared/authority";
import { InputError } from "../core/errors";
import { OperatorSocket, requireOwnerCommand } from "../core/operator-socket";
import { executeJsonCommand } from "../core/output";

/** The three owner ops, answered by this machine's runtime. */
export class AuthorityOwner extends Context.Service<AuthorityOwner, {
  readonly status: (args: AuthorityStatusArgs) => Effect.Effect<AuthorityStatusData, unknown>;
  readonly alone: (args: AuthorityAloneArgs) => Effect.Effect<AuthorityAloneData, unknown>;
  readonly list: (args: AuthorityListArgs) => Effect.Effect<AuthorityListData, unknown>;
}>()("@junto/cli/AuthorityOwner") {}

/** The owner ops over this machine's operator socket. */
export const AuthorityOwnerLive = Layer.effect(
  AuthorityOwner,
  Effect.gen(function* () {
    const socket = yield* OperatorSocket;
    return AuthorityOwner.of({
      status: (args) => socket.call("authority.status", args),
      alone: (args) => socket.call("authority.alone", args),
      list: (args) => socket.call("authority.list", args),
    });
  }),
);

/** Times in a state's words: ISO 8601, UTC. The data's since and staleSince stay epoch milliseconds, as the contract has them. */
const isoTime = (at: number): string => new Date(at).toISOString();

/** Each machine with its state in words: reachable, asleep since a time, unreachable, not linked. */
const withState = <M extends AuthorityMachineFacts>(machine: M) => ({
  ...machine,
  state: authorityMachineLine({ ...machine, isAuthority: false } satisfies AuthorityMachineView, isoTime),
});

const canvasOut = (canvas: AuthorityCanvasStatus) => ({
  ...canvas,
  authority: canvas.authority === null ? null : withState(canvas.authority),
  list: canvas.list.map(withState),
});

/** The status data as printed: the term a number, every machine with its state. */
export const authorityStatusOut = (data: AuthorityStatusData) => ({
  self: withState(data.self),
  machines: data.machines.map(withState),
  canvases: data.canvases.map(canvasOut),
});

export const authorityStatus = (canvas: Option.Option<string>) =>
  Effect.gen(function* () {
    yield* requireOwnerCommand;
    const owner = yield* AuthorityOwner;
    const data = yield* owner.status(Option.match(canvas, { onNone: () => ({}), onSome: (one) => ({ canvas: one }) }));
    return authorityStatusOut(data);
  });

/** The alone answer whole: the warning is printed in full, never cut. */
export const authorityAlone = (canvas: string) =>
  Effect.gen(function* () {
    yield* requireOwnerCommand;
    const owner = yield* AuthorityOwner;
    return yield* owner.alone({ canvas });
  });

/** The machines named, in order, from `--order mini,book`. */
const orderOf = (order: string): ReadonlyArray<string> =>
  order.split(",").map((name) => name.trim()).filter((name) => name.length > 0);

/** The list edit: what was named, and the list that rules until the joint entry commits. */
export const authorityList = (canvas: string, order: string) =>
  Effect.gen(function* () {
    yield* requireOwnerCommand;
    const args = yield* Schema.decodeUnknownEffect(AuthorityListArgs)({ canvas, order: orderOf(order) }).pipe(
      Effect.mapError(() =>
        new InputError({
          message: "--order names each machine once, 1 to 32 of them, comma separated",
          path: "order",
          next_step: "junto authority status lists the machines this machine knows by name",
        })),
    );
    const owner = yield* AuthorityOwner;
    const data = yield* owner.list(args);
    return { ...data, named: data.named.map(withState), committed: data.committed.map(withState) };
  });

const status = Command.make("status", {
  canvas: Argument.string("canvas").pipe(Argument.optional, Argument.withDescription("A canvas this machine holds; every one when left out")),
}, ({ canvas }) => executeJsonCommand("authority status", authorityStatus(canvas).pipe(Effect.provide(AuthorityOwnerLive)))).pipe(
  Command.withDescription(
    "Show which machine takes changes for each canvas this machine holds: the term, the authority, whether it can commit, the operator's list with each machine's state (reachable, asleep since a time, unreachable, not linked), a list change not yet applied (pending), how many changes wait for the operator to apply or discard (waiting), and since when reads are stale (staleSince, epoch ms). Owner only.",
  ),
);

const alone = Command.make("alone", {
  canvas: Argument.string("canvas").pipe(Argument.withDescription("The canvas to take alone")),
}, ({ canvas }) => executeJsonCommand("authority alone", authorityAlone(canvas).pipe(Effect.provide(AuthorityOwnerLive)))).pipe(
  Command.withDescription(
    "Make this machine the only one that takes changes for a canvas whose pair cannot commit. Run only on a listed machine of a pair, only when the other is gone; otherwise refused with the reason. The answer carries the warning in full: read it. Owner only.",
  ),
);

const list = Command.make("list", {
  canvas: Argument.string("canvas").pipe(Argument.withDescription("The canvas whose list to set")),
  order: Flag.string("order").pipe(Flag.withDescription("The machines by name, first to rule first, comma separated: --order mini,book")),
}, ({ canvas, order }) => executeJsonCommand("authority list", authorityList(canvas, order).pipe(Effect.provide(AuthorityOwnerLive)))).pipe(
  Command.withDescription(
    "Set the ordered list of machines that may take changes for a canvas: the first reachable one rules. The edit commits only once a quorum of the old list and the new one holds it; until then the old list still rules (committed), pending is true and waiting says why. Owner only.",
  ),
);

export const authorityCommand = Command.make("authority").pipe(
  Command.withDescription("Read, order and break the authority of a canvas this machine holds (owner only)"),
  Command.withSubcommands([status, alone, list]),
);
