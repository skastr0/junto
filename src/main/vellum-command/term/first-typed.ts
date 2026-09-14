/**
 * Tier B first-typed-message arming — one doctrine body per binding generation.
 * Delivered on first idle via ManagedTerminalDrive (not at spawn argv).
 */

const pending = new Map<string, string>();
const delivered = new Set<string>();
/**
 * Opaque arm ownership: bumped on every arm and every generation reset, so
 * a late write completion can prove it still owns the live arm. Text
 * equality is NOT identity — a generation replacement may rearm the
 * identical doctrine, and the old completion must not consume the new arm.
 */
const armSeq = new Map<string, number>();
let armSeqCounter = 0;

const stampArm = (id: string): number => {
  armSeqCounter += 1;
  armSeq.set(id, armSeqCounter);
  return armSeqCounter;
};

export const armFirstTypedMessage = (
  bindingId: string,
  text: string,
): void => {
  const id = bindingId.trim();
  const body = text.trim();
  if (!id || !body) return;
  if (delivered.has(id)) return;
  pending.set(id, body);
  stampArm(id);
};

export const takeFirstTypedMessage = (bindingId: string): string | undefined => {
  const id = bindingId.trim();
  const body = pending.get(id);
  if (body === undefined) return undefined;
  pending.delete(id);
  delivered.add(id);
  return body;
};

export const peekFirstTypedMessage = (bindingId: string): string | undefined =>
  pending.get(bindingId.trim());

/** One armed doctrine plus the opaque identity of the arm that set it. */
export type FirstTypedArm = {
  readonly text: string;
  readonly seq: number;
};

export const peekFirstTypedEntry = (
  bindingId: string,
): FirstTypedArm | undefined => {
  const id = bindingId.trim();
  const text = pending.get(id);
  if (text === undefined) return undefined;
  return { text, seq: armSeq.get(id) ?? 0 };
};

/**
 * Consume the arm only when `seq` still owns it. A same-text rearm carries
 * a newer seq, so a late completion from the superseded kick takes nothing.
 */
export const takeFirstTypedEntryIfCurrent = (
  bindingId: string,
  seq: number,
): string | undefined => {
  const id = bindingId.trim();
  const text = pending.get(id);
  if (text === undefined || armSeq.get(id) !== seq) return undefined;
  pending.delete(id);
  delivered.add(id);
  return text;
};

export const clearFirstTypedMessage = (bindingId: string): void => {
  const id = bindingId.trim();
  pending.delete(id);
  delivered.delete(id);
};

/**
 * Clear the delivered registry for one binding so a resumed generation can
 * receive the doctrine again (cold resume must not re-zero the seat).
 * Called when the supervisor observes a generation change. Stamps a fresh
 * generation so in-flight kicks from the dead generation own nothing.
 */
export const clearDeliveredForBinding = (bindingId: string): void => {
  const id = bindingId.trim();
  if (!id) return;
  pending.delete(id);
  delivered.delete(id);
  stampArm(id);
};

/** Test seam. */
export const resetFirstTypedForTest = (): void => {
  pending.clear();
  delivered.clear();
  armSeq.clear();
  armSeqCounter = 0;
};
