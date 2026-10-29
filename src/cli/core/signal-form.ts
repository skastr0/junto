import { Schema } from "effect";
import { ARTIFACT_LABELS_MAX, foldArtifactLabels, type ArtifactLabel } from "../../shared/artifact-labels";
import { AGENT_SIGNAL_MAX_TEXT_LENGTH, type AgentSignalKind } from "../../shared/agent-signals";
import { AUTOMATION_SIGNAL_MIN_WORDS_MAX } from "../../shared/automation";
import { InputError } from "./errors";

/**
 * The reply form a seat asks for when it raises a signal (0.11/07, N4): what
 * the operator produces right in the signal. One per signal; text, today's
 * reply, is the default and needs none.
 *
 * Stand-in of N1's `SignalFormRequest` (product-feed's names): switch to the
 * shared schema when it lands. Until then main's strict `SignalRaiseArgs`
 * refuses `form`, so a form flag is refused there, plainly.
 */

/** The environment variable the seat reads, as region env sources name it (model/region.ts EnvName). */
export const SIGNAL_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** The bound the automation signal form has too (automation.ts SecretName). */
const SIGNAL_SECRET_NAME_MAX = 128;
/** The most words an artifact form can ask for, as the automation signal form bounds it. */
export const SIGNAL_FORM_MIN_WORDS_MAX = AUTOMATION_SIGNAL_MIN_WORDS_MAX;

export const SignalSecretName = Schema.String.check(
  Schema.isPattern(SIGNAL_SECRET_NAME_PATTERN),
  Schema.isMaxLength(SIGNAL_SECRET_NAME_MAX),
);

const NodeText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SignalFormRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text") }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    node: NodeText,
    title: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(AGENT_SIGNAL_MAX_TEXT_LENGTH))),
    labels: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(ARTIFACT_LABELS_MAX))),
    minWords: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SIGNAL_FORM_MIN_WORDS_MAX }))),
  }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("secret"), name: SignalSecretName }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("proof") }).annotate(strict),
]);
export type SignalFormRequest = typeof SignalFormRequest.Type;

/** The kinds that can ask for a form; feedback asks the operator to review, nothing more. */
export const FORM_SIGNAL_KINDS: ReadonlySet<AgentSignalKind> = new Set(["blocked", "escalate"]);

export type FormFlags = {
  readonly askSecret?: string | undefined;
  readonly askArtifact?: string | undefined;
  readonly minWords?: number | undefined;
  readonly label?: ReadonlyArray<string> | undefined;
  readonly askProof?: boolean | undefined;
};

type Refused = { readonly ok: false; readonly error: InputError };
type Planned = { readonly ok: true; readonly form: SignalFormRequest | undefined } | Refused;

const refuse = (message: string, path: string, hint?: string): Refused => ({
  ok: false,
  error: new InputError({ message, path, ...(hint === undefined ? {} : { hint }) }),
});

/** Labels as the store holds them: folded, unique, sorted; the first that cannot be one is refused where it was typed. */
const foldLabels = (labels: ReadonlyArray<string>, at: (index: number) => string): { readonly ok: true; readonly labels: ReadonlyArray<ArtifactLabel> } | Refused => {
  const folded = foldArtifactLabels(labels);
  return folded.ok ? folded : refuse(folded.message, at(folded.index ?? 0));
};

/**
 * Pure: the form the flags ask for, or why not. At most one form flag;
 * --min-words and --label only with --ask-artifact. Checked before anything
 * is read or sent.
 */
export const planFormFlags = (kind: AgentSignalKind, flags: FormFlags): Planned => {
  const label = flags.label ?? [];
  const given = [
    ...(flags.askSecret === undefined ? [] : ["--ask-secret"]),
    ...(flags.askArtifact === undefined ? [] : ["--ask-artifact"]),
    ...(flags.askProof === true ? ["--ask-proof"] : []),
  ];
  if (given.length === 0) {
    if (flags.minWords !== undefined) return refuse("--min-words sets the words an artifact form asks for", "--min-words", "add --ask-artifact <Artifacts node>");
    if (label.length > 0) return refuse("--label labels the artifact an artifact form makes", "--label", "add --ask-artifact <Artifacts node>");
    return { ok: true, form: undefined };
  }
  if (!FORM_SIGNAL_KINDS.has(kind)) {
    return refuse(`${kind} asks for no form: only blocked and escalate ask the operator to produce something`, given[0]!);
  }
  if (given.length > 1) return refuse(`one form per signal: ${given.join(" and ")} given`, given[1]!, "ask for one now, and raise another signal for the next");
  if (flags.askSecret !== undefined) {
    if (flags.minWords !== undefined || label.length > 0) return refuse("--min-words and --label go with --ask-artifact", flags.minWords !== undefined ? "--min-words" : "--label");
    const name = flags.askSecret.trim();
    if (!SIGNAL_SECRET_NAME_PATTERN.test(name) || name.length > SIGNAL_SECRET_NAME_MAX) {
      return refuse(`${JSON.stringify(flags.askSecret)} is not a secret name: the environment variable you read, letters, digits and _, not starting with a digit`, "--ask-secret", 'junto blocked "Need the Cloudflare token." --ask-secret CLOUDFLARE_API_TOKEN');
    }
    return { ok: true, form: { kind: "secret", name } };
  }
  if (flags.askProof === true) {
    if (flags.minWords !== undefined || label.length > 0) return refuse("--min-words and --label go with --ask-artifact", flags.minWords !== undefined ? "--min-words" : "--label");
    return { ok: true, form: { kind: "proof" } };
  }
  const node = flags.askArtifact!.trim();
  if (node === "") return refuse("--ask-artifact names the Artifacts node the reply is written into", "--ask-artifact");
  if (flags.minWords !== undefined && (!Number.isInteger(flags.minWords) || flags.minWords < 1 || flags.minWords > SIGNAL_FORM_MIN_WORDS_MAX)) {
    return refuse(`--min-words is 1 to ${SIGNAL_FORM_MIN_WORDS_MAX}`, "--min-words");
  }
  const folded = foldLabels(label, (index) => `--label[${index}]`);
  if (!folded.ok) return folded;
  return {
    ok: true,
    form: {
      kind: "artifact",
      node,
      ...(flags.minWords === undefined ? {} : { minWords: flags.minWords }),
      ...(folded.labels.length === 0 ? {} : { labels: folded.labels }),
    },
  };
};

/** A form from the JSON input, its labels folded as the flags fold them. */
export const foldFormInput = (kind: AgentSignalKind, form: SignalFormRequest): Planned => {
  if (form.kind === "text") return { ok: true, form };
  if (!FORM_SIGNAL_KINDS.has(kind)) return refuse(`${kind} asks for no form: only blocked and escalate ask the operator to produce something`, "form");
  if (form.kind !== "artifact" || form.labels === undefined) return { ok: true, form };
  const folded = foldLabels(form.labels, (index) => `form.labels[${index}]`);
  if (!folded.ok) return folded;
  return { ok: true, form: { ...form, ...(folded.labels.length === 0 ? {} : { labels: folded.labels }) } };
};
