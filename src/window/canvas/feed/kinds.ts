/**
 * Kind and spine live facts: what each non-seat card reads from stores,
 * derived here with no card mounted (contract.ts `KindLive`/`SpineLive`).
 * The scene ops carry them on the card fact, so `paint/` reads no store.
 *
 * Every line, name, ledger and status word mirrors its card exactly:
 * TerminalCard, TasksCard, ArtifactsCard, AutomationsCard, PageCard,
 * FilesCard, GitCard, the link and file fallbacks, PeerCard and StubCard.
 * The status a kind seat's ring says is the one `nodeStatus$` publishes
 * (feed/nodes.ts), except files and git whose "off" is a per-card read —
 * the feed keeps those reads itself (a files count, a git IPC) and applies
 * `shownStatus` the same way the card's self-publish does.
 *
 * Async reads are retained per node and land in observables the sync pass
 * reads: artifact heads, files counts, git status. The git read needs the
 * window runtime; without one the card says "reading", as GitCard does.
 */
import { observable, observe, type Observable } from "@legendapp/state";
import { BROWSER_ENABLED, FILES_REMOTE_ENABLED, TASKS_ENABLED } from "@shared/features";
import type { GitStatus } from "@shared/git";
import type { FilesCount, FilesResult } from "@shared/files";
import { formatNodeRef } from "@shared/node-ref";
import type { NodeId } from "@shared/physics/schema";
import type { ArtifactHead } from "@shared/resource-ipc";
import { titleOf } from "@shared/model/title";
import { automationsCardFacts } from "../../lib/automations-card";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { artifactsSource } from "../../lib/artifacts-source";
import { browser$ } from "../../lib/browser-state";
import { dock$ } from "../../lib/dock-state";
import { countLine } from "../../lib/files-card";
import { filesSource, offlineOf, unreachableLine } from "../../lib/files-source";
import { kindStateOf } from "../../lib/kind-band";
import { machineLabel, machineLabelIn, onThisMachine, requestMachineCheck } from "../../lib/machines";
import { kindMayBeBlocked } from "../../lib/model-kind";
import { hostAndTail, hostOf, pathTail } from "../../lib/presentation";
import { imageContentRefFromFile } from "../../lib/image-content";
import { modelStore } from "../../lib/use-model";
import { nodeStatus$, nodeStatusWord, shownStatus, type NodeStatus } from "../../lib/node-status";
import { pageDriving$ } from "../../lib/page-driving";
import { seatCardStatus } from "../../lib/seat-card-status";
import { canvasTasks$, seatTasks$ } from "../../lib/seat-tasks";
import { state$ } from "../../lib/state";
import { terminal$ } from "../../lib/terminal-state";
import { healthClockNow } from "../../lib/thread-health";
import { tasksCardBody } from "../../components/tasks/tasks-pane-model";
import { GitWindow } from "../../../contract/window/git";
import type { WindowRuntime } from "../../rpc/runtime";
import { retainAutomationFacts } from "./automations";
import { blockedNodeIds } from "./shared";
import type { KindLive, SpineLive } from "../contract";

/** A card's live facts: its kind seat's or its spine card's, never both. */
export type CardLiveFact = { readonly kind?: KindLive; readonly spine?: SpineLive };

// --- the live-facts store ----------------------------------------------------

const lives = new Map<string, Observable<Record<string, CardLiveFact>>>();

/**
 * The canvas's kind/spine live facts by node id, written only by
 * `retainKindLive`. The scene ops read it per card; nothing else writes.
 */
export const cardLive$ = (canvasName: string): Observable<Record<string, CardLiveFact>> => {
  let live = lives.get(canvasName);
  if (live === undefined) {
    live = observable<Record<string, CardLiveFact>>({});
    lives.set(canvasName, live);
  }
  return live;
};

const sameKindLive = (a: KindLive | undefined, b: KindLive | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.name === b.name &&
    a.line === b.line &&
    a.lineTitle === b.lineTitle &&
    a.state === b.state &&
    a.unbound === b.unbound &&
    a.enqueue === b.enqueue &&
    a.dropTarget === b.dropTarget &&
    a.stateSince === b.stateSince &&
    a.tasks?.state === b.tasks?.state &&
    a.tasks?.label === b.tasks?.label &&
    a.tasks?.title === b.tasks?.title &&
    a.tasks?.more === b.tasks?.more &&
    JSON.stringify(a.ledger) === JSON.stringify(b.ledger));

const sameSpineLive = (a: SpineLive | undefined, b: SpineLive | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.status === b.status &&
    a.name === b.name &&
    a.count === b.count &&
    a.tag === b.tag &&
    a.leaf === b.leaf &&
    a.leafTail === b.leafTail &&
    a.glyph === b.glyph &&
    a.hue === b.hue &&
    a.dashed === b.dashed &&
    a.meta === b.meta &&
    a.more === b.more &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, index) => row === b.rows[index]));

/** Structural equality for a card's kind/spine pair, for the scene's card-op diff. */
export const sameCardLive = (
  a: { readonly kind?: KindLive; readonly spine?: SpineLive } | undefined,
  b: { readonly kind?: KindLive; readonly spine?: SpineLive },
): boolean => a !== undefined && sameKindLive(a.kind, b.kind) && sameSpineLive(a.spine, b.spine);

// --- per-node async reads -----------------------------------------------------

type GitRead = { readonly status?: GitStatus; readonly error?: string };
type ReaderKind = "artifacts" | "files" | "git";

type Reader = {
  readonly kind: ReaderKind;
  readonly key: string;
  seq: number;
  fire: () => void;
};

/** Stub copy look, as RemoteNodeCards' STUB_LOOK names the glyph atlas. */
const STUB_LOOK: { readonly [K in "file" | "link" | "git" | "page" | "files"]: { readonly glyph: string; readonly hue: string } } = {
  file: { glyph: "FileText", hue: "dim" },
  link: { glyph: "Link2", hue: "cyan" },
  git: { glyph: "GitBranch", hue: "orange" },
  page: { glyph: "Globe", hue: "indigo" },
  files: { glyph: "FolderTree", hue: "dim" },
};

/** `nameOf` only names automation rows, which the card fact never carries. */
const NO_NAME = (): string => "";

/**
 * Kind and spine live facts for one open canvas. `runtime` is the window's
 * Effect runtime (RegionUrgencyGate passes the context's); without it git
 * cards read "reading", exactly as GitCard does with no git window.
 */
export const retainKindLive = (canvasName: string, runtime?: WindowRuntime): (() => void) => {
  if (canvasName === "") return () => undefined;
  const live = cardLive$(canvasName);
  const automations = retainAutomationFacts(canvasName);

  const artifactHeads$ = observable<Record<string, ReadonlyArray<ArtifactHead> | undefined>>({});
  const filesCounts$ = observable<Record<string, FilesResult<FilesCount> | undefined>>({});
  const gitStates$ = observable<Record<string, GitRead | undefined>>({});
  const git = runtime === undefined ? undefined : runtime.runSync(GitWindow);

  const stops: Array<() => void> = [];
  const readers = new Map<string, Reader>();
  const machineChecks = new Set<string>();
  const stateSince = new Map<string, { readonly state: KindLive["state"]; readonly since: number }>();

  /**
   * One async read per node, keyed by its spec: a changed spec (a new root,
   * cwd, reach) restarts it; a refresh (a source change event) bumps the
   * seq so the older answer lands nowhere. A dropped reader's in-flight
   * answer fails its `current` check.
   */
  const begin = (id: string, kind: ReaderKind, key: string, fire: (current: () => boolean) => void): void => {
    const held = readers.get(id);
    if (held !== undefined && held.kind === kind && held.key === key) return;
    const entry: Reader = { kind, key, seq: 0, fire: () => undefined };
    entry.fire = () => {
      entry.seq += 1;
      const seq = entry.seq;
      fire(() => readers.get(id) === entry && entry.seq === seq);
    };
    readers.set(id, entry);
    entry.fire();
  };
  const refresh = (id: string): void => readers.get(id)?.fire();

  const previous = new Map<string, CardLiveFact>();

  stops.push(
    observe(() => {
      const model = modelStore.canvas$(canvasName);
      const ids = model.nodeIds.get();
      agentSeat$.rev.get();
      const blocked = blockedNodeIds(canvasName);
      const tasksByNode = canvasTasks$.byNode.get();
      const sessions = terminal$.sessionByBindingId.get();
      const machines = state$.machines.get();
      const machineFacts = state$.machineFacts.get();
      const thisMachine = state$.settings.machine.name.get();
      const automationReads = automations.facts.get();
      const heads = artifactHeads$.get();
      const filesCounts = filesCounts$.get();
      const gitStates = gitStates$.get();
      const browserSessions = browser$.sessionByRef.get();
      const opErrors = dock$.opErrorByRef.get();
      const workingByRef = pageDriving$.workingByRef.get();

      const wanted = new Set<string>();
      const next = new Map<string, CardLiveFact>();

      for (const id of ids) {
        const row = model.nodes[id].get();
        if (row === undefined) continue;
        const status = nodeStatus$[id].get();
        const shellBlocked = blocked.has(id) && kindMayBeBlocked(row.kind);
        let kind: KindLive | undefined;
        let spine: SpineLive | undefined;

        switch (row.kind) {
          case "terminal": {
            const bindingId = row.bindingId as string | undefined;
            const hostId = row.host as string | undefined;
            const native = bindingId !== undefined && hostId !== undefined;
            const seatEvent = bindingId === undefined ? undefined : agentSeat$.byBindingId[bindingId].peek();
            const needsLook = bindingId !== undefined && agentSeat$.needsLookByBindingId[bindingId].peek() === true;
            const session = bindingId === undefined ? undefined : sessions[bindingId];
            const card = seatCardStatus({
              face: bindingId === undefined ? undefined : { id, name: row.label ?? "", bindingId, launch: row.launch },
              seatEvent,
              needsLook,
              session,
              graphBlocked: blocked.has(id),
            });
            if (card === undefined || !native) {
              kind = { name: (row.label ?? "") || "terminal", line: "unbound terminal", state: kindStateOf(status, false), unbound: true };
              break;
            }
            const line =
              card.seatState === "attention" && seatEvent?.reason
                ? seatEvent.reason
                : onThisMachine(hostId)
                  ? card.subtitle
                  : `${card.subtitle} on ${machineLabelIn(machines, hostId)}`;
            const held = seatTasks$.bySeat[id].get();
            kind = {
              name: card.label,
              line,
              state: kindStateOf(status, false),
              ...(TASKS_ENABLED && held !== undefined
                ? { tasks: { state: held.state, label: held.label, title: held.title, more: Math.max(0, held.tasks.length - 1) } }
                : {}),
            };
            break;
          }
          case "task": {
            const body = tasksCardBody(tasksByNode[id] ?? []);
            const done = body.count > 0 && body.ledger.finished === body.count;
            kind = {
              name: titleOf(row),
              line: body.meta,
              state: kindStateOf(status, done),
              ledger: { kind: "task", ...body.ledger },
              ...(TASKS_ENABLED ? { enqueue: true } : {}),
            };
            break;
          }
          case "artifacts": {
            wanted.add(id);
            begin(id, "artifacts", "a", (current) => {
              void artifactsSource()
                .list(canvasName, id as NodeId)
                .then((list) => {
                  if (current()) artifactHeads$[id].set(list);
                })
                .catch(() => {
                  if (current()) artifactHeads$[id].delete();
                });
            });
            const items = (heads[id] ?? []).filter((entry) => !entry.artifact.archived);
            kind = {
              name: titleOf(row),
              line: items.length === 1 ? "1 artifact" : `${items.length} artifacts`,
              state: kindStateOf(status, false),
              ledger: { kind: "artifacts", count: items.length },
            };
            break;
          }
          case "automations": {
            const read = automationReads[id];
            const facts = automationsCardFacts(read?.automations ?? [], read?.lastOutcomes ?? {}, NO_NAME);
            kind = {
              name: titleOf(row),
              line: facts.meta,
              state: kindStateOf(status, false),
              ledger: { kind: "automations", ...facts.ledger },
            };
            break;
          }
          case "page": {
            if (!BROWSER_ENABLED) {
              const host = hostOf(row.url) || "retired link";
              kind = { name: host, line: hostAndTail(row.url) || host, state: kindStateOf(shownStatus(undefined, shellBlocked), false) };
              break;
            }
            let pageRef: string | undefined;
            try {
              pageRef = formatNodeRef({ canvasName, nodeId: id as NodeId });
            } catch {
              pageRef = undefined;
            }
            if (pageRef === undefined) {
              kind = { name: hostOf(row.url), line: "page unbound", state: kindStateOf(status, false), unbound: true };
              break;
            }
            const session = browserSessions[pageRef];
            const opError = opErrors[pageRef];
            const working = workingByRef[pageRef] ?? false;
            const err = opError?.message ?? (session?.state === "failed" ? session.lastError : undefined);
            kind = {
              name: hostOf(row.url),
              line: err ?? `browser page, ${row.profile}`,
              state: kindStateOf(status, false),
            };
            break;
          }
          case "link": {
            const host = hostOf(row.url) || "retired link";
            kind = { name: host, line: hostAndTail(row.url) || host, state: kindStateOf(status, false) };
            break;
          }
          case "file": {
            // An image file draws its picture, not a kind seat: no fact.
            if (imageContentRefFromFile(row.path) !== undefined) break;
            const base = row.path.split("/").filter(Boolean).pop() ?? (row.path || "retired file");
            kind = { name: base, line: pathTail(row.path), lineTitle: row.path, state: kindStateOf(status, false) };
            break;
          }
          case "files": {
            const here = onThisMachine(row.host);
            const remote = FILES_REMOTE_ENABLED && !here;
            const reach = remote && row.host !== undefined ? machineFacts[row.host]?.reachable : undefined;
            if (here || remote) {
              wanted.add(id);
              const key = `f|${row.root}|${here ? 1 : 0}|${remote ? 1 : 0}|${reach === true ? 1 : reach === false ? 0 : ""}`;
              begin(id, "files", key, (current) => {
                void filesSource()
                  .count({ canvas: canvasName, node: id as NodeId })
                  .then((result) => {
                    if (current()) filesCounts$[id].set(result);
                  })
                  .catch(() => {
                    if (current()) filesCounts$[id].delete();
                  });
              });
              if (remote && row.host !== undefined) {
                const checkKey = `${id}\n${row.host}`;
                if (!machineChecks.has(checkKey)) {
                  machineChecks.add(checkKey);
                  requestMachineCheck(row.host);
                }
              }
            }
            const counted = filesCounts[id];
            const offline = counted === undefined || counted.ok ? undefined : offlineOf(counted);
            const now = offline !== undefined ? healthClockNow() : 0;
            const line =
              offline !== undefined
                ? unreachableLine(machineLabel(offline.machine), offline.lastReachedAt, now)
                : (countLine(counted) ?? row.root);
            const shown = shownStatus(offline !== undefined ? "off" : undefined, shellBlocked);
            kind = { name: titleOf(row), line, lineTitle: row.root, state: kindStateOf(shown, false) };
            break;
          }
          case "git": {
            const cwd = row.cwd?.trim() ?? "";
            if (cwd !== "" && git !== undefined) {
              wanted.add(id);
              begin(id, "git", `g|${cwd}`, (current) => {
                void runtime!
                  .runPromise(git.GitStatus({ cwd }))
                  .then((result) => {
                    if (!current()) return;
                    gitStates$[id].set(result.ok ? { status: result.status } : { error: result.error });
                  })
                  .catch(() => {
                    if (current()) gitStates$[id].set({ error: "git unavailable" });
                  });
              });
            }
            const read: GitRead | undefined = cwd === "" ? { error: "no folder" } : gitStates[id];
            const gitStatus = read?.status;
            const error = read?.error;
            const ahead = gitStatus?.ahead ?? 0;
            const behind = gitStatus?.behind ?? 0;
            const head = gitStatus?.head;
            const sync = [ahead > 0 ? `↑${String(ahead)}` : "", behind > 0 ? `↓${String(behind)}` : ""]
              .filter(Boolean)
              .join(" ");
            const line =
              error !== undefined && error !== "" && gitStatus === undefined
                ? error
                : [
                    gitStatus?.branch ?? "reading",
                    sync,
                    head ? `${head.sha.slice(0, 7)} ${head.subject}` : gitStatus !== undefined ? "no commits" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
            const shown = shownStatus(error !== undefined && error !== "" && gitStatus === undefined ? "off" : undefined, shellBlocked);
            const firstLine = (row.label ?? "").split("\n")[0] ?? "";
            kind = { name: firstLine || "git", line, lineTitle: line, state: kindStateOf(shown, false) };
            break;
          }
          case "peer": {
            const machine = machineLabelIn(machines, row.host);
            spine = {
              status: status ?? "none",
              name: titleOf(row),
              ...(status === undefined ? {} : { tag: nodeStatusWord(status) }),
              leaf: `seat on ${machine}`,
              glyph: "peer",
              hue: "dim",
              dashed: true,
              rows: [],
            };
            break;
          }
          case "stub": {
            const look = STUB_LOOK[row.of];
            const where = row.host === undefined ? undefined : machineLabelIn(machines, row.host);
            spine = {
              status: status ?? "none",
              name: titleOf(row),
              ...(status === undefined ? {} : { tag: nodeStatusWord(status) }),
              leaf: where === undefined ? `${row.of} copy` : `${row.of} on ${where}`,
              glyph: look.glyph,
              hue: look.hue,
              dashed: true,
              rows: [],
            };
            break;
          }
          default:
            break;
        }

        if (kind !== undefined) {
          const held = stateSince.get(id);
          const since = held !== undefined && held.state === kind.state ? held.since : Date.now();
          stateSince.set(id, { state: kind.state, since });
          kind = { ...kind, stateSince: since };
        }
        if (kind !== undefined || spine !== undefined) next.set(id, { ...(kind === undefined ? {} : { kind }), ...(spine === undefined ? {} : { spine }) });
      }

      // Readers a node no longer wants stop; their last answer is dropped.
      for (const id of [...readers.keys()]) {
        if (wanted.has(id)) continue;
        const reader = readers.get(id);
        readers.delete(id);
        if (reader?.kind === "artifacts") artifactHeads$[id].delete();
        else if (reader?.kind === "files") filesCounts$[id].delete();
        else if (reader?.kind === "git") gitStates$[id].delete();
      }
      for (const id of [...stateSince.keys()]) {
        const fact = next.get(id);
        if (fact?.kind === undefined) stateSince.delete(id);
      }

      // Diff-write: a fact that did not change writes nothing.
      for (const id of [...previous.keys()]) {
        if (!next.has(id)) {
          previous.delete(id);
          live[id].delete();
        }
      }
      for (const [id, fact] of next) {
        const was = previous.get(id);
        if (was === undefined || !sameCardLive(was, fact)) live[id].set(fact);
        previous.set(id, fact);
      }
    }),
  );

  // Artifact and files sources push their own changes: re-ask the readers
  // they name, the way each card's effect does.
  stops.push(
    artifactsSource().onChanged((notice) => {
      if (notice.canvasName !== canvasName) return;
      for (const [id, reader] of readers) {
        if (reader.kind === "artifacts" && (notice.nodeIds === undefined || notice.nodeIds.includes(id))) refresh(id);
      }
    }),
  );
  stops.push(
    filesSource().onChange((event) => {
      if (event.kind !== "paths" && event.kind !== "reset") return;
      const reader = readers.get(event.node);
      if (reader?.kind === "files") refresh(event.node);
    }),
  );

  return () => {
    for (const stop of stops.reverse()) stop();
    readers.clear();
    machineChecks.clear();
    stateSince.clear();
    previous.clear();
    automations.release();
    live.set({});
  };
};
