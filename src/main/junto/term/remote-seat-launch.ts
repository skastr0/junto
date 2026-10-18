/**
 * What a remote seat's next start and next turn do, as its own machine last
 * said: on each state it forwards while the seat runs, and on Get's Vacant
 * when it has no occupant (seats-launch.ts), with the seat's cache window as
 * that machine's offboard clock reads it. Advisory: the card and the seat's
 * offboard row show it, nothing here cuts on it, and nothing sends it back.
 *
 * Dropped when the link to that machine closes, when the seat's occupant
 * changes (a new epoch, or its exit), and when the seat no longer runs on
 * that machine, so a retired or unpinned peer's last answer never stays on a
 * card. The seat's machine is asked (Get) only for a seat with no live state
 * here, at most once per link and per state the seat reports: never on a
 * timer.
 */
import type { RemoteSeatLaunch } from "./seats-launch";

type Held = { readonly machine: string; readonly epoch: string | undefined; readonly launch: RemoteSeatLaunch };

const held = new Map<string, Held>();
/** Per machine: seats asked since the link opened and since their last state. */
const asked = new Map<string, Set<string>>();

/**
 * A state arrived from the seat's machine for that occupant, with the launch
 * state it carried, if any. An exit drops what was held: the seat's machine
 * answers again for a seat with no occupant.
 */
export const rememberRemoteSeatLaunch = (input: {
  readonly bindingId: string;
  readonly machine: string;
  readonly epoch: string;
  readonly gone: boolean;
  readonly launch?: RemoteSeatLaunch;
}): void => {
  asked.get(input.machine)?.delete(input.bindingId);
  const prior = held.get(input.bindingId);
  if (input.gone) held.delete(input.bindingId);
  else if (input.launch !== undefined) held.set(input.bindingId, { machine: input.machine, epoch: input.epoch, launch: input.launch });
  else if (prior !== undefined && (prior.machine !== input.machine || prior.epoch !== input.epoch)) held.delete(input.bindingId);
};

/**
 * A link to that machine opened. A seat asked while there was no link (a
 * window's cards ask before its links are up) has not been asked on this one.
 */
export const openedRemoteSeatLaunches = (machine: string): void => {
  asked.delete(machine);
};

/** The link to that machine closed: everything it said goes. */
export const forgetRemoteSeatLaunches = (machine: string): void => {
  for (const [bindingId, entry] of held) if (entry.machine === machine) held.delete(bindingId);
  asked.delete(machine);
};

/**
 * What the seat's machine last said, read at `now`. Past `freshAt` the next
 * turn starts fresh: only activity keeps a session warm, and activity
 * arrives as a new state. Undefined, and dropped, when the seat now runs
 * elsewhere.
 */
export const heldRemoteSeatLaunch = (bindingId: string, machine: string, now: number): RemoteSeatLaunch | undefined => {
  const entry = held.get(bindingId);
  if (entry === undefined) return undefined;
  if (entry.machine !== machine) {
    held.delete(bindingId);
    return undefined;
  }
  const turn = entry.launch.nextTurn;
  if (turn === undefined || turn.fresh || turn.freshAt === undefined || now < turn.freshAt) return entry.launch;
  return { ...entry.launch, nextTurn: { fresh: true } };
};

/**
 * The launch state of a seat that runs on `machine`, for the card. `live`:
 * the seat has an occupant there, as far as its states say; its states then
 * carry the answer and nothing is asked. Otherwise `ask` sends Get once.
 */
export const remoteSeatLaunch = async (input: {
  readonly bindingId: string;
  readonly machine: string;
  readonly live: boolean;
  readonly ask: () => Promise<RemoteSeatLaunch | undefined>;
  readonly now?: () => number;
}): Promise<RemoteSeatLaunch | undefined> => {
  const now = input.now ?? Date.now;
  const known = heldRemoteSeatLaunch(input.bindingId, input.machine, now());
  if (known !== undefined || input.live) return known;
  const seats = asked.get(input.machine) ?? new Set<string>();
  if (seats.has(input.bindingId)) return undefined;
  seats.add(input.bindingId);
  asked.set(input.machine, seats);
  const launch = await input.ask().catch(() => undefined);
  // A state that arrived meanwhile, or a closed link, says more than this answer.
  if (launch !== undefined && seats.has(input.bindingId) && asked.get(input.machine) === seats)
    held.set(input.bindingId, { machine: input.machine, epoch: undefined, launch });
  return heldRemoteSeatLaunch(input.bindingId, input.machine, now());
};

export const resetRemoteSeatLaunches = (): void => {
  held.clear();
  asked.clear();
};
