/**
 * The companion backend in the running app: every answer a phone gets, read
 * from the same planes and projections the desktop uses.
 *
 * - feeds: `buildOperatorFeed` over the canvas document, its signals, the
 *   seat state machine's proven attention, and Jev's readings while seat
 *   awareness is on (the ⌘I feed's own inputs, joined in main);
 * - seats: `companionSeat` over the same inputs plus the occupant process and
 *   the desktop's own done-but-unread report;
 * - signals, mail: `operator-actions` (the desktop's write paths);
 * - mail history: the desktop's mailbox projection (`mailboxRows`);
 * - activity: the seat sidebar's recent-ops feed and labels;
 * - portraits: `portraitSvg` wearing the seat's stored override.
 */

import { Effect } from "effect";
import type { AgentSignal } from "@shared/agent-signals";
import { rollupSeatSignals } from "@shared/agent-signals";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { outcomeFail, outcomeOk, type CompanionBackend, type CompanionOutcome } from "@shared/companion-core";
import { companionPortraitSvg } from "@shared/companion-portrait";
import { companionSeat } from "@shared/companion-seats";
import {
  COMPANION_SEAT_HISTORY_LIMIT,
  type CompanionActivity,
  type CompanionCanvas,
  type CompanionMail,
  type CompanionSeat,
} from "@shared/companion-protocol";
import { installCosmeticPacks } from "@shared/cosmetics/catalog";
import { decodeCosmeticPacks } from "@shared/cosmetics/load";
import { regionStack } from "@shared/graph";
import {
  buildOperatorFeed,
  feedSeatsFromDoc,
  type FeedHealth,
  type FeedSeatInput,
  type OperatorFeed,
} from "@shared/operator-feed";
import { overlayManifest } from "@shared/overlay";
import { feedSettings } from "@shared/settings";
import { resolveTerminalBinding } from "@shared/terminal";
import { THREAD_HEALTH_LABEL, THREAD_HEALTH_TONE, THREAD_HEALTH_TTL_MS, type ThreadHealthReading } from "@shared/thread-health";
import { mailboxRows, recentOpAtMs, recentOpLabel } from "@renderer/lib/actor-ledger";
import { nodeTitle } from "@renderer/lib/presentation";
import type { WorkSeatRecentOp } from "@shared/work-recent-ops";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
import { PausePlane } from "../pause-plane";
import { PortraitOverrideRepository } from "../portraits/repository";
import { SettingsService } from "../settings/service";
import { AgentSignalRepository } from "../signals/repository";
import { listCanvasAgentSignals } from "../signals/operator";
import { seatStateRuntime } from "../term/agent-state";
import { termPlane } from "../term/plane";
import { seatAwarenessPlane } from "../term/seat-awareness";
import { WorkService } from "../work/service";
import { desktopActiveCanvas, desktopDoneUnread } from "./desktop-report";
import { answerSignalAsOperator, dismissSignalAsOperator, sendOperatorMail, type OperatorActionResult } from "./operator-actions";
import { livePreambles } from "./preambles";

// Portraits wear the packs this build bundles, as the renderer's do.
installCosmeticPacks(decodeCosmeticPacks(overlayManifest.cosmetics));

const isAgentSeat = (node: CanvasNode): boolean => node.type !== "group" && node.ether?.entity?.kind === "agent";

const bindingOf = (node: CanvasNode): string | undefined => resolveTerminalBinding(node)?.bindingId;

type CanvasView = {
  readonly doc: CanvasDoc;
  readonly signals: ReadonlyArray<AgentSignal>;
};

const readCanvas = async (canvasName: string): Promise<CanvasView | undefined> => {
  const doc = await AppRuntime.runPromise(
    Effect.flatMap(CanvasesService, (canvases) => canvases.read(canvasName)).pipe(
      Effect.map((result) => result.doc),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  );
  if (doc === undefined) return undefined;
  const signals = await AppRuntime.runPromise(listCanvasAgentSignals(canvasName).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<AgentSignal>))));
  return { doc, signals };
};

const canvasNames = (): Promise<ReadonlyArray<string>> =>
  AppRuntime.runPromise(
    Effect.flatMap(CanvasesService, (canvases) => canvases.list).pipe(
      Effect.map((list) => list.map((summary) => summary.name)),
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
    ),
  );

/** Jev's latest reading per binding, only while seat awareness runs. */
const healthByBinding = (): ReadonlyMap<string, ThreadHealthReading> => {
  const out = new Map<string, ThreadHealthReading>();
  if (!seatAwarenessPlane.isEnabled()) return out;
  for (const event of seatAwarenessPlane.currentEvents()) {
    if (event.kind !== "assessment" || !event.assessment.health) continue;
    const prior = out.get(event.assessment.bindingId);
    if (!prior || prior.observedAt <= event.assessment.health.observedAt) {
      out.set(event.assessment.bindingId, event.assessment.health);
    }
  }
  return out;
};

const controlByBinding = () => new Map(seatStateRuntime.currentEvents().map((event) => [event.bindingId, event] as const));

const feedHealthOf = (reading: ThreadHealthReading, now: number): FeedHealth => ({
  value: reading.value,
  tone: THREAD_HEALTH_TONE[reading.value],
  label: THREAD_HEALTH_LABEL[reading.value],
  confidence: reading.confidence,
  observedAt: reading.observedAt,
  stale: now - reading.observedAt > THREAD_HEALTH_TTL_MS,
});

const feedSeats = (doc: CanvasDoc, now: number): ReadonlyArray<FeedSeatInput> => {
  const controls = controlByBinding();
  const health = healthByBinding();
  const attentionByNodeId = new Map<string, { readonly reason: string; readonly at: number }>();
  const healthByNodeId = new Map<string, { readonly reading: ThreadHealthReading }>();
  for (const node of doc.nodes) {
    if (!isAgentSeat(node)) continue;
    const binding = bindingOf(node);
    if (!binding) continue;
    const control = controls.get(binding);
    if (control?.state === "attention") attentionByNodeId.set(node.id, { reason: control.reason, at: control.at });
    const reading = health.get(binding);
    if (reading) healthByNodeId.set(node.id, { reading });
  }
  void now;
  return feedSeatsFromDoc(doc, { nameOf: nodeTitle, attentionByNodeId, healthByNodeId });
};

const feedFor = (canvasName: string, view: CanvasView, now: number): OperatorFeed =>
  buildOperatorFeed({ canvasName, nowMs: now, seats: feedSeats(view.doc, now), signals: view.signals });

const processOf = (binding: string | undefined): "running" | "starting" | "stopped" | undefined => {
  if (!binding) return undefined;
  const status = termPlane.host.get(binding)?.status;
  if (status === "running") return "running";
  if (status === "starting") return "starting";
  return "stopped";
};

const seatsFor = (canvasName: string, view: CanvasView, now: number): ReadonlyArray<CompanionSeat> => {
  const controls = controlByBinding();
  const health = healthByBinding();
  const rollups = rollupSeatSignals(view.signals);
  return feedSeatsFromDoc(view.doc, { nameOf: nodeTitle }).map((entry) => {
    const node = view.doc.nodes.find((candidate) => candidate.id === entry.seat.nodeId)!;
    const binding = bindingOf(node);
    const control = binding ? controls.get(binding) : undefined;
    const reading = binding ? health.get(binding) : undefined;
    const rollup = rollups.get(entry.seat.nodeId);
    const process = processOf(binding);
    return companionSeat({
      seat: entry.seat,
      region: entry.region,
      ...(control ? { control: { state: control.state, reason: control.reason, at: control.at } } : {}),
      ...(process ? { process } : {}),
      ...(desktopDoneUnread(canvasName, entry.seat.nodeId) ? { doneUnread: true } : {}),
      ...(rollup ? { signal: { kind: rollup.kind, signalId: rollup.signal.signalId, openCount: rollup.openCount } } : {}),
      ...(reading ? { health: feedHealthOf(reading, now) } : {}),
    });
  });
};

/** The innermost region around the seat that carries a briefing. */
const briefingFor = (doc: CanvasDoc, nodeId: string): string | undefined => {
  const stack = regionStack(doc, nodeId);
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const instruction = (stack[i] as { ether?: { region?: { instruction?: string } } }).ether?.region?.instruction?.trim();
    if (instruction) return instruction;
  }
  return undefined;
};

const ACTIVITY_KIND: Readonly<Record<WorkSeatRecentOp["operation"], CompanionActivity["kind"]>> = {
  "message.append": "mail",
  "delivery.accepted": "mail",
  "artifact.publish": "work",
  "task.claim": "work",
  "request.create": "work",
  "board.topic.create": "work",
  "board.post.append": "work",
} as Readonly<Record<WorkSeatRecentOp["operation"], CompanionActivity["kind"]>>;

const activityFor = async (canvasName: string, doc: CanvasDoc, nodeId: string): Promise<ReadonlyArray<CompanionActivity>> => {
  const feed = await AppRuntime.runPromise(
    Effect.flatMap(WorkService, (work) => work.workSeatRecentOps(canvasName, nodeId, COMPANION_SEAT_HISTORY_LIMIT)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  );
  if (!feed?.ok) return [];
  return feed.data.operations
    .map((op): CompanionActivity => {
      const target = op.targetNodeId === nodeId ? undefined : doc.nodes.find((node) => node.id === op.targetNodeId);
      return {
        at: recentOpAtMs(op) ?? 0,
        label: recentOpLabel(op),
        kind: ACTIVITY_KIND[op.operation] ?? "other",
        ...(target ? { targetName: nodeTitle(target) } : {}),
      };
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, COMPANION_SEAT_HISTORY_LIMIT);
};

/** Mail failures are transient delivery events; kept here so mail.list can say so. */
const failedMail = new Set<string>();
export const noteMailFailure = (messageId: string): void => {
  failedMail.add(messageId);
  if (failedMail.size > 1_000) failedMail.delete(failedMail.values().next().value!);
};

const mailFor = (canvasName: string, doc: CanvasDoc, nodeId: string): ReadonlyArray<CompanionMail> => {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const delivery = (messageId: string, state: "delivered" | "waiting"): CompanionMail["delivery"] =>
    failedMail.has(messageId) ? "failed" : state === "delivered" ? "delivered" : "waiting_for_seat";
  const inbound = mailboxRows(doc, node)
    .filter((row) => row.direction === "in")
    .map(
      (row): CompanionMail => ({
        messageId: row.messageId,
        canvasName,
        nodeId,
        direction: "to_seat",
        from:
          row.fromNodeId === undefined || row.fromNodeId === "operator"
            ? { kind: "operator" }
            : { kind: "seat", nodeId: row.fromNodeId, name: row.fromLabel },
        text: row.body,
        at: row.sentAtMs ?? 0,
        delivery: delivery(row.messageId, row.delivery),
      }),
    );
  const name = nodeTitle(node);
  const outbound = doc.nodes
    .filter((peer) => peer.id !== nodeId && isAgentSeat(peer))
    .flatMap((peer) =>
      mailboxRows(doc, peer)
        .filter((row) => row.direction === "in" && row.fromNodeId === nodeId)
        .map(
          (row): CompanionMail => ({
            messageId: row.messageId,
            canvasName,
            nodeId,
            direction: "from_seat",
            from: { kind: "seat", nodeId, name },
            text: row.body,
            at: row.sentAtMs ?? 0,
            delivery: delivery(row.messageId, row.delivery),
          }),
        ),
    );
  return [...inbound, ...outbound].sort((a, b) => b.at - a.at || b.messageId.localeCompare(a.messageId));
};

const fromAction = <A, B>(result: OperatorActionResult<A>, map: (value: A) => B): CompanionOutcome<B> => {
  if (result.ok) return outcomeOk(map(result.value));
  const code = result.reason === "failed" ? "internal" : result.reason;
  return outcomeFail(code, result.message.slice(0, 500), result.signal);
};

export type MainBackendDeps = {
  readonly pairComplete: CompanionBackend["pairComplete"];
};

export const makeMainCompanionBackend = (deps: MainBackendDeps): CompanionBackend => ({
  now: Date.now,
  pairComplete: deps.pairComplete,

  canvases: async () => {
    const now = Date.now();
    const names = await canvasNames();
    const pause = await AppRuntime.runPromise(Effect.map(PausePlane, (plane) => plane));
    const active = desktopActiveCanvas();
    const out: CompanionCanvas[] = [];
    for (const name of names) {
      const view = await readCanvas(name);
      out.push({
        canvasName: name,
        title: name,
        active: name === active,
        playing: pause.stateFor(name).playing,
        needsYou: view ? feedFor(name, view, now).count : 0,
      });
    }
    return outcomeOk(out);
  },

  feeds: async (canvasName) => {
    const now = Date.now();
    const names = canvasName === undefined ? await canvasNames() : [canvasName];
    const feeds: OperatorFeed[] = [];
    for (const name of names) {
      const view = await readCanvas(name);
      if (!view) {
        if (canvasName !== undefined) return outcomeFail("not-found", "No such canvas.");
        continue;
      }
      feeds.push(feedFor(name, view, now));
    }
    return outcomeOk(feeds);
  },

  seats: async (canvasName) => {
    const view = await readCanvas(canvasName);
    return view ? outcomeOk(seatsFor(canvasName, view, Date.now())) : outcomeFail("not-found", "No such canvas.");
  },

  seatDetail: async (canvasName, nodeId) => {
    const view = await readCanvas(canvasName);
    if (!view) return outcomeFail("not-found", "No such canvas.");
    const seat = seatsFor(canvasName, view, Date.now()).find((candidate) => candidate.nodeId === nodeId);
    if (!seat) return outcomeFail("not-found", "No such seat.");
    const signals = await AppRuntime.runPromise(
      Effect.flatMap(AgentSignalRepository, (repository) => repository.listSeat({ canvasName, nodeId })).pipe(
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<AgentSignal>)),
      ),
    );
    const briefing = briefingFor(view.doc, nodeId);
    return outcomeOk({
      ...seat,
      ...(briefing !== undefined ? { briefing } : {}),
      preambles: livePreambles(canvasName, nodeId),
      signals: [...signals].sort((a, b) => b.createdAt - a.createdAt).slice(0, COMPANION_SEAT_HISTORY_LIMIT),
      activity: await activityFor(canvasName, view.doc, nodeId),
    });
  },

  answerSignal: async (signalId, text) => fromAction(await answerSignalAsOperator(signalId, text), (signal) => signal),
  dismissSignal: async (signalId) => fromAction(await dismissSignalAsOperator(signalId), (signal) => signal),

  mailList: async (canvasName, nodeId, limit) => {
    const view = await readCanvas(canvasName);
    if (!view) return outcomeFail("not-found", "No such canvas.");
    if (!view.doc.nodes.some((node) => node.id === nodeId && isAgentSeat(node))) return outcomeFail("not-found", "No such seat.");
    return outcomeOk(mailFor(canvasName, view.doc, nodeId).slice(0, limit));
  },

  mailSend: async (canvasName, nodeId, text) =>
    fromAction(await sendOperatorMail(canvasName, nodeId, text), (sent) => ({
      messageId: sent.messageId,
      canvasName,
      nodeId,
      direction: "to_seat" as const,
      from: { kind: "operator" as const },
      text: text.trim(),
      at: sent.at,
      delivery: sent.delivery,
    })),

  quickReplies: async () => {
    const settings = await AppRuntime.runPromise(Effect.flatMap(SettingsService, (service) => service.get));
    return outcomeOk(feedSettings(settings).quickReplies);
  },

  portrait: async (portraitIdentity, size, theme) => {
    const overrides = await AppRuntime.runPromise(
      Effect.flatMap(PortraitOverrideRepository, (repository) => repository.list()).pipe(
        Effect.catch(() => Effect.succeed({} as Record<string, never>)),
      ),
    );
    const config = (overrides as Record<string, Parameters<typeof companionPortraitSvg>[0]["config"]>)[portraitIdentity];
    return outcomeOk(companionPortraitSvg({ portraitIdentity, size, theme, ...(config ? { config } : {}) }));
  },
});
