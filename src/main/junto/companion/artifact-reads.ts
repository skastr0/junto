/**
 * The phone's artifact reads, from the planes the desktop reads: the canvas
 * document for the Artifacts nodes and their regions, the artifact store for
 * their counts and label colours, and machine-local view state for the Inbox
 * that quick capture lands in (`view_capture_inboxes`, the value Cmd+T reads).
 *
 * `inbox.set` writes that same value through the same view-state path the
 * Settings page and Cmd+T use, which refuses any node that is not one of the
 * canvas's Artifacts boards, and then tells every open window to read its view
 * state again, so the desktop's next Cmd+T already uses what the phone chose.
 */
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { outcomeFail, outcomeOk, type CompanionBackend } from "@shared/companion-core";
import { asNodeId, type Canvas } from "@shared/model";
import type { ItemId } from "@shared/wire/ids";
import { titleOf } from "@shared/model/title";
import { feedRegionForCanvas } from "@shared/operator-feed";
import { operatorReachesResource } from "@shared/content-pull";
import { artifactText, type Artifact, type ArtifactBody, type ArtifactType, type ArtifactVersion } from "@shared/wire/artifact";
import type { ContentRef } from "@shared/wire/content-ref";
import type { ArtifactLabel, ArtifactLabelColour } from "@shared/wire/artifact-labels";
import {
  COMPANION_ARTIFACT_GET_BUDGET_BYTES,
  COMPANION_ARTIFACT_HISTORY_DEFAULT,
  COMPANION_ARTIFACT_MOVES_MAX,
  COMPANION_ARTIFACT_NODES_MAX,
  COMPANION_ARTIFACT_PENDING_MAX,
  COMPANION_ARTIFACT_SNIPPET_MAX,
  COMPANION_ARTIFACTS_LIST_BUDGET_BYTES,
  COMPANION_ARTIFACTS_LIST_DEFAULT,
  type CompanionArtifactChange,
  type CompanionArtifactListItem,
  type CompanionArtifactMove,
  type CompanionArtifactNode,
  type CompanionArtifactPendingWrite,
  type CompanionArtifactVersion,
} from "@shared/wire/companion-artifact-reads";
import { reachChange, reachLine } from "@renderer/components/artifacts/artifact-move-model";
import { CompanionRuntime, type CompanionServices } from "./runtime";
import { ModelService } from "../model/service";
import { withSqlRead } from "../state/sql-read";
import { publishViewStateChange } from "../view-state/changes";
import { ViewStateRepository } from "../view-state/repository";
import { ContentService } from "../content/service";
import { liveArtifactPorts } from "../work/artifact-control";
import { liveResourceIpcPorts, pendingArtifacts } from "../work/resource-ipc";
import { rankArtifacts } from "./artifact-search";

const NO_CANVAS = "No such canvas.";
const NO_SUCH_ARTIFACT = "That artifact is not on this canvas.";
const NOT_AN_ARTIFACTS_NODE = "That is not one of this canvas's Artifacts nodes.";

type Counts = { live: number; archived: number };

/** What the reads stand on, so a test can stand in for the app's planes. */
/** An artifact as the store lists it: the head without who made it or its tasks. */
export type ListedArtifact = Pick<Artifact, "artifactId" | "nodeId" | "type" | "title" | "version" | "updatedAt" | "archived" | "labels">;

export type ArtifactReadPorts = {
  /** The canvas, or undefined when it cannot be read. */
  readonly canvas: (canvasName: string) => Promise<Canvas | undefined>;
  /** Live and archived artifacts per node; undefined when the store cannot be read. */
  readonly counts: (canvasName: string) => Promise<ReadonlyMap<string, Counts> | undefined>;
  /** The label colours each node carries; undefined when the store cannot be read. */
  readonly colours: (
    canvasName: string,
    nodeIds: ReadonlyArray<string>,
  ) => Promise<ReadonlyMap<string, Readonly<Record<string, ArtifactLabelColour>>> | undefined>;
  /** This Mac's Inbox for the canvas, as the desktop's Cmd+T reads it. */
  readonly inbox: (canvasName: string) => Promise<string | undefined>;
  /** Write the Inbox through the view-state path; false for a node that is not one of the canvas's Artifacts boards, undefined when the store failed. */
  readonly setInbox: (canvasName: string, nodeId: string) => Promise<boolean | undefined>;
  /** Tell every open window to read its view state again. */
  readonly publish: () => void;
  /** The heads that match, newest change first; undefined when the store cannot be read. */
  readonly headers: (
    canvasName: string,
    query: { readonly nodeIds: ReadonlyArray<string>; readonly type?: ArtifactType; readonly labels?: ReadonlyArray<ArtifactLabel>; readonly archived: boolean },
  ) => Promise<ReadonlyArray<ListedArtifact> | undefined>;
  /** The head bodies of these artifacts; one whose bytes are not here yet is null. */
  readonly bodies: (canvasName: string, artifactIds: ReadonlyArray<string>) => Promise<ReadonlyMap<string, ArtifactBody | null>>;
  /** The artifacts one of this Mac's queued writes touches. */
  readonly pending: (canvasName: string, canvas: Canvas) => Promise<ReadonlySet<string>>;
  /**
   * One artifact's head and the body of the version asked for (the head's when
   * none): "none" for an artifact this canvas does not hold, "no-version" for a
   * version it never had, undefined when the store cannot be read. A body not
   * on this Mac yet is null, and its pull from the editing machine has begun.
   */
  /** The refs the content store holds under an artifact owner for this digest, as (canvas, artifact) pairs; undefined when it cannot be read. */
  readonly contentOwners: (
    sha256: string,
  ) => Promise<ReadonlyArray<{ readonly ref: ContentRef; readonly canvasName: string; readonly artifactId: string }> | undefined>;
  /** Whether this canvas still holds the artifact. */
  readonly holds: (canvasName: string, artifactId: string) => Promise<boolean>;
  /** The versions newest first from just before `before`, and every move; "none" for an artifact this canvas does not hold. */
  readonly history: (
    canvasName: string,
    artifactId: string,
    page: { readonly limit: number; readonly before?: ArtifactVersion },
  ) => Promise<
    | { readonly versions: ReadonlyArray<CompanionArtifactVersion>; readonly more: boolean; readonly moves: ReadonlyArray<CompanionArtifactMove> }
    | "none"
    | undefined
  >;
  /** This Mac's unruled writes to the node's artifacts, in queue order; undefined when they cannot be read. */
  readonly pendingWrites: (canvasName: string, nodeId: string) => Promise<ReadonlyArray<CompanionArtifactPendingWrite> | undefined>;
  /** The node each of these artifacts sits on now; one this canvas does not hold is absent. Undefined when the store cannot be read. */
  readonly nodesOf: (canvasName: string, artifactIds: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string> | undefined>;
  readonly artifact: (
    canvasName: string,
    artifactId: string,
    version: ArtifactVersion | undefined,
  ) => Promise<
    | { readonly artifact: Artifact; readonly version: ArtifactVersion; readonly body: ArtifactBody | null; readonly bodyRef: ContentRef }
    | "none"
    | "no-version"
    | undefined
  >;
};

/** Every artifact a list may rank; a canvas that holds more is cut here, newest first. */
const SCAN_LIMIT = 10_000;

/** `t:<updatedAt>:<artifactId>` after a row in newest-first order, `o:<offset>` into a ranked search. */
const timeCursor = (artifact: ListedArtifact): string => `t:${String(artifact.updatedAt)}:${artifact.artifactId}`;
const offsetCursor = (offset: number): string => `o:${String(offset)}`;

/** Where in `rows` the page after `cursor` starts; undefined for a cursor this list never gave. */
const startAfter = (rows: ReadonlyArray<ListedArtifact>, cursor: string | undefined, ranked: boolean): number | undefined => {
  if (cursor === undefined) return 0;
  if (ranked) {
    const match = /^o:(\d{1,9})$/u.exec(cursor);
    return match === null ? undefined : Number(match[1]);
  }
  const match = /^t:(\d{1,16}):([0-9A-Za-z]{26})$/u.exec(cursor);
  if (match === null) return undefined;
  const at = Number(match[1]);
  const id = match[2]!;
  // Newest first, ties by the larger id first (the store's order): the first row strictly after the cursor's.
  const index = rows.findIndex((row) => row.updatedAt < at || (row.updatedAt === at && row.artifactId < id));
  return index === -1 ? rows.length : index;
};

const encodedBytes = (item: unknown): number => Buffer.byteLength(JSON.stringify(item), "utf8");

/** The canvas's Artifacts nodes, in paint order, cut at the wire's bound. */
const artifactsNodesOf = (canvas: Canvas) =>
  [...canvas.nodes.values()].filter((node) => node.kind === "artifacts").slice(0, COMPANION_ARTIFACT_NODES_MAX);

export const makeArtifactReadBackend = (
  ports: ArtifactReadPorts,
  /** The bytes one list page may encode; a test narrows it to reach the cut. */
  listBudgetBytes: number = COMPANION_ARTIFACTS_LIST_BUDGET_BYTES,
): Pick<
  CompanionBackend,
  "artifactContentRef" | "artifactNodes" | "artifactList" | "artifactGet" | "artifactHistory" | "artifactPending" | "artifactMoveCheck" | "inboxSet"
> => ({
  artifactNodes: async (canvasName) => {
    const canvas = await ports.canvas(canvasName);
    if (canvas === undefined) return outcomeFail("not-found", NO_CANVAS);
    const nodes = artifactsNodesOf(canvas);
    const ids = nodes.map((node) => node.id);
    const [counts, colours, inbox] = await Promise.all([
      ports.counts(canvasName),
      ports.colours(canvasName, ids),
      ports.inbox(canvasName),
    ]);
    if (counts === undefined || colours === undefined) return outcomeFail("internal", "The artifacts could not be read.");
    const listed = nodes.map((node): CompanionArtifactNode => {
      const held = counts.get(node.id);
      return {
        nodeId: asNodeId(node.id),
        title: titleOf(node).slice(0, 200) || "Artifacts",
        region: feedRegionForCanvas(canvas, node.id),
        live: held?.live ?? 0,
        archived: held?.archived ?? 0,
        labelColours: colours.get(node.id) ?? {},
      };
    });
    // The Inbox is told only while its node is still one of the canvas's Artifacts nodes.
    const live = inbox !== undefined && listed.some((node) => node.nodeId === inbox);
    return outcomeOk({ nodes: listed, ...(live ? { inboxNodeId: asNodeId(inbox) } : {}) });
  },

  artifactList: async (args) => {
    const canvas = await ports.canvas(args.canvasName);
    if (canvas === undefined) return outcomeFail("not-found", NO_CANVAS);
    const nodes = artifactsNodesOf(canvas);
    if (args.nodeId !== undefined && !nodes.some((node) => node.id === args.nodeId)) {
      return outcomeFail("not-found", NOT_AN_ARTIFACTS_NODE);
    }
    const nodeIds = args.nodeId === undefined ? nodes.map((node) => node.id) : [args.nodeId];
    const found = await ports.headers(args.canvasName, {
      nodeIds,
      archived: args.archived ?? false,
      ...(args.type === undefined ? {} : { type: args.type }),
      ...(args.labels === undefined || args.labels.length === 0 ? {} : { labels: args.labels }),
    });
    if (found === undefined) return outcomeFail("internal", "The artifacts could not be read.");
    const query = args.query?.trim() ?? "";
    const ranked = query !== "";
    // A search reads every candidate's words; a browse reads the page's bodies, for their snippets.
    const searched = ranked
      ? await ports.bodies(args.canvasName, found.map((artifact) => artifact.artifactId))
      : undefined;
    const rows = ranked
      ? rankArtifacts(found.map((artifact) => ({ artifact, body: searched!.get(artifact.artifactId) ?? null })), query).map((row) => row.artifact)
      : found;
    const start = startAfter(rows, args.before, ranked);
    if (start === undefined) return outcomeFail("invalid", "That page cursor was not given by this list.");
    const limit = args.limit ?? COMPANION_ARTIFACTS_LIST_DEFAULT;
    const page = rows.slice(start, start + limit);
    const bodies = searched ?? (await ports.bodies(args.canvasName, page.map((artifact) => artifact.artifactId)));
    const marked = await ports.pending(args.canvasName, canvas);
    const items = page.map((artifact): CompanionArtifactListItem => {
      const body = bodies.get(artifact.artifactId) ?? null;
      return {
        artifactId: artifact.artifactId,
        nodeId: artifact.nodeId,
        type: artifact.type,
        title: artifact.title,
        version: artifact.version,
        updatedAt: artifact.updatedAt,
        archived: artifact.archived,
        labels: artifact.labels,
        ...(body === null ? {} : { snippet: artifactText(body).slice(0, COMPANION_ARTIFACT_SNIPPET_MAX) }),
        ...(marked.has(artifact.artifactId) ? { pending: true as const } : {}),
      };
    });
    // Rows past the frame's budget wait for the next page, never cut mid-row.
    let used = 0;
    let fitted = 0;
    for (const item of items) {
      used += encodedBytes(item) + 1;
      if (used > listBudgetBytes && fitted > 0) break;
      fitted += 1;
    }
    const sent = items.slice(0, fitted);
    const more = start + fitted < rows.length;
    const last = page[fitted - 1];
    return outcomeOk({
      artifacts: sent,
      more,
      ...(more && last !== undefined ? { next: ranked ? offsetCursor(start + fitted) : timeCursor(last) } : {}),
    });
  },

  artifactGet: async (args) => {
    const canvas = await ports.canvas(args.canvasName);
    if (canvas === undefined) return outcomeFail("not-found", NO_CANVAS);
    const read = await ports.artifact(args.canvasName, args.artifactId, args.version);
    if (read === undefined) return outcomeFail("internal", "The artifact could not be read.");
    if (read === "none") return outcomeFail("not-found", NO_SUCH_ARTIFACT);
    if (read === "no-version") return outcomeFail("not-found", "That artifact has no such version.");
    if (read.body === null) return outcomeFail("unavailable", "That version is on its way from the machine that edits this canvas. Try again in a moment.");
    const [colours, marked] = await Promise.all([ports.colours(args.canvasName, [read.artifact.nodeId]), ports.pending(args.canvasName, canvas)]);
    const held = colours?.get(read.artifact.nodeId) ?? {};
    const labelColours = Object.fromEntries(read.artifact.labels.flatMap((label) => (held[label] === undefined ? [] : [[label, held[label]] as const])));
    const result = {
      artifact: read.artifact,
      version: read.version,
      bodyRef: read.bodyRef,
      ...(Object.keys(labelColours).length === 0 ? {} : { labelColours }),
      ...(marked.has(read.artifact.artifactId) ? { pending: true as const } : {}),
    };
    // Decided by encoded bytes: JSON escaping and UTF-8 make a document under the character cap overrun a frame.
    const whole = { ...result, body: read.body };
    return outcomeOk(encodedBytes(whole) <= COMPANION_ARTIFACT_GET_BUDGET_BYTES ? whole : result);
  },

  // `content.get` beyond feeds and mail: a digest an artifact on any canvas still holds, answered with the store's ref.
  artifactContentRef: async (sha256) => {
    for (const owner of (await ports.contentOwners(sha256)) ?? []) {
      if (await ports.holds(owner.canvasName, owner.artifactId)) return owner.ref;
    }
    return undefined;
  },

  artifactHistory: async (args) => {
    if ((await ports.canvas(args.canvasName)) === undefined) return outcomeFail("not-found", NO_CANVAS);
    const read = await ports.history(args.canvasName, args.artifactId, {
      limit: args.limit ?? COMPANION_ARTIFACT_HISTORY_DEFAULT,
      ...(args.before === undefined ? {} : { before: args.before }),
    });
    if (read === undefined) return outcomeFail("internal", "The history could not be read.");
    if (read === "none") return outcomeFail("not-found", NO_SUCH_ARTIFACT);
    return outcomeOk({ versions: read.versions, moves: read.moves.slice(-COMPANION_ARTIFACT_MOVES_MAX), more: read.more });
  },

  artifactPending: async (args) => {
    const canvas = await ports.canvas(args.canvasName);
    if (canvas === undefined) return outcomeFail("not-found", NO_CANVAS);
    if (!artifactsNodesOf(canvas).some((node) => node.id === args.nodeId)) return outcomeFail("not-found", NOT_AN_ARTIFACTS_NODE);
    const writes = await ports.pendingWrites(args.canvasName, args.nodeId);
    if (writes === undefined) return outcomeFail("internal", "The queued writes could not be read.");
    return outcomeOk({ writes: writes.slice(0, COMPANION_ARTIFACT_PENDING_MAX) });
  },

  artifactMoveCheck: async (args) => {
    const canvas = await ports.canvas(args.canvasName);
    if (canvas === undefined) return outcomeFail("not-found", NO_CANVAS);
    if (!artifactsNodesOf(canvas).some((node) => node.id === args.to)) return outcomeFail("not-found", NOT_AN_ARTIFACTS_NODE);
    const placed = await ports.nodesOf(args.canvasName, args.artifactIds);
    if (placed === undefined) return outcomeFail("internal", "The artifacts could not be read.");
    if (args.artifactIds.some((id) => !placed.has(id))) return outcomeFail("not-found", NO_SUCH_ARTIFACT);
    // The desktop's line for a move from one node; artifacts from several nodes get a line each.
    const bySource = new Map<string, number>();
    for (const id of args.artifactIds) {
      const from = placed.get(id)!;
      if (from !== args.to) bySource.set(from, (bySource.get(from) ?? 0) + 1);
    }
    const lines = [...bySource].flatMap(([from, count]) => {
      const line = reachLine(reachChange(canvas, asNodeId(from), asNodeId(args.to)), count);
      return line === null ? [] : [line];
    });
    return outcomeOk(lines.length === 0 ? {} : { warning: lines.join(" ") });
  },

  inboxSet: async (canvasName, nodeId) => {
    if ((await ports.canvas(canvasName)) === undefined) return outcomeFail("not-found", NO_CANVAS);
    const written = await ports.setInbox(canvasName, nodeId);
    if (written === undefined) return outcomeFail("internal", "The Inbox could not be saved.");
    if (!written) return outcomeFail("invalid", NOT_AN_ARTIFACTS_NODE);
    // After the row committed: every open window reads its view state again.
    ports.publish();
    return outcomeOk({ inboxNodeId: asNodeId(nodeId) });
  },
});

/** What the running app provides to an effect. */
type AppServices = CompanionServices;

const orUndefined = <A>(effect: Effect.Effect<A, unknown, AppServices>): Promise<A | undefined> =>
  CompanionRuntime.runPromise(effect.pipe(Effect.catch(() => Effect.succeed(undefined))));

/** How many artifacts each node holds, live and archived, in one read. */
const countsByNode = (canvasName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* withSqlRead(
      sql,
      sql<{ node_id: string; archived: number; n: number }>`
        SELECT node_id, archived, COUNT(*) AS n FROM artifact_heads
        WHERE canvas_name = ${canvasName} GROUP BY node_id, archived`,
    );
    const counts = new Map<string, Counts>();
    for (const row of rows) {
      const held = counts.get(row.node_id) ?? { live: 0, archived: 0 };
      if (row.archived === 1) held.archived += row.n;
      else held.live += row.n;
      counts.set(row.node_id, held);
    }
    return counts as ReadonlyMap<string, Counts>;
  });

/** The desktop's own resource ports, for the queue of writes: only `queue` and `topology` are read here. */
const resourcePorts = liveResourceIpcPorts(
  (canvasName) =>
    Effect.tryPromise({
      try: () => CompanionRuntime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas(canvasName))),
      catch: () => ({ type: "InternalError" as const, message: `canvas ${canvasName} could not be read`, details: { retryable: true } }),
    }),
  () => Effect.fail({ type: "InternalError" as const, message: "mailboxes are not read here", details: { retryable: false } }),
);

const livePorts: ArtifactReadPorts = {
  canvas: (canvasName) => orUndefined(Effect.flatMap(ModelService, (model) => model.canvas(canvasName))),
  counts: (canvasName) => orUndefined(countsByNode(canvasName)),
  colours: (canvasName, nodeIds) =>
    nodeIds.length === 0 || liveArtifactPorts.labelColours === undefined
      ? Promise.resolve(new Map())
      : orUndefined(liveArtifactPorts.labelColours(canvasName, nodeIds.map(asNodeId))),
  inbox: async (canvasName) =>
    (await orUndefined(Effect.flatMap(ViewStateRepository, (store) => store.snapshot())))?.captureInboxes[canvasName],
  setInbox: (canvasName, nodeId) =>
    orUndefined(Effect.flatMap(ViewStateRepository, (store) => store.write({ area: "capture-inbox", canvasName, inbox: nodeId }))),
  publish: publishViewStateChange,
  headers: async (canvasName, query) => {
    if (query.nodeIds.length === 0) return [];
    const listed = await orUndefined(
      liveArtifactPorts.list(canvasName, { ...query, nodeIds: query.nodeIds.map(asNodeId), limit: SCAN_LIMIT }),
    );
    return listed?.artifacts;
  },
  bodies: async (canvasName, artifactIds) => {
    const heads = await Promise.all(
      artifactIds.map((id) => orUndefined(liveArtifactPorts.head(canvasName, id as ItemId))),
    );
    return new Map(
      artifactIds.map((id, index) => {
        const head = heads[index];
        return [id, head !== undefined && Option.isSome(head) ? head.value.body : null] as const;
      }),
    );
  },
  contentOwners: (sha256) =>
    orUndefined(
      Effect.gen(function* () {
        const content = yield* Effect.serviceOption(ContentService);
        if (Option.isNone(content)) return [];
        const rows = yield* content.value.listRefs(sha256);
        return rows.flatMap((row) => {
          // An artifact owner's record is `<artifactId>@<version>`.
          if (row.owner.kind !== "artifact") return [];
          const artifactId = row.owner.recordId.split("@")[0] ?? "";
          return [{ ref: row.ref, canvasName: row.owner.canvasName, artifactId }];
        });
      }),
    ),
  holds: async (canvasName, artifactId) => {
    const head = await orUndefined(liveArtifactPorts.head(canvasName, artifactId as ItemId));
    return head !== undefined && Option.isSome(head);
  },
  history: (canvasName, artifactId, page) =>
    orUndefined(
      Effect.gen(function* () {
        const head = yield* liveArtifactPorts.head(canvasName, artifactId as ItemId);
        if (Option.isNone(head)) return "none" as const;
        const { versions, more } = yield* liveArtifactPorts.history(canvasName, artifactId as ItemId, page);
        const moves = liveArtifactPorts.moves === undefined ? [] : yield* liveArtifactPorts.moves(canvasName, artifactId as ItemId);
        const change = (version: (typeof versions)[number]): CompanionArtifactChange =>
          version.edit === undefined ? "create" : version.edit === "unrecorded" ? "unrecorded" : version.edit.kind;
        return {
          versions: versions.map((version) => ({ version: version.version, author: version.author, at: version.at, change: change(version) })),
          more,
          moves: moves.map((move) => ({ from: move.from, to: move.to, by: move.by, at: move.at })),
        };
      }),
    ),
  pendingWrites: (canvasName, nodeId) =>
    orUndefined(
      pendingArtifacts(resourcePorts, canvasName, asNodeId(nodeId)).pipe(
        Effect.map((writes) =>
          writes.map((write): CompanionArtifactPendingWrite => ({
            opId: write.opId,
            artifactId: write.artifactId,
            op: write.op,
            ...(write.overlay?.refusal === undefined ? {} : { wouldRefuse: write.overlay.refusal.message.slice(0, 500) }),
            ...(write.overlay?.waiting === undefined ? {} : { waiting: true as const }),
          })),
        ),
      ),
    ),
  nodesOf: async (canvasName, artifactIds) => {
    const heads = await Promise.all(artifactIds.map((id) => orUndefined(liveArtifactPorts.head(canvasName, id as ItemId))));
    if (heads.some((head) => head === undefined)) return undefined;
    return new Map(
      artifactIds.flatMap((id, index) => {
        const head = heads[index];
        return head !== undefined && Option.isSome(head) ? [[id, head.value.artifact.nodeId] as const] : [];
      }),
    );
  },
  artifact: (canvasName, artifactId, version) =>
    orUndefined(
      Effect.gen(function* () {
        const head = yield* liveArtifactPorts.head(canvasName, artifactId as ItemId);
        if (Option.isNone(head)) return "none" as const;
        const shown = version ?? head.value.artifact.version;
        const read = shown === head.value.artifact.version
          ? { body: head.value.body, bodyRef: head.value.bodyRef }
          : Option.getOrUndefined(yield* liveArtifactPorts.body(canvasName, artifactId as ItemId, shown));
        if (read === undefined) return "no-version" as const;
        if (read.body === null) {
          // Begin the pull and answer at once: the phone asks again, as the desktop's window does.
          yield* liveArtifactPorts.pull({
            ref: read.bodyRef,
            reached: operatorReachesResource(canvasName, head.value.artifact.nodeId),
            owner: { kind: "artifact", canvasName, nodeId: head.value.artifact.nodeId, recordId: `${artifactId}@${String(shown)}` },
          });
        }
        return { artifact: head.value.artifact, version: shown, body: read.body, bodyRef: read.bodyRef };
      }),
    ),
  pending: async (canvasName, canvas) => {
    if (liveArtifactPorts.pending === undefined) return new Set();
    const marks = await orUndefined(liveArtifactPorts.pending(canvasName, canvas));
    return new Set(marks === undefined ? [] : marks.keys());
  },
};

export const companionArtifactReadBackend = makeArtifactReadBackend(livePorts);
