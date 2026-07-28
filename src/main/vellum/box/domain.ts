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
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type BoxMachine = typeof BoxMachine.Type;

export const BoxMachineEnvelope = Schema.Struct({
  box: BoxMachine,
});

export const BoxActionEnvelope = Schema.Struct({
  id: BoxId,
  status: Schema.String,
  box: Schema.NullOr(BoxMachine),
});

export const BoxNewCreatedLine = Schema.Struct({
  event: Schema.Literal("created"),
  id: BoxId,
  ttlSeconds: Schema.NullOr(Schema.Number),
});

export const BoxNewStateLine = Schema.Struct({
  event: Schema.Literal("state"),
  id: BoxId,
  state: BoxMachineState,
});

export const BoxNewReadyLine = Schema.Struct({
  event: Schema.Literal("ready"),
  id: BoxId,
  state: BoxMachineState,
  ip: Schema.NullOr(Schema.String),
});

export const BoxNewErrorLine = Schema.Struct({
  event: Schema.Literal("error"),
  error: Schema.String,
  code: Schema.optionalWith(Schema.String, { exact: true }),
  status: Schema.optionalWith(Schema.Number, { exact: true }),
});

export const BoxNewLine = Schema.Union(
  BoxNewCreatedLine,
  BoxNewStateLine,
  BoxNewReadyLine,
  BoxNewErrorLine,
);

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
    boxId: Schema.optionalWith(BoxId, { exact: true }),
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
