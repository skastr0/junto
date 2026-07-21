/**
 * Authorial canvas mutations are human/operator-only.
 *
 * Agents consume compiled digests, pulse briefings, and tool results from a
 * local Vellum process. They must not create, update, or delete canvas nodes,
 * edges, regions, watchers, or host stamps.
 *
 * CLI scripts that mutate canvases (populate, canvas:rm, etc.) are operator
 * tooling. They require an explicit opt-in so ambient agent shells do not
 * rewrite the board by accident.
 */

export const AUTHORIAL_WRITE_ENV = "VELLUM_AUTHORIAL_WRITE";

export type AuthorialWriteDenial = {
  readonly ok: false;
  readonly code: "authorial_write_denied";
  readonly message: string;
};

export type AuthorialWriteAllow = { readonly ok: true };

export type AuthorialWriteGate = AuthorialWriteAllow | AuthorialWriteDenial;

const DENIAL_MESSAGE =
  "Canvas mutation is operator-only. Agents must not write the canvas. " +
  `Set ${AUTHORIAL_WRITE_ENV}=1 for deliberate operator CLI tools.`;

/**
 * Gate for headless CLI / agent-reachable scripts.
 * Electron UI writeCanvas remains operator UI and does not use this env.
 */
export const allowAuthorialCliWrite = (
  env: NodeJS.ProcessEnv = process.env,
): AuthorialWriteGate => {
  const raw = env[AUTHORIAL_WRITE_ENV] ?? "";
  if (raw === "1" || raw.toLowerCase() === "true") {
    return { ok: true };
  }
  return {
    ok: false,
    code: "authorial_write_denied",
    message: DENIAL_MESSAGE,
  };
};

export const requireAuthorialCliWrite = (
  env: NodeJS.ProcessEnv = process.env,
): void => {
  const gate = allowAuthorialCliWrite(env);
  if (!gate.ok) {
    const error = new Error(gate.message) as Error & { code: string };
    error.code = gate.code;
    throw error;
  }
};
