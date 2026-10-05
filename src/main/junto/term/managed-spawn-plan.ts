/**
 * Re-plan a managed launch at spawn time: session pin or resume, the picker
 * choices recovered from the document launch, and the operator's own
 * arguments. A launch carries no Junto instructions; the seat opens to the
 * harness's own empty composer.
 */

import { randomUUID } from "node:crypto";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import {
  resolveManagedLaunchPlan,
  type ManagedLaunchChoices,
  type ManagedLaunchPlan,
  type ManagedSpawnIntent,
} from "@shared/managed-terminal-launch";
import {
  isHarnessId,
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";
import type { TerminalLaunch } from "@shared/terminal";
import { recoverDocumentLaunchChoices } from "@shared/launch-choices";
import { usableJuntoHome } from "@shared/junto-home";
import {
  isPinSessionHarness,
  shouldResumeHarnessSession,
} from "./session-existence";

/**
 * Official `bun run dev` sets `JUNTO_HOME` (e.g. ~/.junto-dev) while leaving
 * `HOME` alone so harness state still lives under ~/.grok / ~/.claude.
 * Seeded canvases therefore carry production session pins that may already be
 * owned by a live production seat. Resuming them in the isolated process
 * yields a dead/black TUI — refuse shared resume and pin a fresh id instead.
 *
 * `JUNTO_HOME_OWNS_SESSIONS=1` declares the opposite: every canvas in this
 * tree was authored here, so every pin on it is this tree's own session. The
 * real-harness resume suite runs that way (real HOME for harness logins, an
 * isolated state tree it created) to exercise the resume path production runs.
 */
export const shouldAvoidSharedHarnessResume = (
  juntoHomeEnv: string | undefined = process.env.JUNTO_HOME,
  ownsSessionsEnv: string | undefined = process.env.JUNTO_HOME_OWNS_SESSIONS,
): boolean =>
  usableJuntoHome(juntoHomeEnv) !== undefined && ownsSessionsEnv !== "1";

export type SpawnPlanInput = {
  readonly doc?: CanvasDoc;
  readonly nodeId?: string;
  readonly harness?: string;
  readonly documentLaunch?: TerminalLaunch;
  readonly agentKey?: string;
  readonly profile?: string;
  /** Hermes provider — travels with the model on every cold wake. */
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode (Amp `-m low|medium|high|ultra`). */
  readonly mode?: string;
  readonly permissionMode?: string;
  readonly cwd?: string;
  /** Pin/resume session id from ether.terminal.sessionId. */
  readonly sessionId?: string;
  /** When true, treat sessionId as resume rather than first pin. */
  readonly resume?: boolean;
};

const sessionIdForSpawn = (input: SpawnPlanInput): string | undefined => {
  const explicit = input.sessionId?.trim();
  if (explicit) return explicit;
  if (!input.doc || !input.nodeId) return undefined;
  return input.doc.nodes
    .find((node) => node.id === input.nodeId)
    ?.ether?.terminal?.sessionId?.trim() || undefined;
};

/** Compile the session request without consulting this machine's disk. */
export const makeManagedSpawnIntent = (
  input: SpawnPlanInput,
): ManagedSpawnIntent => {
  const sessionId = sessionIdForSpawn(input);
  return {
    ...(input.documentLaunch
      ? { documentLaunch: input.documentLaunch }
      : {}),
    ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
    ...(sessionId ? { sessionId } : {}),
    resumeRequested: input.resume === true,
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.permissionMode
      ? { permissionMode: input.permissionMode }
      : {}),
  };
};

const profileFromAgentKey = (agentKey: string | undefined): string | undefined => {
  const separator = agentKey?.indexOf(":") ?? -1;
  const profile = separator >= 0 ? agentKey?.slice(separator + 1).trim() : undefined;
  // `${host}:hermes` is the no-profile actor key minted by the node factory.
  return profile && profile !== "hermes" ? profile : undefined;
};

/**
 * Build the spawn plan: recovered picker choices plus the session pin or
 * resume. Undefined for an unknown harness, and for a provisioned harness with
 * no thread to open.
 */
export const planManagedSpawn = (input: SpawnPlanInput): ManagedLaunchPlan | undefined => {
  const harnessRaw = input.harness?.trim();
  if (!harnessRaw || !isHarnessId(harnessRaw)) return undefined;
  const harness: HarnessId = harnessRaw;

  const sessionId = input.sessionId?.trim();
  const recovered = recoverDocumentLaunchChoices(harness, input.documentLaunch);
  const profile = input.profile ?? recovered.profile ??
    (harness === "hermes" ? profileFromAgentKey(input.agentKey) : undefined);
  const cwd =
    input.cwd?.trim() ||
    input.documentLaunch?.cwd?.trim() ||
    undefined;
  // A provisioned session (Amp) is minted BY the harness through its public
  // CLI and stored on the node, so the id itself is the proof and the resume
  // subcommand is the only launch shape there is. Probing local harness state
  // for it would mean reading Amp's private files, which this integration does
  // not do — and launching without the id would drop the seat into Amp's
  // interactive thread picker instead of the thread the node owns.
  const provisioned =
    templateFor(harness).capabilityBadges.sessionId === "provision";
  if (provisioned && !sessionId) {
    // Fail closed: no thread, no launch. Every entry point that reaches here
    // without provisioning first gets the same refusal rather than a seat on
    // the wrong thread.
    return undefined;
  }
  // -r / --resume only when external harness state proves the id exists.
  // Canvas mint alone is not proof; unproven → pin/create (fail open).
  const resume =
    !provisioned &&
    Boolean(sessionId && input.resume) &&
    shouldResumeHarnessSession(true, {
      harness,
      sessionId: sessionId ?? "",
      ...(cwd ? { cwd } : {}),
    });
  const choices: ManagedLaunchChoices = {
    ...(profile ? { profile } : {}),
    ...(input.provider ?? recovered.provider
      ? { provider: input.provider ?? recovered.provider }
      : {}),
    ...(input.model ?? recovered.model ? { model: input.model ?? recovered.model } : {}),
    ...(input.effort ?? recovered.effort ? { effort: input.effort ?? recovered.effort } : {}),
    ...(input.mode ?? recovered.mode ? { mode: input.mode ?? recovered.mode } : {}),
    ...(input.permissionMode ?? recovered.permissionMode
      ? { permissionMode: input.permissionMode ?? recovered.permissionMode }
      : {}),
    // The operator's own arguments ride every spawn and resume of the seat.
    ...(recovered.extraArgs ? { extraArgs: recovered.extraArgs } : {}),
    // A provisioned harness has exactly one launch shape — `threads continue
    // <id>` — whether or not the thread has history, because the id IS the
    // seat's thread.
    ...(sessionId && (resume || provisioned)
      ? { resumeId: sessionId }
      : sessionId
        ? { sessionId }
        : {}),
    ...(cwd ? { cwd } : {}),
  };

  return resolveManagedLaunchPlan(harness, choices);
};

/** The re-planned launch, or the document launch when no plan resolves. */
export const launchForManagedSpawn = (
  input: SpawnPlanInput,
): {
  readonly launch: TerminalLaunch | undefined;
  readonly plan: ManagedLaunchPlan | undefined;
} => {
  let sessionId = sessionIdForSpawn(input);
  let resume = input.resume;

  // Isolated JUNTO_HOME (dev) shares harness homes with production. Never
  // resume a pin session that production may still own; mint a fresh pin so
  // the agent TUI actually comes up.
  const isolateShared = shouldAvoidSharedHarnessResume();
  if (isolateShared) {
    resume = false;
    const harnessRaw = input.harness?.trim();
    if (harnessRaw && isPinSessionHarness(harnessRaw)) {
      sessionId = randomUUID();
    }
  }

  const harnessId = input.harness?.trim();
  if (
    harnessId &&
    isHarnessId(harnessId) &&
    templateFor(harnessId).capabilityBadges.sessionId === "provision" &&
    !sessionId
  ) {
    // The document launch is no safer than the planned one here: its argv ends
    // at `threads continue` with no id. Refuse both.
    return { launch: undefined, plan: undefined };
  }

  const plan = planManagedSpawn({ ...input, sessionId, resume });
  if (!plan) {
    // Never fall through to a document launch that still carries -r / a
    // production session pin when we are isolating shared harness sessions.
    if (isolateShared) {
      return { launch: undefined, plan: undefined };
    }
    return { launch: input.documentLaunch, plan: undefined };
  }
  return { launch: plan.launch, plan };
};

const spawnInputForManagedIntent = (
  actor: { readonly harness: string; readonly agentKey: string },
  intent: ManagedSpawnIntent,
): SpawnPlanInput => ({
  harness: actor.harness,
  agentKey: actor.agentKey,
  documentLaunch: intent.documentLaunch,
  cwd: intent.cwd,
  sessionId: intent.sessionId,
  resume: intent.resumeRequested,
  profile: intent.profile,
  provider: intent.provider,
  model: intent.model,
  effort: intent.effort,
  mode: intent.mode,
  permissionMode: intent.permissionMode,
});

/** Finalize a pure intent on the process host that owns session evidence. */
export const launchForManagedSpawnIntent = (
  actor: { readonly harness: string; readonly agentKey: string },
  intent: ManagedSpawnIntent,
): ReturnType<typeof launchForManagedSpawn> =>
  launchForManagedSpawn(spawnInputForManagedIntent(actor, intent));

/** Re-plan a failed proven resume as a fresh pin. */
export const planFreshManagedSpawnIntent = (
  actor: { readonly harness: string; readonly agentKey: string },
  intent: ManagedSpawnIntent,
  sessionId: string,
): ManagedLaunchPlan | undefined =>
  planManagedSpawn({
    ...spawnInputForManagedIntent(actor, intent),
    sessionId,
    resume: false,
  });

export const harnessFromNode = (node: CanvasNode | undefined): string | undefined => {
  const h = node?.ether?.terminal?.harness?.trim();
  return h && h.length > 0 ? h : undefined;
};

/**
 * Fail-open after a dead resume: mint a fresh pin session id and rebuild argv
 * without `-r`/`--resume`. Caller owns any durable canvas write of the new id.
 */
export const planFreshPinSession = (input: {
  readonly harness: HarnessId;
  readonly documentLaunch?: TerminalLaunch;
  readonly agentKey?: string;
  readonly cwd?: string;
  readonly sessionId: string;
}): ManagedLaunchPlan => {
  const recovered = recoverDocumentLaunchChoices(input.harness, input.documentLaunch);
  const profile =
    recovered.profile ??
    (input.harness === "hermes" ? profileFromAgentKey(input.agentKey) : undefined);
  const cwd = input.cwd?.trim() || input.documentLaunch?.cwd?.trim() || undefined;
  return resolveManagedLaunchPlan(input.harness, {
    sessionId: input.sessionId,
    ...(profile ? { profile } : {}),
    ...(recovered.provider ? { provider: recovered.provider } : {}),
    ...(recovered.model ? { model: recovered.model } : {}),
    ...(recovered.effort ? { effort: recovered.effort } : {}),
    ...(recovered.permissionMode
      ? { permissionMode: recovered.permissionMode }
      : {}),
    ...(recovered.extraArgs ? { extraArgs: recovered.extraArgs } : {}),
    ...(cwd ? { cwd } : {}),
  });
};
