import { Effect } from "effect";
import {
  WORK_NODE_REF_ENV,
  validateNodeRefString,
} from "../../shared/work-control";
import { InputError } from "./errors";

/**
 * Resolve caller nodeRef: payload `node` field wins, else VELLUM_NODE_REF.
 * Schema-validated either way via shared parseNodeRef.
 */
export const resolveCallerNodeRef = (
  payload: { readonly node?: string } | undefined,
): Effect.Effect<string, InputError> =>
  Effect.gen(function* () {
    const fromPayload = payload?.node?.trim();
    const fromEnv = process.env[WORK_NODE_REF_ENV]?.trim();
    const raw = fromPayload || fromEnv;
    if (!raw) {
      return yield* Effect.fail(
        new InputError({
          message: `caller nodeRef required — set ${WORK_NODE_REF_ENV} or pass "node" in the payload`,
          path: "node",
          hint: "vellum://canvas/<name>?node=<id>",
          next_step: `export ${WORK_NODE_REF_ENV}=vellum://canvas/...`,
        }),
      );
    }
    const parsed = validateNodeRefString(raw);
    if (!parsed.ok) {
      return yield* Effect.fail(
        new InputError({
          message: parsed.error.message,
          path: "node",
          received: raw,
          hint: parsed.error.details?.hint,
          next_step: parsed.error.details?.next_step,
        }),
      );
    }
    // Re-format is already canonical in parseNodeRef success path.
    return raw;
  });
