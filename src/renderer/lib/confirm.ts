import { observable } from "@legendapp/state";

/**
 * The one way to ask the operator a yes or no question before something
 * destructive. It replaces the native window.confirm: the question renders
 * through ui ConfirmDialog (ConfirmHost), so it sits in the layer model, is
 * themed, and follows the focus and Escape rules of every other dialog.
 *
 * `askConfirm` resolves true only on an explicit confirm. Cancel, Escape and
 * the backdrop resolve false. Do the destructive thing after it resolves,
 * never before.
 */

export type ConfirmRequest = {
  /** Who is asking, for diagnostics: "artifact-delete", "node-delete". */
  readonly source: string;
  /** The question: "Delete this node?" */
  readonly title: string;
  /** What happens if the operator confirms, one plain sentence per line. */
  readonly body?: ReadonlyArray<string>;
  /** The verb of the action: "Delete node". */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** "danger" for anything that destroys or stops something. */
  readonly tone?: "danger" | "primary";
};

export const confirm$ = observable<{ pending: ConfirmRequest | null }>({ pending: null });

let settle: ((confirmed: boolean) => void) | null = null;

/**
 * Ask. One question at a time: a second ask while one is open is refused
 * (false) rather than queued, since the first may change what the second
 * was about. The refusal is logged with both sources so it is never silent.
 */
export const askConfirm = (request: ConfirmRequest): Promise<boolean> => {
  const open = confirm$.pending.peek();
  if (open !== null) {
    console.warn(
      `askConfirm: "${request.source}" asked while "${open.source}" was still open; the second ask was refused.`,
    );
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    settle = resolve;
    confirm$.pending.set(request);
  });
};

/** The operator answered (ConfirmHost calls this). */
export const answerConfirm = (confirmed: boolean): void => {
  const resolve = settle;
  settle = null;
  confirm$.pending.set(null);
  resolve?.(confirmed);
};
