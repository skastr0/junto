/**
 * Tier B first-typed-message arming — one doctrine body per binding generation.
 * Delivered on first idle via ManagedTerminalDrive (not at spawn argv).
 */

const pending = new Map<string, string>();
const delivered = new Set<string>();

export const armFirstTypedMessage = (
  bindingId: string,
  text: string,
): void => {
  const id = bindingId.trim();
  const body = text.trim();
  if (!id || !body) return;
  if (delivered.has(id)) return;
  pending.set(id, body);
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

export const clearFirstTypedMessage = (bindingId: string): void => {
  const id = bindingId.trim();
  pending.delete(id);
  delivered.delete(id);
};

/** Test seam. */
export const resetFirstTypedForTest = (): void => {
  pending.clear();
  delivered.clear();
};
