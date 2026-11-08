import type {
  OverseerArgsFor,
  OverseerErrorBody,
  OverseerRequest,
} from "@shared/overseer-control";
import type { OverseerSecretStore } from "./secret-store-seam";

/**
 * `secret.*`: Junto's own secret store on the machine that runs the command.
 *
 * A value comes in once, on `secret.put`, and goes to the store. Nothing here
 * returns it, repeats it in an error, or logs it: results carry ids and the
 * store's name, and a failure carries the store's own fixed sentence.
 */
export type OverseerSecretOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: OverseerErrorBody };

const refused = (
  type: OverseerErrorBody["type"],
  message: string,
): OverseerSecretOutcome => ({ ok: false, error: { type, message } });

export const SECRET_STORE_MISSING =
  "Junto's secret store is not available in this build";

export const executeOverseerSecret = (
  request: OverseerRequest,
  store: OverseerSecretStore | undefined,
): OverseerSecretOutcome => {
  if (store === undefined) return refused("Unsupported", SECRET_STORE_MISSING);
  switch (request.operation) {
    case "secret.put": {
      const { secretId, value } = request.args as OverseerArgsFor<"secret.put">;
      const saved = store.save(secretId === undefined ? { value } : { value, secretId });
      return saved.ok
        ? {
            ok: true,
            data: { secretId: saved.secretId, stored: true, backend: store.backend },
          }
        : refused("InvalidArguments", saved.message);
    }
    case "secret.delete": {
      const { secretId } = request.args as OverseerArgsFor<"secret.delete">;
      const removed = store.remove(secretId);
      return removed.ok
        ? { ok: true, data: { secretId, deleted: true } }
        : refused("InternalError", removed.message);
    }
    case "secret.list":
      return { ok: true, data: { secretIds: store.list(), backend: store.backend } };
    default:
      return refused(
        "InternalError",
        `secret dispatcher does not own ${request.operation}`,
      );
  }
};
