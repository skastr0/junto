/**
 * `junto authority` (plan 0.11/06, F5): what this machine knows of each
 * canvas's authority, and the operator's one path to divergence.
 *
 * Both are owner commands over remote-window's owner ops. The ops are reached
 * through `AuthorityOwner`, so the commands compile and are tested before the
 * ops are registered; the live layer and the root entry land with them.
 */
import { Context, Effect, Option } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import {
  authorityMachineLine,
  type AuthorityAloneArgs,
  type AuthorityAloneData,
  type AuthorityCanvasStatus,
  type AuthorityMachineFacts,
  type AuthorityMachineView,
  type AuthorityStatusArgs,
  type AuthorityStatusData,
} from "@shared/authority";
import { requireOwnerCommand } from "../core/operator-socket";
import { executeJsonCommand } from "../core/output";

/** The two owner ops, answered by this machine's runtime. */
export class AuthorityOwner extends Context.Service<AuthorityOwner, {
  readonly status: (args: AuthorityStatusArgs) => Effect.Effect<AuthorityStatusData, unknown>;
  readonly alone: (args: AuthorityAloneArgs) => Effect.Effect<AuthorityAloneData, unknown>;
}>()("@junto/cli/AuthorityOwner") {}

/** Times as the JSON reads them: ISO 8601, UTC. */
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

const status = Command.make("status", {
  canvas: Argument.string("canvas").pipe(Argument.optional, Argument.withDescription("A canvas this machine holds; every one when left out")),
}, ({ canvas }) => executeJsonCommand("authority status", authorityStatus(canvas))).pipe(
  Command.withDescription(
    "Show which machine takes changes for each canvas this machine holds: the term, the authority, whether it can commit, the operator's list with each machine's state (reachable, asleep since a time, unreachable, not linked), and since when reads are stale. Owner only.",
  ),
);

const alone = Command.make("alone", {
  canvas: Argument.string("canvas").pipe(Argument.withDescription("The canvas to take alone")),
}, ({ canvas }) => executeJsonCommand("authority alone", authorityAlone(canvas))).pipe(
  Command.withDescription(
    "Make this machine the only one that takes changes for a canvas whose pair cannot commit. Run only on a listed machine of a pair, only when the other is gone; otherwise refused with the reason. The answer carries the warning in full: read it. Owner only.",
  ),
);

export const authorityCommand = Command.make("authority").pipe(
  Command.withDescription("Read and break the authority of a canvas this machine holds (owner only)"),
  Command.withSubcommands([status, alone]),
);
