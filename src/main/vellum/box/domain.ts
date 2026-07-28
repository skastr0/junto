import { Schema } from "effect";

export const BoxId = Schema.String.pipe(
  Schema.pattern(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/u),
  Schema.brand("BoxId"),
);
export type BoxId = typeof BoxId.Type;

export const BoxMachineState = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(32),
);
export type BoxMachineState = typeof BoxMachineState.Type;

export const BoxMachine = Schema.Struct({
  id: BoxId,
  name: Schema.String,
  ip: Schema.NullOr(Schema.String),
  state: BoxMachineState,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type BoxMachine = typeof BoxMachine.Type;

export const BoxMachineEnvelope = Schema.Struct({
  box: BoxMachine,
});

export const BoxCliStatus = Schema.Struct({
  account: Schema.Struct({
    identifier: Schema.String,
    loginState: Schema.String,
    plan: Schema.String,
    status: Schema.String,
  }),
  api: Schema.Struct({
    healthy: Schema.Boolean,
    status: Schema.String,
    url: Schema.String,
  }),
  config: Schema.Struct({
    apiUrl: Schema.String,
    channel: Schema.String,
    path: Schema.String,
  }),
});
export type BoxCliStatus = typeof BoxCliStatus.Type;

export interface BoxCliAvailability {
  readonly available: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly authenticated: boolean;
  readonly healthy: boolean;
  readonly account?: string;
  readonly detail: string;
}

export class BoxCliUnavailableError extends Schema.TaggedError<BoxCliUnavailableError>()(
  "BoxCliUnavailableError",
  {
    detail: Schema.String,
  },
) {}

export class BoxCliCommandError extends Schema.TaggedError<BoxCliCommandError>()(
  "BoxCliCommandError",
  {
    operation: Schema.String,
    detail: Schema.String,
    exitCode: Schema.optionalWith(Schema.Number, { exact: true }),
  },
) {}

export class BoxCliProtocolError extends Schema.TaggedError<BoxCliProtocolError>()(
  "BoxCliProtocolError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {}

export type BoxCliError =
  | BoxCliUnavailableError
  | BoxCliCommandError
  | BoxCliProtocolError;

