/**
 * The demo's artifact reads (`junto companion-stdio --demo`): the same ops the
 * Mac answers, over the demo fixture's nodes and artifacts
 * (`wire/companion-demo-fixture.ts`), so the phone's artifact screens run with
 * no Mac. One world per demo: the Inbox the phone sets here is the one it reads
 * back.
 */
import { outcomeFail, outcomeOk, type CompanionBackend } from "./companion-core";
import { asNodeId, type Canvas } from "./model";
import { titleOf } from "./model/title";
import { feedRegionForCanvas } from "./operator-feed";
import { artifactText, type ArtifactBody } from "./wire/artifact";
import type { ContentRef } from "./wire/content-ref";
import { artifactLabelsMatch } from "./wire/artifact-labels";
import { COMPANION_ARTIFACT_GET_BUDGET_BYTES, COMPANION_ARTIFACT_HISTORY_DEFAULT, COMPANION_ARTIFACT_SNIPPET_MAX, COMPANION_ARTIFACTS_LIST_DEFAULT } from "./wire/companion-artifact-reads";
import { DEMO_ARTIFACT_LABEL_COLOURS, DEMO_ARTIFACTS, DEMO_RESOURCE_NODES } from "./wire/companion-demo-fixture";
import type { CompanionArtifactNode } from "./wire/companion-artifact-reads";

/** The Inbox the demo starts with: the fixture's node of that name. */
const INITIAL_INBOX = DEMO_RESOURCE_NODES.find((node) => node.kind === "artifacts" && node.label === "Inbox")?.id;

/**
 * A body's ref in the demo: the bytes are the body's JSON, and the digest is a
 * stable stand-in (the demo never hashes), 64 lower-case hex characters that
 * differ by artifact and version.
 */
const demoBodyRef = (artifactId: string, version: number, body: ArtifactBody): ContentRef => {
  let h = 0x811c9dc5;
  const digits: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    for (const ch of `${String(round)}:${artifactId}@${String(version)}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    digits.push(h.toString(16).padStart(8, "0"));
  }
  return { sha256: digits.join(""), byteLength: new TextEncoder().encode(JSON.stringify(body)).length, mediaType: "application/json" } as ContentRef;
};

/** Every version's body by its stand-in digest: the bytes `content.get` serves for a `bodyRef`. */
const BODY_BYTES: ReadonlyMap<string, { readonly ref: ContentRef; readonly bytes: Uint8Array }> = new Map(
  DEMO_ARTIFACTS.flatMap((held) =>
    held.versions.map((record) => {
      const ref = demoBodyRef(held.head.artifactId, record.version, record.body);
      return [ref.sha256, { ref, bytes: new TextEncoder().encode(JSON.stringify(record.body)) }] as const;
    }),
  ),
);

/** The bytes behind a demo `bodyRef`; the files and images artifacts hold are the fixture's own content. */
export const demoArtifactBytes = (sha256: string): Uint8Array | undefined => BODY_BYTES.get(sha256)?.bytes;

/** The refs a demo artifact holds beyond its body: a file's content and a link's content. */
const contentRefsOf = (body: ArtifactBody): ReadonlyArray<ContentRef> =>
  body.type === "file" ? [body.content] : body.type === "link" && body.target.kind === "content" ? [body.target.content] : [];

export const makeDemoArtifactReads = (
  canvas: Canvas,
  isDemoCanvas: (canvasName: string) => boolean,
): Pick<
  CompanionBackend,
  "artifactContentRef" | "artifactNodes" | "artifactList" | "artifactGet" | "artifactHistory" | "artifactPending" | "artifactMoveCheck" | "inboxSet"
> => {
  let inbox: string | undefined = INITIAL_INBOX;
  const artifactsNodes = [...canvas.nodes.values()].filter((node) => node.kind === "artifacts");

  const nodeFacts = (nodeId: string): CompanionArtifactNode => {
    const node = canvas.nodes.get(asNodeId(nodeId))!;
    const held = DEMO_ARTIFACTS.filter((artifact) => artifact.head.nodeId === nodeId);
    return {
      nodeId: asNodeId(nodeId),
      title: titleOf(node),
      region: feedRegionForCanvas(canvas, nodeId),
      live: held.filter((artifact) => !artifact.head.archived).length,
      archived: held.filter((artifact) => artifact.head.archived).length,
      labelColours: DEMO_ARTIFACT_LABEL_COLOURS[nodeId] ?? {},
    };
  };

  return {
    artifactContentRef: async (sha256) =>
      BODY_BYTES.get(sha256)?.ref ??
      DEMO_ARTIFACTS.flatMap((held) => held.versions.flatMap((record) => contentRefsOf(record.body))).find((ref) => ref.sha256 === sha256),
    artifactNodes: async (canvasName) => {
      if (!isDemoCanvas(canvasName)) return outcomeFail("not-found", "No such canvas.");
      return outcomeOk({
        nodes: artifactsNodes.map((node) => nodeFacts(node.id)),
        ...(inbox === undefined ? {} : { inboxNodeId: asNodeId(inbox) }),
      });
    },
    artifactList: async (args) => {
      if (!isDemoCanvas(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      if (args.nodeId !== undefined && !artifactsNodes.some((node) => node.id === args.nodeId)) {
        return outcomeFail("not-found", "That is not one of this canvas's Artifacts nodes.");
      }
      const word = args.query?.trim().toLowerCase() ?? "";
      const rows = DEMO_ARTIFACTS.filter(({ head, body }) =>
        (args.nodeId === undefined || head.nodeId === args.nodeId) &&
        head.archived === (args.archived ?? false) &&
        (args.type === undefined || head.type === args.type) &&
        (args.labels === undefined || artifactLabelsMatch(head.labels, args.labels)) &&
        // The demo's search is a plain word match over the title, type, labels and text; the Mac ranks by the desktop's matcher.
        (word === "" || [head.title, head.type, ...head.labels, artifactText(body)].some((field) => field.toLowerCase().includes(word))),
      ).sort((a, b) => b.head.updatedAt - a.head.updatedAt);
      const offset = args.before === undefined ? 0 : Number(/^o:(\d{1,9})$/u.exec(args.before)?.[1] ?? Number.NaN);
      if (Number.isNaN(offset)) return outcomeFail("invalid", "That page cursor was not given by this list.");
      const limit = args.limit ?? COMPANION_ARTIFACTS_LIST_DEFAULT;
      const page = rows.slice(offset, offset + limit);
      const more = offset + page.length < rows.length;
      return outcomeOk({
        artifacts: page.map(({ head, body }) => ({
          artifactId: head.artifactId,
          nodeId: head.nodeId,
          type: head.type,
          title: head.title,
          version: head.version,
          updatedAt: head.updatedAt,
          archived: head.archived,
          labels: head.labels,
          snippet: artifactText(body).slice(0, COMPANION_ARTIFACT_SNIPPET_MAX),
        })),
        more,
        ...(more ? { next: `o:${String(offset + page.length)}` } : {}),
      });
    },
    artifactGet: async (args) => {
      if (!isDemoCanvas(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      const held = DEMO_ARTIFACTS.find(({ head }) => head.artifactId === args.artifactId);
      if (held === undefined) return outcomeFail("not-found", "That artifact is not on this canvas.");
      const shown = args.version ?? held.head.version;
      const record = held.versions.find((candidate) => candidate.version === shown);
      if (record === undefined) return outcomeFail("not-found", "That artifact has no such version.");
      const colours = DEMO_ARTIFACT_LABEL_COLOURS[held.head.nodeId] ?? {};
      const labelColours = Object.fromEntries(held.head.labels.flatMap((label) => (colours[label] === undefined ? [] : [[label, colours[label]] as const])));
      const result = {
        artifact: held.head,
        version: record.version,
        bodyRef: demoBodyRef(held.head.artifactId, record.version, record.body),
        ...(Object.keys(labelColours).length === 0 ? {} : { labelColours }),
      };
      const whole = { ...result, body: record.body };
      return outcomeOk(new TextEncoder().encode(JSON.stringify(whole)).length <= COMPANION_ARTIFACT_GET_BUDGET_BYTES ? whole : result);
    },
    artifactHistory: async (args) => {
      if (!isDemoCanvas(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      const held = DEMO_ARTIFACTS.find(({ head }) => head.artifactId === args.artifactId);
      if (held === undefined) return outcomeFail("not-found", "That artifact is not on this canvas.");
      // The fixture keeps each version's body, not its edit: a link and a file only ever replace whole, the rest are patched.
      const wholeOnly = held.head.type === "link" || held.head.type === "file";
      const older = held.versions.filter((record) => args.before === undefined || record.version < args.before).reverse();
      const page = older.slice(0, args.limit ?? COMPANION_ARTIFACT_HISTORY_DEFAULT);
      return outcomeOk({
        versions: page.map((record) => ({
          version: record.version,
          author: record.author,
          at: record.at,
          change: record.version === 1 ? ("create" as const) : wholeOnly ? ("replace" as const) : ("patch" as const),
        })),
        moves: [],
        more: older.length > page.length,
      });
    },
    // The demo queues nothing: its Mac is the editing machine.
    artifactPending: async (args) => {
      if (!isDemoCanvas(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      if (!artifactsNodes.some((node) => node.id === args.nodeId)) return outcomeFail("not-found", "That is not one of this canvas's Artifacts nodes.");
      return outcomeOk({ writes: [] });
    },
    // The demo has no reach rules to read: a move into the Launch node warns, so the phone can draw the line.
    artifactMoveCheck: async (args) => {
      if (!isDemoCanvas(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      if (!artifactsNodes.some((node) => node.id === args.to)) return outcomeFail("not-found", "That is not one of this canvas's Artifacts nodes.");
      const moving = args.artifactIds.map((id) => DEMO_ARTIFACTS.find(({ head }) => head.artifactId === id));
      if (moving.some((held) => held === undefined)) return outcomeFail("not-found", "That artifact is not on this canvas.");
      const leaving = moving.filter((held) => held!.head.nodeId !== args.to).length;
      if (args.to !== "art-launch" || leaving === 0) return outcomeOk({});
      return outcomeOk({ warning: `Seats in Launch will reach ${leaving === 1 ? "this" : "these"} too.` });
    },
    inboxSet: async (canvasName, nodeId) => {
      if (!isDemoCanvas(canvasName)) return outcomeFail("not-found", "No such canvas.");
      if (!artifactsNodes.some((node) => node.id === nodeId)) return outcomeFail("invalid", "That is not one of this canvas's Artifacts nodes.");
      inbox = nodeId;
      return outcomeOk({ inboxNodeId: asNodeId(nodeId) });
    },
  };
};
