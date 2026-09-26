/**
 * Renderer mirror of the operator's squads plus the squad actions: save from
 * the selection, rename, delete, and place on the canvas. Main owns the
 * `squads` table; every change comes back as the full list.
 */
import { batch, observable } from "@legendapp/state";
import { ulid } from "ulid";
import type { Squad } from "@shared/squads";
import type { TerminalManagedPromptResult } from "@shared/ipc";
import { getJuntoApi } from "./junto-api";
import { commitDoc, flushPendingCanvasSave } from "./mutations";
import { captureSquad, placeSquad, squadBounds } from "./squads";
import { saveSquadPortraits, squadPortraitOf } from "./squad-portraits";
import { playCue } from "./sound";
import { selectNodes, state$ } from "./state";

export const squads$ = observable({
  list: [] as ReadonlyArray<Squad>,
  hydrated: false,
});

/**
 * The save-as-squad dialog, when open: the seats it saves and the squad it
 * replaces, if the operator chose one.
 */
export const squadDialog$ = observable<{
  readonly selectedIds: ReadonlyArray<string>;
  readonly squadId?: string;
} | null>(null);

export const openSaveSquad = (selectedIds: ReadonlyArray<string>, squadId?: string): void => {
  squadDialog$.set({ selectedIds: [...selectedIds], ...(squadId ? { squadId } : {}) });
};

export const closeSaveSquad = (): void => {
  squadDialog$.set(null);
};

let started = false;

/** Idempotent: hydrate once and follow every change main pushes. */
export const ensureSquads = (): void => {
  if (started) return;
  const api = getJuntoApi();
  if (!api?.squadsList) return;
  started = true;
  api.onSquadsChanged?.((event) => squads$.assign({ list: event.squads, hydrated: true }));
  void api
    .squadsList()
    .then((list) => squads$.assign({ list, hydrated: true }))
    .catch(() => {
      started = false;
    });
};

const adopt = (squad: Squad): void => {
  const others = squads$.list.peek().filter((entry) => entry.squadId !== squad.squadId);
  squads$.list.set(
    [...others, squad].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  );
};

export type SaveSquadInput = {
  readonly name: string;
  readonly selectedIds: ReadonlyArray<string>;
  /** Replace this squad instead of creating one. */
  readonly squadId?: string;
  readonly prompt?: string;
  readonly seatPrompts?: Readonly<Record<string, string>>;
};

/** Save the selection as a squad. Resolves "" on success, else the reason. */
export const saveSquadFromSelection = async (input: SaveSquadInput): Promise<string> => {
  const api = getJuntoApi();
  if (!api?.squadSave) return "squads are unavailable";
  const body = captureSquad(state$.doc.peek(), input.selectedIds, {
    portraitOf: squadPortraitOf,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.seatPrompts ? { seatPrompts: input.seatPrompts } : {}),
  });
  if (!body) return "select at least one agent seat";
  const result = await api.squadSave({
    ...(input.squadId ? { squadId: input.squadId } : {}),
    name: input.name,
    body,
  });
  if (!result.ok) return result.message;
  adopt(result.squad);
  return "";
};

export const renameSquad = async (squadId: string, name: string): Promise<string> => {
  const api = getJuntoApi();
  if (!api?.squadRename) return "squads are unavailable";
  const result = await api.squadRename(squadId, name);
  if (!result.ok) return result.message;
  adopt(result.squad);
  return "";
};

export const deleteSquad = async (squadId: string): Promise<string> => {
  const api = getJuntoApi();
  if (!api?.squadDelete) return "squads are unavailable";
  const result = await api.squadDelete(squadId);
  if (!result.ok) return result.message;
  squads$.list.set(squads$.list.peek().filter((squad) => squad.squadId !== squadId));
  return "";
};

/**
 * Place a squad at a canvas point: fresh seats and connections in one
 * undoable write, portraits copied, then each opening prompt sent as mail.
 * Mail starts a down seat only on a playing canvas (the kernel's pause law)
 * and waits for its terminal; on a paused canvas it waits for play.
 */
export const placeSquadAt = async (
  squadId: string,
  at: { readonly x: number; readonly y: number },
): Promise<void> => {
  const squad = squads$.list.peek().find((entry) => entry.squadId === squadId);
  if (!squad) return;
  const doc = state$.doc.peek();
  const placed = placeSquad(squad, at, doc, {
    nodeId: () => `agent-${ulid()}`,
    bindingId: () => ulid(),
    edgeId: () => `edge-${ulid()}`,
    sessionId: () => crypto.randomUUID(),
  });
  if (placed.nodes.length === 0) {
    state$.error.set(`${squad.name}: no seat this build can place`);
    return;
  }
  const ids = placed.nodes.map((node) => node.id);
  batch(() => {
    state$.edgeFilter.set("");
    selectNodes(ids);
  });
  commitDoc({ ...doc, nodes: [...doc.nodes, ...placed.nodes], edges: [...doc.edges, ...placed.edges] });
  state$.focusNodeIds.set(ids);
  playCue("squad", { count: ids.length });

  const problems: string[] = [];
  if (placed.skipped.length > 0) problems.push(`skipped ${placed.skipped.join(", ")}`);
  if (!(await saveSquadPortraits(placed.portraits))) problems.push("portraits not copied");
  if (placed.prompts.length > 0) {
    const api = getJuntoApi();
    const canvasName = state$.canvasName.peek();
    // Main reads the seat from the saved canvas, so the write lands first.
    await flushPendingCanvasSave();
    const writePrompt = api?.terminalManagedPrompt;
    if (writePrompt && canvasName) {
      const results = await Promise.all(
        placed.prompts.map((prompt) =>
          writePrompt({ bindingId: prompt.bindingId, text: prompt.text, canvasName, nodeId: prompt.nodeId })
            .catch((): TerminalManagedPromptResult => ({ ok: false, disposition: "failed" })),
        ),
      );
      const failed = results.filter((result) => !result.ok && result.disposition !== "queued").length;
      if (failed > 0) problems.push(`${failed} opening prompt${failed === 1 ? "" : "s"} not sent`);
    } else {
      problems.push("opening prompts not sent");
    }
  }
  if (problems.length > 0) state$.error.set(`${squad.name}: ${problems.join(", ")}`);
};

/**
 * Place a squad where the add flow would put a node of the squad's size: the
 * right-click point, or the next open slot from the field's add button.
 */
export const placeSquadInSlot = (
  squadId: string,
  positionFor: (size: { width: number; height: number }) => { x: number; y: number },
): Promise<void> => {
  const squad = squads$.list.peek().find((entry) => entry.squadId === squadId);
  if (!squad) return Promise.resolve();
  const size = squadBounds(squad);
  const corner = positionFor({ width: size.width, height: size.height });
  return placeSquadAt(squadId, { x: corner.x + size.width / 2, y: corner.y + size.height / 2 });
};
