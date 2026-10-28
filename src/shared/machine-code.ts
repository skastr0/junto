/**
 * The owner's code allowance commands (docs/security-doctrine.md, Code steps,
 * check 4): `junto machine code allow|deny|show`, answered by this machine's
 * core over the owner socket. Machine-local: nothing here crosses a link.
 */
import { Schema } from "effect";
import { InstallationId } from "./installation-id";

/** Who may have authored code this machine runs: the operator alone, or overseer seats too. */
export const CodeAllowanceScope = Schema.Literals(["operator", "operator-and-overseers"]);
export type CodeAllowanceScope = typeof CodeAllowanceScope.Type;

/** The operator's decision (05): allowed means operator and overseers unless narrowed. */
export const DEFAULT_CODE_ALLOWANCE_SCOPE: CodeAllowanceScope = "operator-and-overseers";

const CanvasName = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));
/** A machine's short name or an installation id, as the owner typed it. */
const RulerName = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128)));

export const MachineCodeAllowInput = Schema.Struct({
  canvas: CanvasName,
  /** Replaces the stored list whole. Absent: the canvas's ruling installation as this machine holds it. */
  rulers: Schema.optionalKey(Schema.Array(RulerName).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(16)))),
  scope: Schema.optionalKey(CodeAllowanceScope),
});
export type MachineCodeAllowInput = typeof MachineCodeAllowInput.Type;

export const MachineCodeCanvasInput = Schema.Struct({ canvas: CanvasName });
export type MachineCodeCanvasInput = typeof MachineCodeCanvasInput.Type;

export const MachineCodeShowInput = Schema.Struct({ canvas: Schema.optionalKey(CanvasName) });
export type MachineCodeShowInput = typeof MachineCodeShowInput.Type;

/** A trusted ruler: its id, and the machine name this machine knows it by. */
export const MachineCodeRuler = Schema.Struct({
  installationId: InstallationId,
  machineName: Schema.optionalKey(Schema.String),
});
export type MachineCodeRuler = typeof MachineCodeRuler.Type;

export const MachineCodeAllowance = Schema.Struct({
  canvas: CanvasName,
  scope: CodeAllowanceScope,
  rulers: Schema.Array(MachineCodeRuler),
});
export type MachineCodeAllowance = typeof MachineCodeAllowance.Type;

/** One canvas after allow, deny or show: its allowance, or null when this machine runs no code for it. */
export const MachineCodeAllowed = Schema.Struct({
  canvas: CanvasName,
  allowance: Schema.NullOr(MachineCodeAllowance),
});
export type MachineCodeAllowed = typeof MachineCodeAllowed.Type;

export const MachineCodeShown = Schema.Struct({ allowances: Schema.Array(MachineCodeAllowance) });
export type MachineCodeShown = typeof MachineCodeShown.Type;
