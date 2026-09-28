/**
 * Renderer mirror of the operator's squads plus the squad actions: save from
 * the selection, rename, delete, and place on the canvas. Main owns the
 * `squads` table; every change comes back as the full list.
 */
import { batch, observable } from "@legendapp/state";
import { ulid } from "ulid";
import type { Squad } from "@shared/squads";
import { raiseSquadFailure } from "./desktop-notify";
import { getJuntoApi } from "./junto-api";
import { commitDoc } from "./mutations";
import { captureSquad, placeSquad, squadBounds, type SquadLaunch } from "./squads";
import { saveSeatGuidances, saveSquadPortraits, squadPortraitOf } from "./squad-portraits";
import { seatGuidanceOf, startSeatGuidance } from "./seat-guidance-state";
import { playCue } from "./sound";
import { selectNodes, state$ } from "./state";

export const squads$ = observable({
  list: [] as ReadonlyArray<Squad>,
  hydrated: false,
});

/** The save-as-squad dialog, when open: the seats it saves as a new squad. */
export const squadDialog$ = observable<{ readonly selectedIds: ReadonlyArray<string> } | null>(null);

export const openSaveSquad = (selectedIds: ReadonlyArray<string>): void => {
  squadDialog$.set({ selectedIds: [...selectedIds] });
};

export const closeSaveSquad = (): void => {
  squadDialog$.set(null);
};

let started = false;

/** Idempotent: hydrate once and follow every change main pushes. */
export const ensureSquads = (): void => {
  // Capturing seats reads their soul and instructions from this store.
  startSeatGuidance();
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

/**
 * Save the selection as a new squad. Resolves "" on success, else the reason
 * (a taken name among them: a save never replaces another squad).
 */
export const saveSquadFromSelection = async (
  name: string,
  selectedIds: ReadonlyArray<string>,
): Promise<string> => {
  const api = getJuntoApi();
  if (!api?.squadSave) return "squads are unavailable";
  const body = captureSquad(state$.doc.peek(), selectedIds, {
    portraitOf: squadPortraitOf,
    guidanceOf: seatGuidanceOf,
  });
  if (!body) return "select at least one agent seat";
  const result = await api.squadSave({ name, body });
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

/** How a placement went: placed, or it needs a folder chosen first. */
export type PlaceOutcome = "placed" | "needs-folder" | "failed";

/**
 * Place a squad at a canvas point: fresh seats and connections in one
 * undoable write, then portraits, souls, and instructions copied.
 */
export const placeSquadAt = async (
  squadId: string,
  at: { readonly x: number; readonly y: number },
  launch: SquadLaunch,
): Promise<PlaceOutcome> => {
  const squad = squads$.list.peek().find((entry) => entry.squadId === squadId);
  if (!squad) return "failed";
  const doc = state$.doc.peek();
  const placed = placeSquad(squad, at, doc, { edgeId: () => `edge-${ulid()}` }, launch);
  if (placed.needsFolder) return "needs-folder";
  if (placed.nodes.length === 0) {
    state$.error.set(`${squad.name}: no seat this build can place`);
    return "failed";
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
  if (!(await saveSeatGuidances(placed.guidance))) problems.push("souls and instructions not copied");
  if (problems.length > 0) {
    state$.error.set(`${squad.name}: ${problems.join(", ")}`);
    const canvasName = state$.canvasName.peek();
    if (canvasName) {
      raiseSquadFailure({ canvasName, nodeId: ids[0]!, squadName: squad.name, text: problems.join(", ") });
    }
  }
  return "placed";
};

/**
 * Place a squad where the add flow would put a node of the squad's size: the
 * right-click point, or the next open slot from the field's add button.
 */
export const placeSquadInSlot = (
  squadId: string,
  positionFor: (size: { width: number; height: number }) => { x: number; y: number },
  launch: SquadLaunch,
): Promise<PlaceOutcome> => {
  const squad = squads$.list.peek().find((entry) => entry.squadId === squadId);
  if (!squad) return Promise.resolve("failed");
  const size = squadBounds(squad);
  const corner = positionFor({ width: size.width, height: size.height });
  return placeSquadAt(squadId, { x: corner.x + size.width / 2, y: corner.y + size.height / 2 }, launch);
};
