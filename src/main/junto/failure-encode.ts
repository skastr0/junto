import { Cause, Schema } from "effect";
import { EncodedFailure, MAX_FAILURE_CAUSES, type EncodedCause } from "@shared/failure";
import { scrubMessage } from "./credentials/scrub";

/**
 * The encode boundary: the one function that turns a failure into its wire
 * and log form, every text field through the doctrine scrub. The link send
 * and the log writer both call it.
 */
const decodeEncoded = Schema.decodeUnknownSync(EncodedFailure, { onExcessProperty: "error" });

const NO_MESSAGE = "(no message)";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const tagPattern = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Path and issue kind only: a decode failure never carries the value it saw. */
const describeSchemaIssue = (issue: unknown): string => {
  const found: string[] = [];
  const walk = (node: unknown, path: ReadonlyArray<PropertyKey>): void => {
    if (!isRecord(node) || found.length >= 4) return;
    if (Array.isArray(node.path) && "issue" in node) { walk(node.issue, [...path, ...(node.path as PropertyKey[])]); return; }
    if (Array.isArray(node.issues)) { for (const child of node.issues) walk(child, path); return; }
    if ("issue" in node && isRecord(node.issue)) { walk(node.issue, path); return; }
    const kind = typeof node._tag === "string" ? node._tag : "Issue";
    found.push(path.length === 0 ? kind : `${kind} at ${path.map(key => `[${JSON.stringify(String(key))}]`).join("")}`);
  };
  walk(issue, []);
  return `Decode failed: ${found.length === 0 ? "value does not match its schema" : found.join("; ")}`;
};

/** One link of a chain, with its message through the doctrine scrub. */
export const describeCause = (cause: unknown): EncodedCause => {
  if (isRecord(cause) && cause._tag === "SchemaError" && "issue" in cause) return { tag: "SchemaError", message: describeSchemaIssue(cause.issue) };
  const tagged = isRecord(cause) && typeof cause._tag === "string" && tagPattern.test(cause._tag) && cause._tag.length <= 64 ? cause._tag : undefined;
  const named = cause instanceof Error && tagPattern.test(cause.name) && cause.name.length <= 64 ? cause.name : undefined;
  const tag = tagged ?? named ?? (cause instanceof Error ? "Error" : "Unknown");
  const raw = cause instanceof Error || (isRecord(cause) && typeof cause.message === "string") ? String((cause as { message: unknown }).message) : typeof cause === "string" ? cause : "";
  return { tag, message: scrubMessage(raw) || NO_MESSAGE };
};

const nested = (cause: unknown): { readonly chain: ReadonlyArray<EncodedCause>; readonly next: unknown } => {
  if (!isRecord(cause)) return { chain: [], next: undefined };
  // A failure that already carries an encoded chain contributes it whole.
  if (isRecord(cause.failure) && typeof cause.failure.tag === "string" && Array.isArray(cause.failure.causes)) {
    const failure = cause.failure as unknown as EncodedFailure;
    return { chain: [{ tag: failure.tag, message: failure.message }, ...failure.causes], next: undefined };
  }
  if (Array.isArray(cause.causes)) return { chain: cause.causes as ReadonlyArray<EncodedCause>, next: undefined };
  return { chain: [], next: cause.cause };
};

/** The causes under a failure, first cause last, bounded to eight links. */
export const causeChain = (cause: unknown): { readonly causes: ReadonlyArray<EncodedCause>; readonly cut: boolean } => {
  const causes: EncodedCause[] = [];
  const seen = new Set<unknown>([cause]);
  let current = cause;
  let cut = false;
  for (;;) {
    const { chain, next } = nested(current);
    for (const link of chain) { if (causes.length >= MAX_FAILURE_CAUSES) { cut = true; break; } causes.push({ tag: describeCause({ _tag: link.tag }).tag, message: scrubMessage(link.message) || NO_MESSAGE }); }
    if (cut || next === undefined || next === null || seen.has(next)) break;
    if (causes.length >= MAX_FAILURE_CAUSES) { cut = true; break; }
    seen.add(next);
    causes.push(describeCause(next));
    current = next;
  }
  return { causes, cut };
};

export interface FailureWhere {
  readonly machine: string;
  readonly operationId?: string;
  /** A channel's own closed failure, already encoded by its schema. */
  readonly detail?: unknown;
}

/** Encodes one thrown or failed value; never replaces it with a fixed phrase. */
export const encodeError = (error: unknown, where: FailureWhere): EncodedFailure => {
  const head = describeCause(error);
  const { causes, cut } = causeChain(error);
  const encoded = { ...head, machine: where.machine, ...(where.operationId === undefined ? {} : { operationId: where.operationId }), causes, ...(cut ? { causesCut: true as const } : {}) };
  if (where.detail !== undefined) {
    try { return decodeEncoded({ ...encoded, detail: where.detail }); } catch { /* A detail that is not JSON travels as the chain alone. */ }
  }
  return decodeEncoded(encoded);
};

/**
 * The encode boundary for anything a caller holds: an Effect Cause, an Error
 * or a thrown value. An empty Cause has no failure and encodes to nothing.
 */
export const encodeFailure = (failure: unknown, where: FailureWhere): EncodedFailure | undefined => {
  if (!Cause.isCause(failure)) return encodeError(failure, where);
  if (failure.reasons.length === 0) return undefined;
  const reason = failure.reasons.find(Cause.isFailReason) ?? failure.reasons.find(Cause.isDieReason);
  if (reason === undefined) return encodeError({ _tag: "Interrupted", message: "The operation was interrupted" }, where);
  return encodeError(Cause.isFailReason(reason) ? reason.error : reason.defect, where);
};

/** The receiving end distrusts the sender: closed decode, then the scrub again. */
export const decodeEncodedFailure = (input: unknown): EncodedFailure => {
  const failure = decodeEncoded(input);
  return {
    ...failure,
    message: scrubMessage(failure.message) || NO_MESSAGE,
    causes: failure.causes.map(link => ({ tag: link.tag, message: scrubMessage(link.message) || NO_MESSAGE })),
  };
};

