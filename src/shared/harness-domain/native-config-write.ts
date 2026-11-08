/**
 * Why a machine could not write a declared native setting after it was
 * admitted (docs/machines.md, Harness inventory: native config). A refusal
 * before any file is read is `NativeSettingRefusedError`; this is what can
 * go wrong at the file itself.
 *
 * - conflict: the file changed since that machine last read it, so the
 *   operator reads it again before writing; nothing was written.
 * - unsupported: the file holds the key in a shape Junto does not edit in
 *   place (a TOML table key, an unparsable file); nothing was written.
 * - io: the read, the backup or the replace failed.
 */
import { Schema } from "effect";

export class NativeConfigWriteError extends Schema.TaggedError<NativeConfigWriteError>()(
  "NativeConfigWriteError",
  {
    machine: Schema.String,
    harness: Schema.String,
    key: Schema.String,
    reason: Schema.Literals(["conflict", "unsupported", "io"]),
    message: Schema.String,
  },
) {}

export type NativeSettingValueRead = boolean | string | number;
