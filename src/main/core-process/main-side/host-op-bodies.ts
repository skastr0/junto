/**
 * Main's end of the host operations (Wave 3): the bodies that answer what the
 * core asks Electron for. Each main module registers its own with `hostOps`
 * once it has what they need; the port to the core answers each host call
 * with `runHostOp`. The protocol is `../host-ops.ts`.
 */
import type { HostAnswer, HostFailure, HostOpBodies, HostOpBody, HostOpName } from "../host-ops";

const bodies = new Map<string, HostOpBody<HostOpName>>();

/** Register main's bodies for some host operations; returns their removal. A name registered twice is a bug. */
export const hostOps = (group: HostOpBodies): (() => void) => {
  const names: string[] = [];
  for (const [name, body] of Object.entries(group)) {
    if (body === undefined) continue;
    if (bodies.has(name)) throw new Error(`host operation registered twice: ${name}`);
    bodies.set(name, body as HostOpBody<HostOpName>);
    names.push(name);
  }
  return () => {
    for (const name of names) bodies.delete(name);
  };
};

const hostFailureOf = (error: unknown): HostFailure => ({
  tag: typeof error === "object" && error !== null && "_tag" in error ? String((error as { _tag: unknown })._tag) : undefined,
  message: error instanceof Error ? error.message : String(error),
});

/** Run one named host operation; the answer or a `HostFailure`. */
export const runHostOp = async (name: string, input: unknown): Promise<HostAnswer> => {
  const body = bodies.get(name);
  if (body === undefined) return { ok: false, failure: { tag: "UnknownHostOp", message: `no host operation named ${name}` } };
  try {
    return { ok: true, value: await body(input as never) };
  } catch (error) {
    return { ok: false, failure: hostFailureOf(error) };
  }
};
