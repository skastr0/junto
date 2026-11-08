import { foldArtifactLabels, type ArtifactLabel } from "../../shared/artifact-labels";
import { SIGNAL_MAX_MIN_WORDS, type AgentSignalKind, type SignalFormRequest } from "../../shared/agent-signals";
import { InputError } from "./errors";

/**
 * The reply form a seat asks for when it raises a signal (0.11/07, N4): what
 * the operator produces right in the signal. One per signal; text, today's
 * reply, is the default and needs none. The shape is N1's
 * `SignalFormRequest`; main resolves the node in the seat's reach and
 * refuses a secret until the vault (N5).
 */

/** The environment variable the seat reads, as region env sources name it (model/region.ts EnvName). */
export const SIGNAL_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

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
    if (!SIGNAL_SECRET_NAME_PATTERN.test(name)) {
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
  if (flags.minWords !== undefined && (!Number.isInteger(flags.minWords) || flags.minWords < 1 || flags.minWords > SIGNAL_MAX_MIN_WORDS)) {
    return refuse(`--min-words is 1 to ${SIGNAL_MAX_MIN_WORDS}`, "--min-words");
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
