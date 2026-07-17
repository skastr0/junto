import { isValidProfileId } from "@shared/browser";

export type BrowserProfileDisposition = "open" | "quiescing" | "deleted";

export interface BrowserProfileSnapshot {
  readonly profile: string;
  readonly epoch: bigint;
}

const browserProfileBlockBrand: unique symbol = Symbol("BrowserProfileBlock");

/** Main-process-only capability to complete or cancel one profile transition. */
export interface BrowserProfileBlock extends BrowserProfileSnapshot {
  readonly [browserProfileBlockBrand]: true;
}

export type BrowserProfileGateErrorCode = "invalid" | "busy" | "deleted";

export type BrowserProfileGateResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: BrowserProfileGateErrorCode };

interface ProfileState {
  readonly profile: string;
  epoch: bigint;
  disposition: BrowserProfileDisposition;
}

/**
 * Monotonic, main-process-only admission gate for persistent browser profiles.
 * Epochs never roll back: an open captured before a block cannot become current
 * again after cancellation or recreation under the same profile id.
 */
export class BrowserProfileGate {
  readonly #states = new Map<string, ProfileState>();
  readonly #blocks = new WeakMap<BrowserProfileBlock, ProfileState>();

  snapshot(profile: string): BrowserProfileSnapshot | undefined {
    if (!isValidProfileId(profile)) return undefined;
    const state = this.#state(profile);
    return state.disposition === "open"
      ? Object.freeze({ profile, epoch: state.epoch })
      : undefined;
  }

  isCurrent(snapshot: BrowserProfileSnapshot): boolean {
    if (!isValidProfileId(snapshot.profile) || typeof snapshot.epoch !== "bigint") return false;
    const state = this.#states.get(snapshot.profile);
    return state === undefined
      ? snapshot.epoch === 0n
      : state.disposition === "open" && state.epoch === snapshot.epoch;
  }

  disposition(profile: string): BrowserProfileDisposition | undefined {
    if (!isValidProfileId(profile)) return undefined;
    return this.#states.get(profile)?.disposition ?? "open";
  }

  begin(profile: string): BrowserProfileGateResult<BrowserProfileBlock> {
    if (!isValidProfileId(profile)) return Object.freeze({ ok: false, code: "invalid" });
    const state = this.#state(profile);
    if (state.disposition === "quiescing") {
      return Object.freeze({ ok: false, code: "busy" });
    }
    if (state.disposition === "deleted") {
      return Object.freeze({ ok: false, code: "deleted" });
    }

    state.epoch += 1n;
    state.disposition = "quiescing";
    const block = Object.freeze<BrowserProfileBlock>({
      profile,
      epoch: state.epoch,
      [browserProfileBlockBrand]: true,
    });
    this.#blocks.set(block, state);
    return Object.freeze({ ok: true, data: block });
  }

  commitDeleted(block: BrowserProfileBlock): boolean {
    const state = this.#activeState(block);
    if (state === undefined) return false;
    state.disposition = "deleted";
    this.#blocks.delete(block);
    return true;
  }

  cancelBeforeMutation(block: BrowserProfileBlock): boolean {
    const state = this.#activeState(block);
    if (state === undefined) return false;
    state.disposition = "open";
    this.#blocks.delete(block);
    return true;
  }

  markCreated(profile: string): BrowserProfileGateResult<BrowserProfileSnapshot> {
    if (!isValidProfileId(profile)) return Object.freeze({ ok: false, code: "invalid" });
    const state = this.#state(profile);
    if (state.disposition === "quiescing") {
      return Object.freeze({ ok: false, code: "busy" });
    }
    state.epoch += 1n;
    state.disposition = "open";
    return Object.freeze({
      ok: true,
      data: Object.freeze({ profile, epoch: state.epoch }),
    });
  }

  #state(profile: string): ProfileState {
    const existing = this.#states.get(profile);
    if (existing !== undefined) return existing;
    const created: ProfileState = { profile, epoch: 0n, disposition: "open" };
    this.#states.set(profile, created);
    return created;
  }

  #activeState(block: BrowserProfileBlock): ProfileState | undefined {
    const state = this.#blocks.get(block);
    return state !== undefined &&
      state.profile === block.profile &&
      state.epoch === block.epoch &&
      state.disposition === "quiescing"
      ? state
      : undefined;
  }
}

export const makeBrowserProfileGate = (): BrowserProfileGate => new BrowserProfileGate();
