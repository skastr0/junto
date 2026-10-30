/**
 * The operator's authority commands (0.11/06 F5): `authority.status`, the
 * list edit and `alone`, dispatched beside the machine owner's. Every answer
 * comes from the host's one read, so the command, the window and the banner
 * cannot drift.
 *
 * Behind AUTHORITY_ENABLED: with it off, every authority op is refused before
 * the driver is touched, so a ship build never opens an authority.
 */
import { Context, Effect, Result, Schema } from "effect";
import { AUTHORITY_ENABLED } from "@shared/features";
import {
  authorityAloneWarning,
  authorityListOf,
  authorityPairOf,
  authorityStatusOf,
  authorityViewOf,
  type AuthorityAloneArgs,
  type AuthorityAloneData,
  type AuthorityListArgs,
  type AuthorityListData,
  type AuthorityMachineFacts,
  type AuthorityStatusArgs,
  type AuthorityStatusData,
} from "@shared/authority";
import {
  OPERATOR_PROTOCOL_VERSION,
  decodeOperatorResponse,
  type OperatorRequestEnvelope,
  type OperatorResponseEnvelope,
} from "@shared/operator-control";
import { CanvasAuthorities } from "../fleet/authorities";
import { FleetDriverError } from "../fleet/driver";

/** A refusal the operator can read: which rule stopped the command. */
export class AuthorityRefused extends Schema.TaggedError<AuthorityRefused>()("AuthorityRefused", {
  code: Schema.Literals(["validation", "conflict", "not_found"]),
  message: Schema.String,
}) {}

export interface AuthorityOwnerActions {
  readonly dispatch: (request: OperatorRequestEnvelope) => Effect.Effect<OperatorResponseEnvelope>;
}

export class AuthorityOwnerControl extends Context.Service<AuthorityOwnerControl, AuthorityOwnerActions>()(
  "@junto/AuthorityOwnerControl",
) {}

export const makeAuthorityOwnerActions = (options: { readonly enabled: boolean }) =>
  Effect.gen(function* () {
    const host = yield* CanvasAuthorities;

    const status = (args: AuthorityStatusArgs): Effect.Effect<AuthorityStatusData, FleetDriverError> =>
      Effect.gen(function* () {
        const { self, machines } = yield* host.machines();
        const canvases = yield* host.status(args.canvas);
        return authorityStatusOf({ self, machines, canvases });
      });

    const list = (args: AuthorityListArgs): Effect.Effect<AuthorityListData, FleetDriverError | AuthorityRefused> =>
      Effect.gen(function* () {
        const read = yield* host.setList(args.canvas, args.order);
        const { machines } = yield* host.machines();
        const named = args.order.map((name) => machines.find((machine) => machine.name === name));
        const missing = args.order.filter((_, at) => named[at] === undefined);
        if (missing.length > 0) {
          return yield* new AuthorityRefused({ code: "not_found", message: `there is no machine named ${missing.join(", ")}` });
        }
        return authorityListOf({
          view: authorityViewOf(read, machines),
          named: named.filter((machine): machine is AuthorityMachineFacts => machine !== undefined),
        });
      });

    const alone = (args: AuthorityAloneArgs): Effect.Effect<AuthorityAloneData, FleetDriverError | AuthorityRefused> =>
      Effect.gen(function* () {
        const [read] = yield* host.status(args.canvas);
        if (read === undefined) {
          return yield* new AuthorityRefused({ code: "not_found", message: `there is no canvas ${args.canvas}` });
        }
        const { machines } = yield* host.machines();
        const view = authorityViewOf(read, machines);
        if (!view.list.some((machine) => machine.installationId === view.self.installationId)) {
          return yield* new AuthorityRefused({
            code: "conflict",
            message: `${view.self.label} is not on ${args.canvas}'s authority list, so it cannot take it alone`,
          });
        }
        if (view.list.length !== 2) {
          return yield* new AuthorityRefused({
            code: "conflict",
            message: `alone is only for a canvas listed on two machines; ${args.canvas} lists ${view.list.length}`,
          });
        }
        if (view.canCommit) {
          return yield* new AuthorityRefused({
            code: "conflict",
            message: `${view.self.label} can still take changes for ${args.canvas}; alone is only for a pair that cannot`,
          });
        }
        const after = yield* host.alone(args.canvas);
        return {
          canvas: args.canvas,
          term: after.term,
          authority: after.self,
          warning: authorityAloneWarning({
            canvas: args.canvas,
            self: view.self.label,
            other: authorityPairOf(view).other?.label ?? null,
            pending: view.pending !== null,
          }),
        };
      });

    const run = (request: OperatorRequestEnvelope): Effect.Effect<unknown, unknown> => {
      switch (request.op) {
        case "authority.status": return status(request.args);
        case "authority.list": return list(request.args);
        case "authority.alone": return alone(request.args);
        default: return Effect.die(new Error(`${request.op} is not an authority op`));
      }
    };

    const encode = (request: OperatorRequestEnvelope, data: unknown): OperatorResponseEnvelope => {
      const decoded = decodeOperatorResponse({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data });
      if (Result.isSuccess(decoded)) return decoded.success;
      return {
        protocol: OPERATOR_PROTOCOL_VERSION,
        id: request.id,
        op: request.op,
        ok: false,
        error: { type: "internal_error", message: "the authority answer did not match its contract", details: { retryable: false } },
      };
    };

    return {
      dispatch: (request: OperatorRequestEnvelope): Effect.Effect<OperatorResponseEnvelope> => {
        if (!options.enabled) {
          return Effect.succeed({
            protocol: OPERATOR_PROTOCOL_VERSION,
            id: request.id,
            op: request.op,
            ok: false,
            error: { type: "forbidden", message: "authority is not enabled in this build", details: { retryable: false } },
          });
        }
        return run(request).pipe(
          Effect.map((data) => encode(request, data)),
          Effect.catch((cause: unknown) =>
            Effect.succeed({
              protocol: OPERATOR_PROTOCOL_VERSION,
              id: request.id,
              op: request.op,
              ok: false,
              error: {
                type: cause instanceof AuthorityRefused ? cause.code : cause instanceof FleetDriverError ? "io" : "internal_error",
                message: cause instanceof Error ? cause.message : "the authority command failed",
                details: { retryable: cause instanceof FleetDriverError && cause.retryable === true },
              },
            } satisfies OperatorResponseEnvelope),
          ),
        );
      },
    } satisfies AuthorityOwnerActions;
  });

