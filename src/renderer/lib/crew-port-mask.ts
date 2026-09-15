/**
 * Operator port-mask view — compiled ports minus an optional subtract-only
 * mask. A mask never invents a port the verb did not compile.
 */
import type { CanvasEdge } from "@shared/canvas";
import type { PortName } from "@shared/physics";

export const CREW_ATTENUABLE_PORTS = [
  "msg.list",
  "msg.send",
  "msg.prompt",
  "seat.wait",
  "terminal.read",
  "verdict.post",
] as const;
export type CrewAttenuablePort = (typeof CREW_ATTENUABLE_PORTS)[number];

export type CrewPortName = PortName | CrewAttenuablePort;

export const CREW_PORT_LABEL: Record<CrewAttenuablePort, string> = {
  "msg.list": "List messages",
  "msg.send": "Send mail",
  "msg.prompt": "Prompt immediately",
  "seat.wait": "Wait on seat",
  "terminal.read": "Observe terminal",
  "verdict.post": "Post verdict",
};

export const crewPortLabel = (port: string): string =>
  CREW_PORT_LABEL[port as CrewAttenuablePort] ?? port;

const isCrewPort = (value: unknown): value is CrewPortName =>
  typeof value === "string" && value.trim().length > 0;

export const parsePortMask = (value: unknown): ReadonlyArray<CrewPortName> => {
  if (!Array.isArray(value)) return [];
  const ports: CrewPortName[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isCrewPort(entry) || seen.has(entry)) continue;
    seen.add(entry);
    ports.push(entry);
  }
  return ports;
};

type AuthoredPortMask = {
  readonly portMask?: unknown;
  readonly mask?: unknown;
};

/**
 * Allow-list on the relation. `portMask` is the live field; omitted means the
 * full compile. Empty grants none. A retired `mask` key is read only until
 * the document scrub finishes dropping it.
 */
export const authoredPortMaskOf = (
  edge: CanvasEdge,
): ReadonlyArray<CrewPortName> | undefined => {
  const ether = edge.ether as AuthoredPortMask | undefined;
  const raw = ether?.portMask ?? ether?.mask;
  if (raw === undefined) return undefined;
  return parsePortMask(raw);
};

/** @deprecated use authoredPortMaskOf — empty and omitted are different. */
export const edgePortMaskOf = (
  edge: CanvasEdge,
): ReadonlyArray<CrewPortName> => authoredPortMaskOf(edge) ?? [];

export type EdgePortMaskChip = {
  readonly port: CrewPortName;
  readonly label: string;
  readonly granted: boolean;
  readonly attenuable: boolean;
};

export type EdgePortMaskView = {
  readonly verb: string | undefined;
  readonly compiled: ReadonlyArray<CrewPortName>;
  /** Remaining allowed ports. Undefined means the verb's full compile. */
  readonly allowed: ReadonlyArray<CrewPortName> | undefined;
  readonly chips: ReadonlyArray<EdgePortMaskChip>;
};

/**
 * `ether.portMask` is the remaining allow-list. Omitted grants every compiled
 * port. Empty grants none. Names that were never compiled are dropped.
 */
export const edgePortMaskView = (
  compiled: ReadonlyArray<string>,
  allowed: ReadonlyArray<string> | undefined,
  verb: string | undefined,
): EdgePortMaskView => {
  const compiledPorts = compiled.filter(isCrewPort);
  const compiledSet = new Set<string>(compiledPorts);
  const allowedPorts =
    allowed === undefined
      ? undefined
      : allowed.filter(
          (port): port is CrewPortName =>
            isCrewPort(port) && compiledSet.has(port),
        );
  const allowedSet =
    allowedPorts === undefined ? undefined : new Set<string>(allowedPorts);
  const chips: EdgePortMaskChip[] = compiledPorts.map((port) => ({
    port,
    label: crewPortLabel(port),
    granted: allowedSet === undefined || allowedSet.has(port),
    attenuable: (CREW_ATTENUABLE_PORTS as readonly string[]).includes(port),
  }));
  return {
    verb,
    compiled: compiledPorts,
    allowed: allowedPorts,
    chips,
  };
};

/**
 * Toggle a compiled port in the allow-list. Returns undefined when the
 * result is the full compile (omit the document mask).
 */
export const toggleAllowedPort = (
  compiled: ReadonlyArray<string>,
  allowed: ReadonlyArray<string> | undefined,
  port: string,
): ReadonlyArray<CrewPortName> | undefined => {
  const compiledPorts = compiled.filter(isCrewPort);
  if (!compiledPorts.includes(port as CrewPortName)) {
    return allowed === undefined
      ? undefined
      : allowed.filter((entry): entry is CrewPortName => isCrewPort(entry));
  }
  const current =
    allowed === undefined
      ? compiledPorts
      : compiledPorts.filter((entry) => allowed.includes(entry));
  const next = current.includes(port as CrewPortName)
    ? current.filter((entry) => entry !== port)
    : [...current, port as CrewPortName];
  if (
    next.length === compiledPorts.length &&
    compiledPorts.every((entry) => next.includes(entry))
  ) {
    return undefined;
  }
  return next;
};

/**
 * Persist shape for today's canvas schema. `compileEdgeGrant` and the
 * decode scrub keep `mask`; `portMask` is still stripped. Flip this helper
 * to `portMask` when that field lands — the view already reads both.
 */
export const persistPortMaskEther = <V extends string>(
  verb: V,
  allowed: ReadonlyArray<CrewPortName> | undefined,
): { readonly verb: V; readonly mask?: ReadonlyArray<CrewPortName> } =>
  allowed === undefined ? { verb } : { verb, mask: allowed };

/** @deprecated use toggleAllowedPort — kept for the subtract-only tests. */
export const toggleMaskedPort = (
  compiled: ReadonlyArray<string>,
  maskedOut: ReadonlyArray<string>,
  port: string,
): ReadonlyArray<CrewPortName> => {
  const allowed = compiled.filter((entry) => !maskedOut.includes(entry));
  const next = toggleAllowedPort(compiled, allowed, port);
  const remaining = next ?? compiled.filter(isCrewPort);
  return compiled.filter(
    (entry): entry is CrewPortName =>
      isCrewPort(entry) && !remaining.includes(entry),
  );
};
