/**
 * The window's terminal-picker reads (term/ipc.ts): the managed harnesses
 * installed on this machine, their profiles, and the launch flags a harness
 * offers. They ask the filesystem and the shells, so main asks the core,
 * where the terminal plane's own spawn paths read the same templates. A probe
 * that cannot run answers nothing installed, so none of these has an error to
 * act on beyond the core leaving.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { HarnessId, IsolationSpec, MailTransportSpec } from "../../shared/managed-terminal-templates";
import { coreClient } from "./link";

/** A named profile a harness keeps, and the model it runs. */
export const ManagedTerminalProfileOption = Schema.Struct({
  name: Schema.String,
  model: Schema.String,
  gateway: Schema.optional(Schema.String),
});

export const ManagedTerminalProfilesResult = Schema.Struct({
  profiles: Schema.Array(ManagedTerminalProfileOption),
  source: Schema.Literals(["cache", "aliases", "command", "empty"]),
  error: Schema.optional(Schema.String),
});

/** One managed harness on this machine: whether its binary resolves, and its mail and isolation facts. */
export const HarnessInstallProbe = Schema.Struct({
  harness: HarnessId,
  displayName: Schema.String,
  binary: Schema.String,
  /** True when an executable for the harness binary resolves. */
  installed: Schema.Boolean,
  /** The executable discovery found; absent when not installed. */
  executable: Schema.optional(Schema.String),
  mailTransport: MailTransportSpec,
  isolation: IsolationSpec,
});

/** One option line of a harness's `--help`. */
export const HarnessHelpFlag = Schema.Struct({
  /** Preferred spelling: the long form when the help line lists one. */
  flag: Schema.String,
  /** Other spellings on the same help line (`-m` beside `--model`). */
  aliases: Schema.Array(Schema.String),
  /** Value placeholder as printed (`<MODE>`, `LEVEL`); absent for a switch. */
  value: Schema.optional(Schema.String),
  description: Schema.String,
});

/** Launch options one installed harness reports about itself. */
export const ManagedTerminalFlagsResult = Schema.Struct({
  installed: Schema.Boolean,
  flags: Schema.Array(HarnessHelpFlag),
  /** Built-in and publicly enumerated plugin modes, when the harness has them. */
  modes: Schema.optional(Schema.Array(Schema.String)),
});

/** A harness's flags, asked in the folder the seat starts in when the window names one. */
export const TermTemplatesFlagsAsk = Schema.Struct({ harness: HarnessId, cwd: Schema.optional(Schema.String) });

export const TermTemplatesRpcs = RpcGroup.make(
  Rpc.make("TermTemplatesManagedProfiles", { success: ManagedTerminalProfilesResult }),
  Rpc.make("TermTemplatesHarnessInstalls", {
    success: Schema.Struct({ harnesses: Schema.Array(HarnessInstallProbe) }),
  }),
  Rpc.make("TermTemplatesHarnessFlags", { payload: TermTemplatesFlagsAsk, success: ManagedTerminalFlagsResult }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the picker reads. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class TermTemplatesCore extends Context.Service<
  TermTemplatesCore,
  RpcClient.FromGroup<typeof TermTemplatesRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/TermTemplatesCore") {
  static readonly layer = Layer.effect(TermTemplatesCore, coreClient(TermTemplatesRpcs));
}
