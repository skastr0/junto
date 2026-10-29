/**
 * Where a capture might go (docs/plans/0.11/11-quick-capture.md, Q5): up to
 * three Artifacts nodes, ranked by what the capture itself points at. A
 * suggestion is only offered; a route is the move from 10-artifact-move.md,
 * and nothing routes on its own.
 *
 * Four things point, each worth a fixed share so no one of them drowns the
 * rest:
 * - a link to an artifact points at the node that holds it now, found by id
 *   (a link's node is only a hint, 10);
 * - a mention of a seat, a Tasks node or a page points at the Artifacts nodes
 *   in its reach, its share split among them;
 * - a label points at the nodes whose artifacts carry it, its share split by
 *   how many carry it in each;
 * - the artifacts most like it in words point at the nodes that hold them.
 *
 * Pure: the caller hands it the canvas and every artifact's text. It never
 * suggests the node the capture is on, or a node that is not an Artifacts
 * node on this canvas.
 */
import { mentionLinksOf } from "./mention";
import type { NodeId } from "./physics/schema";
import { reaches, type ReachCanvas } from "./region-reach";
import type { ItemId } from "./work-ids";

export const CAPTURE_ROUTES_MAX = 3;

/** What a capture's routes read of an artifact: where it is, its words and its labels. */
export type RouteArtifact = {
  readonly artifactId: ItemId;
  readonly nodeId: NodeId;
  readonly title: string;
  /** The body as text (`artifactText`), links in it as written. */
  readonly text: string;
  readonly labels: ReadonlyArray<string>;
  readonly archived: boolean;
};

/** Why a node is suggested, its strongest reason first. */
export type RouteReason = "links" | "mentions" | "labels" | "similar";

export type CaptureRoute = {
  readonly nodeId: NodeId;
  readonly score: number;
  readonly reasons: ReadonlyArray<RouteReason>;
};

/** Each linked artifact's share, each mention's, each label's, and each similar artifact's at full likeness. */
const WEIGHT = { links: 3, mentions: 2, labels: 2, similar: 2 } as const satisfies Record<RouteReason, number>;
/** How many of the most similar artifacts point, and how alike one must be to point at all. */
const SIMILAR_TOP = 5;
const SIMILAR_FLOOR = 0.12;

/** Words too common to make two texts alike. */
const STOP = new Set(
  "the and for are but not you all any can had her was one our out has have this that with from they will would there their what about which when make like time just know take into year your some them than then look only come over also back after use two how first well way even new want because these give most into been were said each".split(
    " ",
  ),
);

/** A text's words for likeness: links read as their labels, lower case, three letters or more. */
const wordsOf = (text: string): ReadonlyArray<string> => {
  let plain = "";
  let at = 0;
  for (const link of mentionLinksOf(text)) {
    plain += `${text.slice(at, link.start)} ${link.label} `;
    at = link.end;
  }
  plain += text.slice(at);
  return (plain.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOP.has(word));
};

type Vector = ReadonlyMap<string, number>;

const counts = (words: ReadonlyArray<string>): Map<string, number> => {
  const out = new Map<string, number>();
  for (const word of words) out.set(word, (out.get(word) ?? 0) + 1);
  return out;
};

/** TF-IDF cosine over `docs`: each doc's weighted vector, unit length. */
const vectors = (docs: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<Vector> => {
  const df = new Map<string, number>();
  const tfs = docs.map(counts);
  for (const tf of tfs) for (const word of tf.keys()) df.set(word, (df.get(word) ?? 0) + 1);
  return tfs.map((tf) => {
    const out = new Map<string, number>();
    let norm = 0;
    for (const [word, n] of tf) {
      const weight = (1 + Math.log(n)) * Math.log(1 + docs.length / (df.get(word) ?? 1));
      out.set(word, weight);
      norm += weight * weight;
    }
    const length = Math.sqrt(norm);
    if (length > 0) for (const [word, weight] of out) out.set(word, weight / length);
    return out;
  });
};

const cosine = (a: Vector, b: Vector): number => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [word, weight] of small) sum += weight * (large.get(word) ?? 0);
  return sum;
};

/** Up to `CAPTURE_ROUTES_MAX` Artifacts nodes for `capture`, the best first; none when nothing points anywhere. */
export const captureRoutes = (
  canvas: ReachCanvas,
  capture: RouteArtifact,
  artifacts: ReadonlyArray<RouteArtifact>,
): ReadonlyArray<CaptureRoute> => {
  const isArtifactsNode = (id: NodeId): boolean => canvas.nodes.get(id)?.kind === "artifacts";
  const destinations = [...canvas.nodes.values()]
    .filter((node) => node.kind === "artifacts" && node.id !== capture.nodeId)
    .map((node) => node.id);
  const scores = new Map<NodeId, Record<RouteReason, number>>();
  const add = (nodeId: NodeId, reason: RouteReason, amount: number): void => {
    if (nodeId === capture.nodeId || !isArtifactsNode(nodeId) || amount <= 0) return;
    const held = scores.get(nodeId) ?? { links: 0, mentions: 0, labels: 0, similar: 0 };
    held[reason] += amount;
    scores.set(nodeId, held);
  };
  const others = artifacts.filter((other) => other.artifactId !== capture.artifactId);
  const byId = new Map(others.map((other) => [other.artifactId, other]));

  // Links and mentions, each thing pointed at once.
  const seen = new Set<string>();
  for (const { target } of mentionLinksOf(capture.text)) {
    const key = `${target.nodeId}\u0000${target.item ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = canvas.nodes.get(target.nodeId)?.kind;
    if (target.item !== undefined && (kind === "artifacts" || byId.has(target.item))) {
      if (target.item === capture.artifactId) continue;
      add(byId.get(target.item)?.nodeId ?? target.nodeId, "links", WEIGHT.links);
    } else if (kind === "artifacts") {
      add(target.nodeId, "mentions", WEIGHT.mentions);
    } else if (kind !== undefined) {
      const near = destinations.filter((id) => reaches(canvas, target.nodeId, id));
      for (const id of near) add(id, "mentions", WEIGHT.mentions / near.length);
    }
  }

  const live = others.filter((other) => !other.archived);

  for (const label of new Set(capture.labels)) {
    const carriers = live.filter((other) => other.labels.includes(label));
    for (const other of carriers) add(other.nodeId, "labels", WEIGHT.labels / carriers.length);
  }

  const words = wordsOf(`${capture.title}\n${capture.text}`);
  if (words.length > 0 && live.length > 0) {
    const [mine, ...theirs] = vectors([words, ...live.map((other) => wordsOf(`${other.title}\n${other.text}`))]);
    live
      .map((other, index) => ({ other, likeness: cosine(mine!, theirs[index]!) }))
      .filter(({ likeness }) => likeness >= SIMILAR_FLOOR)
      .sort((a, b) => b.likeness - a.likeness)
      .slice(0, SIMILAR_TOP)
      .forEach(({ other, likeness }) => add(other.nodeId, "similar", WEIGHT.similar * likeness));
  }

  return [...scores]
    .map(([nodeId, by]) => ({
      nodeId,
      score: by.links + by.mentions + by.labels + by.similar,
      reasons: (Object.keys(by) as Array<RouteReason>).filter((reason) => by[reason] > 0).sort((a, b) => by[b] - by[a]),
    }))
    .sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    .slice(0, CAPTURE_ROUTES_MAX);
};

/** A suggestion's reason in words, as the picker says it under the node's name. */
export const routeReasonLine = (reason: RouteReason): string => {
  switch (reason) {
    case "links":
      return "What it links to is here";
    case "mentions":
      return "What it mentions works here";
    case "labels":
      return "Its labels are used here";
    case "similar":
      return "Artifacts like it are here";
  }
};
