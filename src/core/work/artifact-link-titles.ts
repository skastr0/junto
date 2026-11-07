/**
 * `[[Title]]` in a seat's `junto artifact create|edit`, resolved (plan 0.11,
 * 02, L5): each title to the one artifact of that title in the seat's reach,
 * written as the link the app's `[[` picker writes (`artifactLink`). A title
 * is matched trimmed and without case. An artifact id in the brackets names
 * that artifact, so a seat can pick one of several. No match, or several, is
 * refused naming the candidates, and nothing is written.
 */
import { Result } from "effect";
import { artifactLink } from "@shared/artifact-link";
import type { ResolveTitle } from "@shared/artifact-link-tokens";
import type { NodeId } from "@shared/physics/schema";
import type { TargetCandidate, WorkErrorBody } from "@shared/work-control";
import type { ItemId } from "@shared/work-ids";
import { nearestOf } from "./authz";

/** An artifact a title may name: not archived, on an Artifacts node in the seat's reach. */
export type TitleCandidate = { readonly artifactId: ItemId; readonly nodeId: NodeId; readonly title: string };

const fold = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

const line = (candidate: TitleCandidate): string => `${candidate.title} [${candidate.artifactId}]`;

/** A candidate as every refusal names one (`TargetCandidate`). */
const named = (candidate: TitleCandidate): TargetCandidate =>
  ({ kind: "artifacts", nodeId: candidate.nodeId, itemId: candidate.artifactId, name: candidate.title });

export const resolveArtifactTitles = (
  candidates: ReadonlyArray<TitleCandidate>,
  canvasName: string,
  path: string,
): ResolveTitle<WorkErrorBody> => (title): Result.Result<string, WorkErrorBody> => {
  const typed = `[[${title}]]`;
  const byId = candidates.filter((candidate) => candidate.artifactId === title);
  const matches = byId.length > 0 ? byId : candidates.filter((candidate) => fold(candidate.title) === fold(title));
  if (matches.length === 1) {
    const [found] = matches as [TitleCandidate];
    return Result.succeed(artifactLink({ kind: "artifact", nodeId: found.nodeId, artifactId: found.artifactId }, found.title, canvasName));
  }
  if (matches.length > 1) {
    return Result.fail({
      type: "InputError",
      message: `${typed} names ${matches.length} artifacts you can reach: ${matches.map(line).join("; ")}`,
      details: {
        path,
        target: typed,
        retryable: false,
        candidates: matches.map(named),
        next_step: "write [[<artifactId>]] for the one you mean",
      },
    });
  }
  const nearest = nearestOf(title, candidates.map((candidate) => candidate.title));
  const near = candidates.filter((candidate) => nearest.includes(candidate.title));
  return Result.fail({
    type: "UnknownTarget",
    message: near.length === 0
      ? `${typed}: no artifact you can reach is titled "${title.trim()}"`
      : `${typed}: no artifact you can reach is titled "${title.trim()}"; nearest: ${near.map(line).join("; ")}`,
    details: {
      path,
      target: typed,
      retryable: false,
      candidates: near.map(named),
      next_step: "write one of these titles, create the artifact first, or write \\[[ to keep the brackets as text",
    },
  });
};
