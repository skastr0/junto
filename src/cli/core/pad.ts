/**
 * CLI projections over pad.read. Work plane stays pad.read / pad.patch.
 */
import { Result, Schema } from "effect";
import { Pad } from "../../shared/pad";
import {
  padLookHere,
  padToFocused,
  PadLookHere,
  type PadFocusedItem,
} from "../../shared/pad-project";
import { InputError } from "./errors";

export const PadReadResult = Schema.Struct({
  revision: Schema.Number,
  pad: Pad,
  digest: Schema.String,
  svg: Schema.String,
  lookHere: Schema.optionalKey(PadLookHere),
});
export type PadReadResult = typeof PadReadResult.Type;

const CapabilitiesSeat = Schema.Struct({
  node: Schema.Struct({
    id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  }),
}).annotate({
  parseOptions: { onExcessProperty: "ignore" },
});

export const decodePadReadResult = (
  value: unknown,
): Result.Result<PadReadResult, InputError> => {
  const decoded = Schema.decodeUnknownResult(PadReadResult)(value);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new InputError({
        message: decoded.failure.message,
        path: "pad.read",
        hint: "expected { revision, pad, digest, svg } from pad.read",
      }),
    );
  }
  return Result.succeed(decoded.success);
};

export const callerNodeIdFromCapabilities = (value: unknown): string | undefined => {
  const decoded = Schema.decodeUnknownResult(CapabilitiesSeat)(value);
  return Result.isSuccess(decoded) ? decoded.success.node.id : undefined;
};

export const projectPadDigest = (read: PadReadResult) => ({
  revision: read.revision,
  digest: read.digest,
});

export const projectPadSvg = (read: PadReadResult) => ({
  revision: read.revision,
  svg: read.svg,
});

export const projectPadLookHere = (
  read: PadReadResult,
  pinId: string,
): Result.Result<
  { readonly revision: number; readonly pinId: string } & PadLookHere,
  InputError
> => {
  if (read.lookHere !== undefined) {
    return Result.succeed({
      revision: read.revision,
      pinId,
      ...read.lookHere,
    });
  }
  const crop = padLookHere(read.pad, pinId);
  if (Result.isFailure(crop)) {
    return Result.fail(
      new InputError({
        message: crop.failure.message,
        path: "pinId",
        received: pinId,
        hint: "use a pin id from pad read or pad tagged",
      }),
    );
  }
  return Result.succeed({
    revision: read.revision,
    pinId,
    ...crop.success,
  });
};

export const projectPadGet = (
  read: PadReadResult,
  id?: string,
): Result.Result<
  { readonly revision: number; readonly items: ReadonlyArray<PadFocusedItem> },
  InputError
> => {
  const items = padToFocused(read.pad);
  if (id === undefined) return Result.succeed({ revision: read.revision, items });
  const found = items.filter((item) => item.id === id);
  if (found.length === 0) {
    return Result.fail(
      new InputError({
        message: `element "${id}" is not on this pad`,
        path: "id",
        received: id,
        hint: "omit id to list focused items, or pass an id from pad read",
      }),
    );
  }
  return Result.succeed({ revision: read.revision, items: found });
};

export const projectPadTagged = (read: PadReadResult, seatNodeId: string) => ({
  revision: read.revision,
  pins: read.pad.pins.filter((pin) => pin.mentions.includes(seatNodeId)),
});
