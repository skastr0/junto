/**
 * Artifact labels (0.11, 03): grouping words an artifact carries, set in its
 * header or from the CLI, never typed in body text (a `#` there mentions a
 * task or an artifact). An Artifacts node stays one flat list; a label is
 * how the operator groups it and filters the sidebar.
 *
 * A label is lowercase, 1 to 40 characters of `a-z 0-9 - _ /` and space, with
 * no leading or trailing `/` or space and no `//`. A `/` reads as a level
 * (`project/junto/release`) for filtering only: nothing treats it as a
 * hierarchy. Case folds on input, at the edge where a person or a seat types
 * one; the op and the fact carry the canonical set.
 *
 * `artifactLabelsMatch` is the one filter rule, shared by the sidebar (T2)
 * and the CLI (T4): an artifact shows when it has every wanted label, and a
 * wanted label also matches the levels under it.
 */
import { Schema } from "effect";

export const ARTIFACT_LABEL_MAX_LENGTH = 40;
export const ARTIFACT_LABELS_MAX = 20;

/**
 * The canonical form: already folded, no leading or trailing `/` or space, no
 * `//`. A label written any other way is not this schema's value; the
 * fold-on-input edge is `artifactLabelOf`.
 */
const LABEL = /^(?!.*\/\/)[a-z0-9_-](?:[a-z0-9 _/-]{0,38}[a-z0-9_-])?$/;

export const ArtifactLabel = Schema.String.pipe(
  Schema.check(Schema.isPattern(LABEL)),
  Schema.brand("ArtifactLabel"),
);
export type ArtifactLabel = typeof ArtifactLabel.Type;

/** One label, canonical: what a stored row and a folded set hold. */
export const decodeArtifactLabel = Schema.decodeUnknownResult(ArtifactLabel);

/** A set as the op and the fact carry it: unique and sorted, so two machines read the same bytes. */
const sortedUnique = Schema.makeFilter((labels: ReadonlyArray<ArtifactLabel>) =>
  labels.every((label, index) => index === 0 || (labels[index - 1] as string) < label) ||
  "labels are unique and sorted",
);

export const ArtifactLabels = Schema.Array(ArtifactLabel).pipe(
  Schema.check(Schema.isMaxLength(ARTIFACT_LABELS_MAX)),
  Schema.check(sortedUnique),
);
export type ArtifactLabels = typeof ArtifactLabels.Type;

/**
 * Fold one label as a person or a seat types it: trimmed, lowercased.
 * Undefined when it breaks the rule, so a caller refuses it rather than
 * storing a word no filter can match.
 */
export const artifactLabelOf = (raw: string): ArtifactLabel | undefined => {
  const folded = raw.trim().toLowerCase();
  const decoded = decodeArtifactLabel(folded);
  return decoded._tag === "Success" ? decoded.success : undefined;
};

/**
 * Fold a whole set: trimmed, lowered, made unique and sorted. Undefined when
 * any label breaks the rule or the set holds more than 20.
 */
export const artifactLabelsOf = (raw: ReadonlyArray<string>): ReadonlyArray<ArtifactLabel> | undefined => {
  const folded: ArtifactLabel[] = [];
  for (const one of raw) {
    const label = artifactLabelOf(one);
    if (label === undefined) return undefined;
    folded.push(label);
  }
  const unique = [...new Set(folded)].sort();
  return unique.length > ARTIFACT_LABELS_MAX ? undefined : unique;
};

/**
 * Whether an artifact carrying `labels` matches a filter: every wanted label
 * must be held, each by equality or by sitting under it (`project/junto`
 * matches `project/junto/release`). An empty filter matches everything.
 */
export const artifactLabelsMatch = (
  labels: ReadonlyArray<ArtifactLabel>,
  wanted: ReadonlyArray<ArtifactLabel>,
): boolean =>
  wanted.every((one) => labels.some((held) => held === one || held.startsWith(`${one}/`)));
