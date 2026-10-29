/**
 * `junto companion-stdio --demo`: the full protocol against a built-in,
 * deterministic canvas, for the phone team to develop against without a Mac.
 *
 * Three regions, eight seats, every feed kind (blocked, attention, escalate,
 * feedback, health) and a mail history. It never touches the app or ~/.ssh.
 * Writes succeed and change the demo for this process only. The clock is
 * fixed and advances one second per write, so a transcript is reproducible.
 *
 * The feed and seats go through the same projections the app uses
 * (`buildOperatorFeed`, `companionSeat`), so the demo cannot drift from the
 * shapes a real Mac sends.
 */

import { Result } from "effect";
import { asCanvasName, asNodeId, asWireId, canvasFromOpened, type BindingId, type Canvas, type Node, type NodeOf } from "./model";
import { companionCanvasDrawn } from "./companion-canvas";
import type { AgentSignal } from "./agent-signals";
import { AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE, rollupSeatSignals } from "./agent-signals";
import {
  handleCompanionRequest,
  makeCompanionGates,
  makeWriteLimiter,
  outcomeFail,
  outcomeOk,
  type CompanionBackend,
  type CompanionMailThread,
  type CompanionOutcome,
} from "./companion-core";
import { companionCommentsPage, type CommentPostView, type CommentThreadView } from "./companion-comments";
import type { ItemId } from "./wire/ids";
import { artifactFirstLines } from "./artifact-lines";
import { candidatesOfNodes, connectedSeatCandidates, filterCandidates } from "./mention-candidates";
import type { CompanionArtifactChanged } from "./wire/companion-artifacts";
import { parseMentionHref } from "./wire/mention";
import { mentionableNodesFrom } from "./mention-reach";
import { companionConnected, companionThreadPage, companionThreadRead, companionThreadsPage } from "./companion-threads";
import {
  mailAfter,
  readPointKey,
  seatMailThreadEntries,
  seatMailThreadMessages,
  seatMailThreads,
  unreadPast,
  type MailReadPoint,
  type MailThreadsInput,
} from "./mail-threads";
import { mentionedOnce, mentionsOf } from "./mention";
import { makeAgentMessage, makeUserMessage } from "./task";
import type { Message } from "./work-model";
import { OPERATOR_SEAT_ID } from "./work-reference";
import { companionPortraitSvg } from "./companion-portrait";
import type { CompanionChange, CompanionHost } from "./companion-session";
import { companionSeat } from "./companion-seats";
import { demoArtifactBytes, makeDemoArtifactReads } from "./companion-demo-artifacts";
import {
  COMPANION_FEATURES,
  COMPANION_PROTOCOL,
  COMPANION_SEAT_HISTORY_LIMIT,
  type CompanionActivity,
  type CompanionMachineLogLevel,
  type CompanionMail,
  type CompanionRequestFrame,
  type CompanionResponseFrame,
  type CompanionThreadMessage,
} from "./companion-protocol";
import type { CompanionResultByOp } from "./wire/companion-protocol";
import { ruleSignalReply } from "./signal-reply";
import { decodeArtifactBody, ruleArtifactEdit, type Artifact, type ArtifactBody, type ArtifactEdit, type ArtifactOp, type ArtifactVersion, type ArtifactVersionRecord } from "./wire/artifact";
import type { ContentByteLength, ContentRef, ContentSha256 } from "./wire/content-ref";
import { ARTIFACT_LABEL_RULE, artifactLabelOf, artifactLabelsOf, type ArtifactLabelColour } from "./wire/artifact-labels";
import { COMPANION_ARTIFACT_WRITE_LIMIT } from "./wire/companion-artifact-writes";
import { buildOperatorFeed, feedSeatsFromCanvas, feedSourcesFromCanvas, type FeedHealth } from "./operator-feed";

/** One thread mail as the store holds it: the mailbox it sits in, and the row. */
const demoThreadRow = (message: CompanionThreadMessage): { readonly nodeId: string; readonly row: Message } => {
  const operator = message.from.kind === "operator";
  const metadata = {
    factoryMail: true,
    mailKind: "prompt",
    fromSeat: message.from.kind === "operator" ? OPERATOR_SEAT_ID : `seat_demo_${message.from.nodeId}`,
    senderNodeId: message.from.kind === "operator" ? "operator" : message.from.nodeId,
    senderName: message.from.kind === "operator" ? "operator" : message.from.name,
    senderGeneration: operator ? "operator" : "demo",
    senderHarness: "unknown",
    // A thread's root carries no threadId; its id is the thread.
    ...(message.threadId === message.messageId ? {} : { threadId: message.threadId }),
    ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
  };
  const to = message.to[0]!;
  const base = { messageId: message.messageId, text: message.text, contextId: DEMO_CANVAS };
  if (to.kind === "operator" && message.from.kind === "seat") {
    return { nodeId: message.from.nodeId, row: makeAgentMessage({ ...base, metadata: { ...metadata, toNodeId: "operator" } }) };
  }
  return { nodeId: to.kind === "seat" ? to.nodeId : "", row: makeUserMessage({ ...base, metadata }) };
};

const DEMO_LOG_LEVELS: ReadonlyArray<CompanionMachineLogLevel> = ["trace", "debug", "info", "warn", "error", "fatal"];
import { THREAD_HEALTH_LABEL, THREAD_HEALTH_TONE, type ThreadHealthReading, type ThreadHealthValue } from "./thread-health";
import {
  DEMO_ACTIVITY,
  DEMO_ACTIVITY_AT,
  DEMO_ARTIFACT_LABEL_COLOURS,
  DEMO_ARTIFACTS,
  DEMO_ARTIFACT_THREADS,
  DEMO_BRIEFINGS,
  DEMO_CANVAS,
  DEMO_CANVAS_TITLE,
  DEMO_CONNECTED,
  DEMO_CONTENT,
  DEMO_DEVICE_ID,
  DEMO_DEVICE_NAME,
  DEMO_HEALTH_CONFIDENCE,
  DEMO_HEALTH_OBSERVED_AT,
  DEMO_MACHINES,
  DEMO_MAIL,
  DEMO_THREAD_MAIL,
  demoMailId,
  demoItemId,
  DEMO_PREAMBLES,
  DEMO_QUICK_REPLIES,
  DEMO_QUIET_NOTES,
  DEMO_REGIONS,
  DEMO_RESOURCE_NODES,
  DEMO_SEATS,
  DEMO_SIGNALS,
  DEMO_STATION,
  DEMO_TASK_PRICING,
  DEMO_T0,
  DEMO_TAILNET,
  DEMO_WIRES,
  demoSeatPosition,
  type DemoArtifactThread,
  type DemoMail,
  type DemoRegion,
  type DemoResourceNode,
  type DemoSeat,
  type DemoThreadPost,
} from "./wire/companion-demo-fixture";

export { DEMO_CANVAS, DEMO_DEVICE_ID, DEMO_T0 } from "./wire/companion-demo-fixture";

const region = (r: DemoRegion, z: number): NodeOf<"region"> =>
  ({ ...r, id: asNodeId(r.id), kind: "region", z, hold: false });

const seatNode = (seat: DemoSeat, z: number, machineName: string): NodeOf<"agent"> => ({
  id: asNodeId(seat.id), kind: "agent", label: seat.name,
  ...demoSeatPosition(seat), width: 240, height: 96, z,
  agentKey: `local:demo-${seat.id}`, host: machineName as NodeOf<"agent">["host"], overseer: false,
  bindingId: `demo-${seat.id}` as BindingId, harness: seat.harness,
});

const SEATS = DEMO_SEATS;

/** A fixture resource node as its canvas kind: an Artifacts node, a task board, or a page. */
const resourceNode = (node: DemoResourceNode, z: number): Node => {
  const placement = { id: asNodeId(node.id), x: node.x, y: node.y, width: node.width, height: node.height, z };
  switch (node.kind) {
    case "artifacts":
      return { ...placement, kind: "artifacts", label: node.label };
    case "task":
      return { ...placement, kind: "task", name: node.label };
    case "page":
      return { ...placement, kind: "page", url: node.url ?? "https://example.com/", profile: "demo", onRemove: "detach", label: node.label };
  }
};

/** The demo canvas, its seats on the machine the demo runs on. */
const demoCanvas = (machineName: string) => canvasFromOpened({
  canvas: asCanvasName(DEMO_CANVAS), seq: 0,
  nodes: [
    ...DEMO_REGIONS.map(region),
    ...SEATS.map((seat, index) => seatNode(seat, DEMO_REGIONS.length + index, machineName)),
    ...DEMO_RESOURCE_NODES.map((node, index) => resourceNode(node, DEMO_REGIONS.length + SEATS.length + index)),
  ],
  wires: DEMO_WIRES.map((wire) => ({ ...wire, id: asWireId(wire.id), from: asNodeId(wire.from), to: asNodeId(wire.to) })),
});

/** The seat a mail went to comes to the front: the demo's one canvas change, so a transcript holds a canvas.changed. */
const toFront = (canvas: Canvas, nodeId: string): Canvas => {
  const node = canvas.nodes.get(asNodeId(nodeId));
  const top = Math.max(...[...canvas.nodes.values()].map((candidate) => candidate.z));
  if (node === undefined || node.z === top) return canvas;
  return { ...canvas, nodes: new Map(canvas.nodes).set(node.id, { ...node, z: top + 1 }) };
};

const reading = (seat: DemoSeat, value: ThreadHealthValue, at: number): ThreadHealthReading => ({
  bindingId: `local:demo-${seat.id}`,
  value,
  confidence: DEMO_HEALTH_CONFIDENCE,
  observedAt: at,
  provenance: { source: "jev", assessmentId: `demo-${seat.id}`, questionId: `health.${value}`, packVersion: "awareness-pack/2" },
  signals: [{ value, probability: DEMO_HEALTH_CONFIDENCE, questionId: `health.${value}` }],
});

/** A fresh demo world on the machine named; every connection gets its own. */
/** Draws a portrait's SVG as PNG bytes; the caller brings it, so the demo stays platform-free. */
export type DemoPortraitPng = (svg: string, size: number) => Promise<Uint8Array>;

export const makeDemoBackend = (machineName: string, portraitPng?: DemoPortraitPng): CompanionBackend & {
  readonly revision: () => number;
  readonly takeSignalChanges: (since: number) => { readonly signals: ReadonlyArray<AgentSignal>; readonly seq: number };
  /** Artifact writes made in this demo since a cursor, for a connection that subscribed. */
  readonly takeArtifactChanges: (since: number) => { readonly artifacts: ReadonlyArray<CompanionArtifactChanged>; readonly seq: number };
} => {
  let CANVAS = demoCanvas(machineName);
  let clock = DEMO_T0;
  let revision = 0;
  const signals = new Map(DEMO_SIGNALS.map((signal) => [signal.signalId, signal] as const));
  const signalLog: Array<{ readonly seq: number; readonly signal: AgentSignal }> = [];
  const artifactLog: Array<{ readonly seq: number; readonly change: CompanionArtifactChanged }> = [];
  const mail: DemoMail[] = [...DEMO_MAIL];
  const activity = new Map(Object.entries(DEMO_ACTIVITY).map(([nodeId, lines]) => [nodeId, [...lines]] as const));
  const noteActivity = (nodeId: string, line: CompanionActivity): void => {
    activity.set(nodeId, [line, ...(activity.get(nodeId) ?? [])]);
  };
  let mailSeq = 0;
  const threadRows = DEMO_THREAD_MAIL.map(demoThreadRow);
  const threadsInput = (): MailThreadsInput => ({
    mailboxes: SEATS.map((seat) => ({
      nodeId: seat.id,
      messages: threadRows.filter((entry) => entry.nodeId === seat.id).map((entry) => entry.row),
    })),
    nameOf: (nodeId) => SEATS.find((seat) => seat.id === nodeId)?.name,
    readPointOf: (threadId) => readPoints.get(threadId),
  });
  /** The operator's read point per thread, as the Mac keeps one per canvas thread. */
  const readPoints = new Map<string, MailReadPoint>();
  // --- comments (0.11.3, the phone's artifacts) -----------------------------
  const demoAuthor = (from: DemoThreadPost["from"]): CommentPostView["author"] =>
    from.kind === "operator"
      ? { kind: "operator", name: "operator" }
      : { kind: "seat", seatId: from.seatId, nodeId: asNodeId(from.nodeId), name: from.name };
  /** The fixture's threads, mutable: a comment posted here lives for this process, as every demo write does. */
  const commentThreads: Array<{
    readonly threadId: string;
    readonly artifactId: string;
    readonly anchor?: CommentThreadView["anchor"];
    readonly posts: Array<CommentPostView>;
  }> = DEMO_ARTIFACT_THREADS.map((thread: DemoArtifactThread) => ({
    threadId: thread.threadId,
    artifactId: thread.artifactId,
    anchor: thread.anchor,
    posts: thread.posts.map((post) => ({
      postId: post.postId,
      author: demoAuthor(post.from),
      text: post.text,
      at: post.at,
    })),
  }));
  let commentSeq = 0;
  // A replayed opId answers as the first one did, never a second comment.
  const commentOps = new Map<string, { readonly threadId: string; readonly messageId: string }>();
  // --- artifact writes (03, the phone's artifacts) ---------------------------
  // A replayed opId answers as the first ruling did, as the Mac's does.
  const applyOps = new Map<string, CompanionResultByOp["artifact.apply"]>();
  // Edits this session applied, per artifact, so an edit behind the head can rebase or refuse as the Mac's does.
  const appliedEdits = new Map<string, Array<ArtifactEdit>>();
  // The bytes each new version's body ref names, as the Mac's content store keeps them.
  const appliedBytes = new Map<string, Uint8Array>();
  // Uploads staged for the artifact purpose, by stage id; a staged file is claimed once.
  const stagedUploads = new Map<string, { readonly canvasName: string; bytes: Uint8Array }>();
  const stagedBytes = new Map<string, Uint8Array>();
  const stagedByStage = new Map<string, string>();
  let stageSeq = 0;
  const stagedRefsOf = (op: ArtifactOp): ReadonlyArray<ContentRef> => {
    const bodyRefs = (body: ArtifactBody): ReadonlyArray<ContentRef> =>
      body.type === "file" ? [body.content] : body.type === "link" && body.target.kind === "content" ? [body.target.content] : [];
    if (op.op === "create") return bodyRefs(op.body);
    if (op.op !== "edit") return [];
    if (op.edit.kind === "replace") return bodyRefs(op.edit.body);
    if (op.edit.type === "pad") return op.edit.patches.flatMap((p) => (p.op === "upsert" && p.layer === "image" ? [p.image.ref] : []));
    return [];
  };
  const mutableArtifacts = DEMO_ARTIFACTS as Array<{
    head: { -readonly [K in keyof Artifact]: Artifact[K] };
    body: ArtifactBody;
    versions: Array<ArtifactVersionRecord>;
  }>;
  const mutableColours = DEMO_ARTIFACT_LABEL_COLOURS as Record<string, Record<string, ArtifactLabelColour | undefined>>;
  const OPERATOR_AUTHOR = { kind: "operator" } as const;

  const now = (): number => clock;
  const tick = (): number => {
    clock += 1_000;
    revision += 1;
    return clock;
  };
  const noteSignal = (signal: AgentSignal): void => {
    signals.set(signal.signalId, signal);
    signalLog.push({ seq: revision, signal });
  };

  const healthOf = (seat: DemoSeat): { reading: ThreadHealthReading; feed: FeedHealth } | undefined => {
    if (!seat.health) return undefined;
    const r = reading(seat, seat.health, DEMO_HEALTH_OBSERVED_AT);
    return {
      reading: r,
      feed: {
        value: r.value,
        tone: THREAD_HEALTH_TONE[r.value],
        label: THREAD_HEALTH_LABEL[r.value],
        confidence: r.confidence,
        observedAt: r.observedAt,
        stale: false,
      },
    };
  };

  const feedNow = () => {
    const attentionByNodeId = new Map(
      SEATS.filter((seat) => seat.control === "attention").map(
        (seat) => [seat.id, { reason: seat.reason ?? "", at: DEMO_ACTIVITY_AT }] as const,
      ),
    );
    const healthByNodeId = new Map(
      SEATS.flatMap((seat) => {
        const health = healthOf(seat);
        return health ? [[seat.id, { reading: health.reading, fresh: true }] as const] : [];
      }),
    );
    return buildOperatorFeed({
      canvasName: DEMO_CANVAS,
      nowMs: clock,
      seats: feedSeatsFromCanvas(CANVAS, { attentionByNodeId, healthByNodeId }),
      signals: [...signals.values()],
      sources: feedSourcesFromCanvas(CANVAS),
    });
  };

  const seatsNow = () => {
    const feedSeats = feedSeatsFromCanvas(CANVAS);
    const rollups = rollupSeatSignals([...signals.values()].filter((signal) => signal.state === "open"));
    return SEATS.map((seat) => {
      const entry = feedSeats.find((candidate) => candidate.seat.nodeId === seat.id)!;
      const rollup = rollups.get(seat.id);
      const health = healthOf(seat);
      return companionSeat({
        seat: entry.seat,
        region: entry.region,
        control: { state: seat.control, reason: seat.reason ?? "", at: DEMO_ACTIVITY_AT },
        process: seat.process,
        ...(seat.doneUnread ? { doneUnread: true } : {}),
        ...(rollup ? { signal: { kind: rollup.kind, signalId: rollup.signal.signalId, openCount: rollup.openCount } } : {}),
        ...(health ? { health: health.feed } : {}),
        unread: unreadOf(entry.seat.nodeId),
        ring: { since: DEMO_ACTIVITY_AT },
      });
    });
  };

  /** What the operator has not read in a seat's threads, counted as the Mac counts its badge. */
  const unreadOf = (nodeId: string): number => {
    let total = 0;
    for (const [threadId, entries] of seatMailThreadEntries(threadsInput(), nodeId)) total += unreadPast(entries, readPoints.get(threadId));
    return total;
  };

  const known = (canvasName: string) => canvasName === DEMO_CANVAS;
  const demoArtifactReads = makeDemoArtifactReads(CANVAS, known);
  const artifactsNodeIds = new Set(
    [...CANVAS.nodes.values()].filter((node) => node.kind === "artifacts").map((node) => node.id as string),
  );
  const regionIdOf = (nodeId: string): string | null =>
    feedSeatsFromCanvas(CANVAS).find((entry) => entry.seat.nodeId === nodeId)?.region.regionId ?? null;
  const seatExists = (nodeId: string) => SEATS.some((seat) => seat.id === nodeId);
  const appendOperatorMail = (
    nodeId: string,
    text: string,
    at: number,
    thread: { readonly threadId?: string; readonly inReplyTo?: string } = {},
  ): CompanionMail => {
    const seat = SEATS.find((candidate) => candidate.id === nodeId)!;
    mailSeq += 1;
    const messageId = demoMailId(at, "SENT", mailSeq);
    const threadId = thread.threadId ?? messageId;
    const message: DemoMail = {
      messageId,
      nodeId,
      direction: "to_seat",
      from: { kind: "operator" },
      text,
      at,
      delivery: seat.process === "stopped" ? "waiting_for_seat" : "delivered",
      threadId,
      ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
    };
    mail.push(message);
    threadRows.push(
      demoThreadRow({
        messageId,
        threadId,
        ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
        from: { kind: "operator" },
        to: [{ kind: "seat", nodeId, name: seat.name }],
        mine: true,
        text,
        at,
      }),
    );
    noteActivity(nodeId, { at, label: "got your mail", kind: "mail" });
    return { ...message, canvasName: DEMO_CANVAS };
  };

  /** Write an artifact head into the demo world: the mutation the Mac's create commit makes. */
  const createArtifact = (
    nodeId: string,
    artifactId: ItemId,
    op: Extract<ArtifactOp, { readonly op: "create" }>,
  ): CompanionOutcome<Artifact> => {
    if (mutableArtifacts.some((held) => held.head.artifactId === artifactId))
      return outcomeFail("invalid", "An artifact of that id already lives here.");
    if (!artifactsNodeIds.has(nodeId)) return outcomeFail("not-found", "That is not one of this canvas's Artifacts nodes.");
    const decoded = decodeArtifactBody(op.body);
    if (Result.isFailure(decoded)) return outcomeFail("invalid", "That body is not one the wire reads.");
    const labels = artifactLabelsOf(op.labels ?? []);
    if (labels === undefined) return outcomeFail("invalid", ARTIFACT_LABEL_RULE);
    const at = tick();
    const body = decoded.success;
    const head: Artifact = {
      artifactId,
      nodeId: nodeId as Artifact["nodeId"],
      type: body.type,
      title: op.title,
      version: 1 as ArtifactVersion,
      createdBy: OPERATOR_AUTHOR,
      updatedAt: at,
      archived: false,
      taskIds: op.taskIds ?? [],
      labels,
    };
    mutableArtifacts.push({ head, body, versions: [{ artifactId, version: 1 as ArtifactVersion, author: OPERATOR_AUTHOR, at, body }] });
    return outcomeOk(head);
  };

  // What an applied write keeps: its ruling under the op id for resends, the
  // staged bytes it claimed, the body ref bytes the reads then serve, and the
  // change a subscribed phone hears.
  const keep = async (
    opId: string,
    op: ArtifactOp,
    result: CompanionResultByOp["artifact.apply"],
  ): Promise<CompanionOutcome<CompanionResultByOp["artifact.apply"]>> => {
    applyOps.set(opId, result);
    if (result.disposition === "applied") {
      for (const ref of stagedRefsOf(op)) {
        const bytes = stagedBytes.get(ref.sha256);
        if (bytes !== undefined) {
          stagedBytes.delete(ref.sha256);
          appliedBytes.set(ref.sha256, bytes);
        }
      }
      if (result.artifact !== undefined) {
        const servedArtifact = result.artifact;
        const served = await demoArtifactReads.artifactGet({ canvasName: DEMO_CANVAS, artifactId: servedArtifact.artifactId });
        const held = mutableArtifacts.find((candidate) => candidate.head.artifactId === servedArtifact.artifactId);
        const bodyRef = served.ok ? served.value.bodyRef : undefined;
        if (served.ok && held !== undefined) {
          appliedBytes.set(served.value.bodyRef.sha256, new TextEncoder().encode(JSON.stringify(held.body)));
        }
        revision += 1;
        artifactLog.push({
          seq: revision,
          change: {
            canvasName: DEMO_CANVAS,
            artifact: {
              artifactId: servedArtifact.artifactId,
              nodeId: servedArtifact.nodeId,
              type: servedArtifact.type,
              title: servedArtifact.title,
              version: servedArtifact.version,
              updatedAt: servedArtifact.updatedAt,
              archived: servedArtifact.archived,
              labels: servedArtifact.labels,
            },
            author: { kind: "operator" },
            at: clock,
            ...(op.op === "edit" ? { edit: op.edit } : {}),
            ...(bodyRef === undefined ? {} : { bodyRef }),
          },
        });
      }
    }
    return outcomeOk(result);
  };
  // A reply's artifact ids mint high of the fixture's, past whatever earlier
  // backends in this process already created (the demo world is shared).
  let replyArtifactSeq = 900;
  const mintReplyArtifactId = (): ItemId => {
    while (mutableArtifacts.some((held) => held.head.artifactId === demoItemId("ART", replyArtifactSeq))) replyArtifactSeq += 1;
    return demoItemId("ART", replyArtifactSeq++) as ItemId;
  };

  return {
    now,
    revision: () => revision,
    takeSignalChanges: (since) => ({
      signals: signalLog.filter((entry) => entry.seq > since).map((entry) => entry.signal),
      seq: revision,
    }),
    takeArtifactChanges: (since) => ({
      artifacts: artifactLog.filter((entry) => entry.seq > since).map((entry) => entry.change),
      seq: revision,
    }),
    pairComplete: async () => outcomeFail("invalid", "The demo is already paired."),
    canvases: async () =>
      outcomeOk([
        { canvasName: DEMO_CANVAS, title: DEMO_CANVAS_TITLE, active: true, playing: true, needsYou: feedNow().count },
      ]),
    feeds: async (canvasName) =>
      canvasName === undefined || known(canvasName) ? outcomeOk([feedNow()]) : outcomeFail("not-found", "No such canvas."),
    seats: async (canvasName) => (known(canvasName) ? outcomeOk(seatsNow()) : outcomeFail("not-found", "No such canvas.")),
    seatDetail: async (canvasName, nodeId) => {
      const seat = known(canvasName) ? seatsNow().find((candidate) => candidate.nodeId === nodeId) : undefined;
      if (!seat) return outcomeFail("not-found", "No such seat.");
      const regionId = regionIdOf(nodeId);
      const briefing = regionId === null ? undefined : DEMO_BRIEFINGS[regionId];
      return outcomeOk({
        ...seat,
        ...(briefing !== undefined ? { briefing } : {}),
        preambles: (DEMO_PREAMBLES[nodeId] ?? []).filter((preamble) => preamble.expiresAt > clock),
        signals: [...signals.values()]
          .filter((signal) => signal.nodeId === nodeId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, COMPANION_SEAT_HISTORY_LIMIT),
        activity: [...(activity.get(nodeId) ?? [])].slice(0, COMPANION_SEAT_HISTORY_LIMIT),
        connected: companionConnected(
          (DEMO_CONNECTED[nodeId] ?? []).map((id) => ({ nodeId: id, name: SEATS.find((peer) => peer.id === id)?.name ?? id })),
        ),
      });
    },
    answerSignal: async (signalId, text, quiet, attachments) => {
      if (attachments.length > 0) return outcomeFail("invalid", "The demo does not take files.");
      const signal = signals.get(signalId);
      if (!signal) return outcomeFail("not-found", `No signal ${signalId}.`);
      if (signal.state !== "open") return outcomeFail("conflict", "That signal is no longer open.", signal);
      const typed = text.trim();
      if (!typed && !quiet) return outcomeFail("invalid", "An answer needs some text.");
      const at = tick();
      const answer = typed || AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE;
      const answered: AgentSignal = { ...signal, state: "answered", response: { text: answer, at }, closedAt: at };
      noteSignal(answered);
      // A quiet answer sends no mail, as main's: the seat is not woken.
      if (quiet) noteActivity(signal.nodeId, { at, label: `${signal.kind} answered quietly`, kind: "signal" });
      else appendOperatorMail(signal.nodeId, answer, at);
      return outcomeOk(answered);
    },
    // A document handed in on an artifact form, as the Mac's replyAgentSignal:
    // the form rules it, the write's op id is the reply's, the signal answers.
    answerSignalArtifact: async (signalId, markdown, replyId) => {
      const signal = signals.get(signalId);
      if (!signal) return outcomeFail("not-found", `No signal ${signalId}.`);
      if (signal.state !== "open") return outcomeFail("conflict", `That signal is already ${signal.state}.`, signal);
      const form = signal.form;
      if (form === undefined) return outcomeFail("invalid", "this signal asks for no work: answer it instead of handing work in");
      const ruled = ruleSignalReply(form, { kind: "artifact", markdown, replyId });
      if (!ruled.ok) return outcomeFail("invalid", ruled.message);
      if (form.kind !== "artifact") return outcomeFail("invalid", "this signal asks for a document; write it in the signal");
      const shelf = CANVAS.nodes.get(asNodeId(form.nodeId));
      if (shelf === undefined || shelf.kind !== "artifacts")
        return outcomeFail("invalid", `the Artifacts node this signal writes into is gone from ${signal.canvasName}`);
      // The reply's id is the write's op id, as the Mac's submit makes it: a resend writes one document.
      const replayed = applyOps.get(replyId);
      let head =
        replayed !== undefined && replayed.disposition === "applied" && replayed.artifact !== undefined
          ? replayed.artifact
          : undefined;
      if (head === undefined) {
        const artifactId = mintReplyArtifactId();
        const create: ArtifactOp = {
          op: "create",
          title: form.title,
          body: { type: "document", markdown },
          ...(form.labels.length === 0 ? {} : { labels: [...form.labels] }),
        };
        const written = createArtifact(form.nodeId, artifactId, create);
        if (!written.ok) return written;
        await keep(replyId, create, { disposition: "applied", artifact: written.value, version: written.value.version });
        head = written.value;
      }
      const at = tick();
      const response = `${form.title} is written, ${ruled.words} ${ruled.words === 1 ? "word" : "words"}.`;
      const answered: AgentSignal = {
        ...signal,
        state: "answered",
        response: { text: response, at, artifact: { nodeId: form.nodeId, artifactId: head.artifactId, title: form.title, words: ruled.words } },
        closedAt: at,
      };
      noteSignal(answered);
      appendOperatorMail(signal.nodeId, response, at);
      return outcomeOk(answered);
    },
    dismissSignal: async (signalId) => {
      const signal = signals.get(signalId);
      if (!signal) return outcomeFail("not-found", `No signal ${signalId}.`);
      if (signal.state !== "open") return outcomeFail("conflict", "That signal is no longer open.", signal);
      const at = tick();
      const dismissed: AgentSignal = { ...signal, state: "dismissed", closedAt: at };
      noteSignal(dismissed);
      noteActivity(signal.nodeId, { at, label: `${signal.kind} dismissed`, kind: "signal" });
      return outcomeOk(dismissed);
    },
    mailList: async (canvasName, nodeId, limit) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      return outcomeOk(
        mail
          .filter((message) => message.nodeId === nodeId)
          .sort((a, b) => b.at - a.at || b.messageId.localeCompare(a.messageId))
          .slice(0, limit)
          .map((message) => ({ ...message, canvasName: DEMO_CANVAS })),
      );
    },
    mailSend: async (canvasName, nodeId, text, thread: CompanionMailThread = {}) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      if ((thread.attachments?.length ?? 0) > 0) return outcomeFail("invalid", "The demo does not take files.");
      const body = text.trim();
      if (!body) return outcomeFail("invalid", "Mail needs some text.");
      // A seat the text links must be wired here, as on the Mac.
      const linked = mentionedOnce(mentionsOf(body, (id) => (seatExists(id) ? "agent" : undefined)))
        .flatMap((ref) => (ref.kind === "seat" && ref.nodeId !== nodeId ? [ref.nodeId as string] : []));
      if (linked.some((id) => !(DEMO_CONNECTED[nodeId] ?? []).includes(id))) {
        return outcomeFail("invalid", "A mentioned seat is not connected to this one.");
      }
      const threads = seatMailThreads(threadsInput(), nodeId);
      let threadId: string | undefined;
      if (thread.inReplyTo !== undefined) {
        const parent = threads
          .flatMap((held) => seatMailThreadMessages(threadsInput(), nodeId, held.threadId))
          .find((message) => message.messageId === thread.inReplyTo);
        if (parent === undefined) return outcomeFail("not-found", "That mail is not in this seat's threads.");
        if (thread.threadId !== undefined && thread.threadId !== parent.threadId) {
          return outcomeFail("invalid", "That mail is in another thread.");
        }
        threadId = parent.threadId;
      } else if (thread.threadId !== undefined) {
        if (!threads.some((held) => held.threadId === thread.threadId)) {
          return outcomeFail("not-found", "That thread is not one of this seat's.");
        }
        threadId = thread.threadId;
      }
      CANVAS = toFront(CANVAS, nodeId);
      return outcomeOk(
        appendOperatorMail(nodeId, body, tick(), {
          ...(threadId === undefined ? {} : { threadId }),
          ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
        }),
      );
    },
    threads: async (canvasName, nodeId, page) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      return outcomeOk(companionThreadsPage(threadsInput(), nodeId, page));
    },
    thread: async (canvasName, nodeId, threadId, page) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      const thread = companionThreadPage(threadsInput(), nodeId, threadId, page);
      if (thread === undefined) return outcomeFail("not-found", "That thread is not one of this seat's.");
      return outcomeOk(thread);
    },
    threadRead: async (canvasName, nodeId, threadId, through) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      const messages = seatMailThreadEntries(threadsInput(), nodeId).get(threadId);
      if (messages === undefined) return outcomeFail("not-found", "That thread is not one of this seat's.");
      const target = through === undefined ? messages.at(-1) : messages.find((message) => message.messageId === through);
      if (target === undefined) return outcomeFail("invalid", "That mail is not in this thread.");
      const held = readPoints.get(threadId);
      if (held === undefined || mailAfter(target, readPointKey(held))) readPoints.set(threadId, { through: target.messageId, at: tick() });
      const read = companionThreadRead(threadsInput(), nodeId, threadId);
      return read === undefined ? outcomeFail("not-found", "That thread is not one of this seat's.") : outcomeOk(read);
    },
    comments: async (args) => {
      if (!known(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      if (!DEMO_ARTIFACTS.some((artifact) => artifact.head.artifactId === args.subject.artifactId)) {
        return outcomeFail("not-found", "That artifact is not on this canvas.");
      }
      const held = commentThreads.filter((thread) => thread.artifactId === args.subject.artifactId);
      return outcomeOk(
        companionCommentsPage(held, {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.before === undefined ? {} : { before: args.before }),
        }),
      );
    },
    comment: async (args) => {
      if (!known(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      if (!DEMO_ARTIFACTS.some((artifact) => artifact.head.artifactId === args.subject.artifactId)) {
        return outcomeFail("not-found", "That artifact is not on this canvas.");
      }
      const replayed = commentOps.get(args.opId);
      if (replayed !== undefined) return outcomeOk(replayed);
      const at = tick();
      commentSeq += 1;
      const post: CommentPostView = {
        postId: demoMailId(at, "SENT", commentSeq),
        author: { kind: "operator", name: "operator" },
        text: args.text,
        at,
      };
      if (args.threadId !== undefined) {
        const thread = commentThreads.find((held) => held.threadId === args.threadId && held.artifactId === args.subject.artifactId);
        if (thread === undefined) return outcomeFail("not-found", "That thread is not on this artifact.");
        thread.posts.push(post);
        const answer = { threadId: thread.threadId, messageId: post.postId };
        commentOps.set(args.opId, answer);
        return outcomeOk(answer);
      }
      const threadId = demoItemId("THR", 100 + commentThreads.length);
      commentThreads.push({
        threadId,
        artifactId: args.subject.artifactId,
        ...(args.anchor === undefined ? {} : { anchor: args.anchor }),
        posts: [post],
      });
      const answer = { threadId, messageId: post.postId };
      commentOps.set(args.opId, answer);
      return outcomeOk(answer);
    },
    mentionCandidates: async (args) => {
      if (!known(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      const from = asNodeId(args.from);
      if (CANVAS.nodes.get(from) === undefined) return outcomeFail("not-found", "That node is not on this canvas.");
      const wired = (DEMO_CONNECTED[args.from] ?? []).flatMap((nodeId) => {
        const seat = SEATS.find((candidate) => candidate.id === nodeId);
        return seat === undefined ? [] : [{ nodeId: seat.id, name: seat.name }];
      });
      const candidates = [
        ...connectedSeatCandidates(wired),
        ...candidatesOfNodes(CANVAS, mentionableNodesFrom(CANVAS, from), {
          tasksOf: () => [{ id: DEMO_TASK_PRICING as ItemId, title: "launch pricing", number: 1, note: "backlog" }],
          artifactsOf: (nodeId) =>
            DEMO_ARTIFACTS.filter((artifact) => artifact.head.nodeId === nodeId && !artifact.head.archived).map((artifact) => ({
              id: artifact.head.artifactId,
              title: artifact.head.title,
            })),
        }),
      ];
      const narrowed = filterCandidates(candidates, { trigger: args.trigger, query: args.query ?? "" });
      const limit = Math.min(args.limit ?? 50, 50);
      return outcomeOk({
        candidates: narrowed.slice(0, limit).map((candidate) => ({
          ref: candidate.ref,
          kind: candidate.ref.kind,
          label: candidate.label.slice(0, 320),
          title: (candidate.title ?? candidate.label).slice(0, 320),
          ...(candidate.detail === undefined ? {} : { subtitle: candidate.detail.slice(0, 320) }),
          ...(candidate.note === undefined ? {} : { note: candidate.note.slice(0, 320) }),
        })),
      });
    },
    mentionResolve: async (args) => {
      if (!known(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      const faces: Array<CompanionResultByOp["mentions.resolve"]["faces"][number]> = [];
      for (const href of args.hrefs) {
        const target = parseMentionHref(href);
        const label = href.slice(0, 400);
        const node = target === undefined ? undefined : CANVAS.nodes.get(asNodeId(target.nodeId));
        if (target === undefined || node === undefined) {
          faces.push({ kind: "missing", label, reason: "gone" });
          continue;
        }
        if (node.kind === "agent") {
          const seat = seatsNow().find((candidate) => candidate.nodeId === node.id);
          faces.push(
            seat === undefined
              ? { kind: "missing", label, reason: "gone", of: "seat" }
              : {
                  kind: "seat",
                  nodeId: asNodeId(seat.nodeId),
                  name: seat.name,
                  portraitIdentity: seat.portraitIdentity,
                  state: seat.state,
                  ...(seat.ring === undefined ? {} : { ring: seat.ring }),
                },
          );
          continue;
        }
        if (node.kind === "task") {
          faces.push({
            kind: "task",
            nodeId: node.id,
            taskId: DEMO_TASK_PRICING as ItemId,
            number: 1 as never,
            title: "launch pricing",
            state: "backlog",
          });
          continue;
        }
        if (node.kind === "artifacts") {
          const artifact = target.item === undefined ? undefined : DEMO_ARTIFACTS.find((held) => held.head.artifactId === target.item);
          faces.push(
            artifact === undefined
              ? { kind: "missing", label, reason: "gone", of: "artifact" }
              : {
                  kind: "artifact",
                  nodeId: artifact.head.nodeId,
                  artifactId: artifact.head.artifactId,
                  type: artifact.head.type,
                  title: artifact.head.title,
                  version: artifact.head.version,
                  lines: artifactFirstLines(artifact.body).slice(0, 2),
                  archived: artifact.head.archived,
                  ...(artifact.head.nodeId === node.id ? {} : { movedTo: artifact.head.nodeId }),
                },
          );
          continue;
        }
        if (node.kind === "page") {
          faces.push({ kind: "page", nodeId: node.id, title: node.label ?? "", ...(node.url === undefined || node.url === "" ? {} : { url: node.url }), state: "resting" });
          continue;
        }
        faces.push({ kind: "missing", label, reason: "gone" });
      }
      return outcomeOk({ faces });
    },
    mentionLinkedFrom: async (args) => {
      if (!known(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      const target = args.target;
      const bodies =
        target.kind !== "artifact"
          ? []
          : DEMO_ARTIFACTS.flatMap((held) => {
              if (held.body.type !== "document") return [];
              const line = held.body.markdown
                .split("\n")
                .find((one) => one.includes(`item=${target.artifactId}`) && one.includes(`node=${target.nodeId}`));
              if (line === undefined) return [];
              return [
                {
                  nodeId: held.head.nodeId,
                  artifactId: held.head.artifactId,
                  title: held.head.title,
                  type: held.head.type,
                  line: (line ?? "").slice(0, 400),
                  at: held.head.updatedAt,
                },
              ];
            });
      return outcomeOk({ bodies, mail: [] });
    },
    // Uploads land only for the artifact purpose: a file body or a pad image an apply then claims.
    stagePiece: async (canvasName, args) => {
      const purpose = args.purpose;
      if (purpose === undefined) return outcomeFail("invalid", "The demo takes files only for artifacts.");
      if (purpose.canvasName !== canvasName) return outcomeFail("invalid", "That piece is for another canvas's artifacts.");
      if (!known(canvasName)) return outcomeFail("not-found", "No such canvas.");
      const stageId = args.stageId ?? `stg_${String(++stageSeq).padStart(32, "0")}`;
      const held = stagedUploads.get(stageId) ?? { canvasName, bytes: new Uint8Array(0) };
      if (args.bytesBase64 !== undefined) {
        const piece = Buffer.from(args.bytesBase64, "base64");
        const next = new Uint8Array(held.bytes.length + piece.length);
        next.set(held.bytes, 0);
        next.set(piece, held.bytes.length);
        held.bytes = next;
      }
      if (args.done === undefined) {
        stagedUploads.set(stageId, held);
        return outcomeOk({ stageId, byteLength: held.bytes.length });
      }
      const expected = args.done.expected;
      if (expected !== undefined && held.bytes.length !== expected.byteLength) {
        stagedUploads.delete(stageId);
        return outcomeFail("invalid", `That file is ${String(held.bytes.length)} bytes, not ${String(expected.byteLength)}.`);
      }
      // The demo never hashes: the ref names the digest the phone declared for these bytes.
      const sha256 = expected?.sha256 ?? ("0".repeat(64) as ContentSha256);
      stagedUploads.delete(stageId);
      stagedBytes.set(sha256, held.bytes);
      stagedByStage.set(stageId, sha256);
      return outcomeOk({
        ref: {
          sha256,
          byteLength: held.bytes.length as ContentByteLength,
          mediaType: args.done.mediaType,
          ...(args.done.displayName === undefined ? {} : { displayName: args.done.displayName }),
        },
      });
    },
    admitStage: async (canvasName) =>
      known(canvasName) ? outcomeOk(undefined) : outcomeFail("not-found", "No such canvas."),
    dropStaged: async (canvasName, stageId) => {
      stagedUploads.delete(stageId);
      const sha256 = stagedByStage.get(stageId);
      if (sha256 !== undefined) {
        stagedByStage.delete(stageId);
        stagedBytes.delete(sha256);
      }
    },
    mailContentRef: async () => undefined,
    quickReplies: async () => outcomeOk({ replies: DEMO_QUICK_REPLIES, quietNotes: DEMO_QUIET_NOTES }),
    portrait: async (portraitIdentity, size, theme, format) => {
      const svg = companionPortraitSvg({ portraitIdentity, size, theme });
      if (format === "svg") return outcomeOk({ svg });
      if (portraitPng === undefined) return outcomeFail("unavailable", "Portraits as images are not in this demo.");
      return outcomeOk({ png: Buffer.from(await portraitPng(svg, size)).toString("base64") });
    },
    contentRange: async (ref, offset, length) => {
      const stored = DEMO_CONTENT.find((content) => content.ref.sha256 === ref.sha256);
      const bytes =
        stored === undefined
          ? (demoArtifactBytes(ref.sha256) ?? appliedBytes.get(ref.sha256) ?? stagedBytes.get(ref.sha256))
          : new TextEncoder().encode(stored.text);
      if (bytes === undefined) return outcomeFail("unavailable");
      return outcomeOk(bytes.subarray(offset, offset + length));
    },
    machines: async () => outcomeOk(DEMO_MACHINES.map((entry) => entry.machine)),
    machine: async (name, minLevel) => {
      const entry = DEMO_MACHINES.find((candidate) => candidate.machine.name === name);
      if (entry === undefined) return outcomeFail("not-found", "No such machine on this Mac.");
      const rank = (level: CompanionMachineLogLevel): number => DEMO_LOG_LEVELS.indexOf(level);
      const logs = typeof entry.logs === "string"
        ? { unavailable: entry.logs }
        : { rows: entry.logs.filter((row) => minLevel === undefined || rank(row.level) >= rank(minLevel)), cut: false };
      return outcomeOk({ machine: entry.machine, status: entry.status, logs });
    },
    tailnetPeers: async () => outcomeOk({ available: true, peers: DEMO_TAILNET }),
    ...demoArtifactReads,
    // One write, ruled as the Mac rules: applied with the head, a conflict with the
    // head for an edit behind the version, invalid for what the ruler cannot read.
    artifactApply: async (args) => {
      if (!known(args.canvasName)) return outcomeFail("not-found", "No such canvas.");
      const replayed = applyOps.get(args.opId);
      if (replayed !== undefined) return outcomeOk(replayed);
      const op = args.op;
      const conflict = (reason: "stale" | "rebase_conflict", head: Artifact, message: string) =>
        ({ ok: false as const, error: { code: "conflict" as const, message, reason, artifact: head } });
      const kept = (result: CompanionResultByOp["artifact.apply"]): Promise<CompanionOutcome<CompanionResultByOp["artifact.apply"]>> =>
        keep(args.opId, op, result);

      if (op.op === "labelColour") {
        if (!artifactsNodeIds.has(args.nodeId)) return outcomeFail("not-found", "That is not one of this canvas's Artifacts nodes.");
        const label = artifactLabelOf(op.label);
        if (label === undefined) return outcomeFail("invalid", ARTIFACT_LABEL_RULE);
        const nodeColours = (mutableColours[args.nodeId] ??= {});
        if (op.colour === null) delete nodeColours[label];
        else nodeColours[label] = op.colour;
        tick();
        return kept({ disposition: "applied" });
      }

      if (op.op === "create") {
        if (args.artifactId === undefined) return outcomeFail("invalid", "A create names the artifact it makes.");
        const created = createArtifact(args.nodeId, args.artifactId, op);
        if (!created.ok) return created;
        return kept({ disposition: "applied", artifact: created.value, version: 1 as ArtifactVersion });
      }

      if (args.artifactId === undefined) return outcomeFail("invalid", "That write names no artifact.");
      const held = mutableArtifacts.find((candidate) => candidate.head.artifactId === args.artifactId);
      if (held === undefined || held.head.nodeId !== args.nodeId)
        return outcomeFail("not-found", "That artifact is not on that node of this canvas.");
      const at = tick();
      switch (op.op) {
        case "edit": {
          const edits = appliedEdits.get(held.head.artifactId) ?? [];
          const since = edits.slice(Math.max(0, edits.length - (held.head.version - op.edit.baseVersion)));
          const ruled = ruleArtifactEdit({ version: held.head.version, body: held.body }, op.edit, since);
          if (Result.isFailure(ruled)) {
            const code = ruled.failure.code;
            if (code === "stale" || code === "rebase_conflict") return conflict(code, held.head, ruled.failure.message.slice(0, 500));
            return outcomeFail("invalid", ruled.failure.message.slice(0, 500));
          }
          held.body = ruled.success.body;
          held.head.version = ruled.success.version;
          held.head.updatedAt = at;
          held.versions.push({ artifactId: held.head.artifactId, version: ruled.success.version, author: OPERATOR_AUTHOR, at, body: ruled.success.body });
          edits.push(op.edit);
          appliedEdits.set(held.head.artifactId, edits);
          return kept({ disposition: "applied", artifact: held.head, version: held.head.version });
        }
        case "retitle":
          held.head.title = op.title;
          held.head.updatedAt = at;
          return kept({ disposition: "applied", artifact: held.head, version: held.head.version });
        case "labels": {
          const labels = artifactLabelsOf(op.labels);
          if (labels === undefined) return outcomeFail("invalid", ARTIFACT_LABEL_RULE);
          held.head.labels = labels;
          held.head.updatedAt = at;
          return kept({ disposition: "applied", artifact: held.head, version: held.head.version });
        }
        case "archive":
        case "restore":
          held.head.archived = op.op === "archive";
          held.head.updatedAt = at;
          return kept({ disposition: "applied", artifact: held.head, version: held.head.version });
        case "tasks":
          held.head.taskIds = op.taskIds;
          held.head.updatedAt = at;
          return kept({ disposition: "applied", artifact: held.head, version: held.head.version });
        case "move":
          if (!artifactsNodeIds.has(op.to)) return outcomeFail("not-found", "That is not one of this canvas's Artifacts nodes.");
          // Only the node changes: no version, no body, not even when it last changed.
          held.head.nodeId = op.to;
          return kept({ disposition: "applied", artifact: held.head, version: held.head.version });
      }
    },
    canvasScene: async (canvasName) => known(canvasName) ? outcomeOk(companionCanvasDrawn(CANVAS)) : outcomeFail("not-found", "No such canvas."),
  };
};

/** The demo as a session host: one world, changes announced after each write. */
export const makeDemoHost = (options: {
  readonly appVersion?: string;
  /** The machine the demo runs on; the caller knows it, the demo invents none. */
  readonly machineName: string;
  readonly portraitPng?: DemoPortraitPng;
}): CompanionHost => {
  const backend = makeDemoBackend(options.machineName, options.portraitPng);
  const allowWrite = makeWriteLimiter();
  const allowArtifactWrite = makeWriteLimiter(COMPANION_ARTIFACT_WRITE_LIMIT);
  const gates = makeCompanionGates();
  let waiters: Array<() => void> = [];
  const wake = (): void => {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  };
  const cursorOf = (seq: number): string => `demo:${seq}`;
  const seqOf = (cursor: string | undefined): number | undefined => {
    const match = /^demo:(\d+)$/u.exec(cursor ?? "");
    return match ? Number(match[1]) : undefined;
  };

  return {
    hello: async () => ({
      ok: true,
      hello: {
        appVersion: options.appVersion ?? "demo",
        deviceId: DEMO_DEVICE_ID,
        deviceName: DEMO_DEVICE_NAME,
        station: DEMO_STATION,
        features: COMPANION_FEATURES,
        serverTime: backend.now(),
      },
    }),
    call: async (frame: CompanionRequestFrame): Promise<CompanionResponseFrame> => {
      const before = backend.revision();
      const response = await handleCompanionRequest(frame, {
        backend,
        device: { deviceId: DEMO_DEVICE_ID, state: "paired" },
        allowWrite,
        allowArtifactWrite,
        gates,
      });
      if (backend.revision() !== before) wake();
      return response;
    },
    waitChange: async (cursor, waitMs): Promise<CompanionChange> => {
      const since = seqOf(cursor);
      if (since === undefined) {
        return { cursor: cursorOf(backend.revision()), changed: false, signals: [], reset: cursor !== undefined };
      }
      if (backend.revision() === since) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== done);
            resolve();
          }, waitMs);
          const done = (): void => {
            clearTimeout(timer);
            resolve();
          };
          waiters.push(done);
        });
      }
      const changes = backend.takeSignalChanges(since);
      const artifacts = backend.takeArtifactChanges(since);
      return {
        cursor: cursorOf(changes.seq),
        changed: changes.seq !== since,
        signals: changes.signals,
        artifacts: artifacts.artifacts,
        reset: false,
      };
    },
  };
};

/** For tests: a demo request frame. */
export const demoRequest = (id: string, op: CompanionRequestFrame["op"], args: object = {}): string =>
  JSON.stringify({ v: COMPANION_PROTOCOL, type: "request", id, op, args });

