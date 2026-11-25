/** A DNS name or an IPv4 address; the shape a link has always admitted. */
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/u;

/** Why an IPv6 route cannot be stored: every answer is fixed text, never the host. */
export type LiteralHostProblem =
  | "brackets"
  | "zone"
  | "mapped"
  | "unspecified"
  | "multicast"
  | "link-local"
  | "invalid";

const words = (host: string): ReadonlyArray<number> | undefined => {
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const parse = (half: string): ReadonlyArray<number> | undefined => {
    if (half === "") return [];
    const groups = half.split(":");
    if (groups.some((group) => !/^[0-9A-Fa-f]{1,4}$/u.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parse(halves[0] ?? "");
  const right = parse(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
};

const problemOf = (host: string): LiteralHostProblem | undefined => {
  if (host.includes("[") || host.includes("]")) return "brackets";
  if (host.includes("%")) return "zone";
  if (host.includes(".")) return "mapped";
  if (host.length === 0 || host.length > 39) return "invalid";
  const parsed = words(host);
  if (parsed === undefined) return "invalid";
  if (parsed.every((word) => word === 0)) return "unspecified";
  if ((parsed[0]! & 0xff00) === 0xff00) return "multicast";
  if ((parsed[0]! & 0xffc0) === 0xfe80) return "link-local";
  return undefined;
};

/** Why `host` cannot be a link route, or undefined for a DNS name, IPv4 or dialable IPv6. */
export const literalHostProblem = (host: string): LiteralHostProblem | undefined =>
  NAME.test(host) ? undefined : problemOf(host);

/**
 * The one spelling a route stores: RFC 5952 for IPv6 (lowercase, leading zeros
 * dropped, the longest zero run compressed), every other literal as written.
 * One address therefore cannot become two routes with two pins.
 */
export const canonicalLiteralHost = (host: string): string | undefined => {
  if (NAME.test(host)) return host;
  if (problemOf(host) !== undefined) return undefined;
  const parsed = words(host);
  if (parsed === undefined) return undefined;
  let start = -1;
  let length = 0;
  for (let index = 0; index < parsed.length;) {
    if (parsed[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < parsed.length && parsed[end] === 0) end += 1;
    if (end - index > length) { start = index; length = end - index; }
    index = end;
  }
  const hex = (word: number): string => word.toString(16);
  if (length < 2) return parsed.map(hex).join(":");
  return `${parsed.slice(0, start).map(hex).join(":")}::${parsed.slice(start + length).map(hex).join(":")}`;
};

export const isLiteralHost = (host: string): boolean => canonicalLiteralHost(host) !== undefined;

/** The refusal's fixed text, with no host in it. */
export const LITERAL_HOST_REFUSAL =
  "A link dials one literal user, host and port. This route cannot be dialed as a literal: reach the machine by a hostname or IPv4 address, write an IPv6 address bare without brackets, and set a nonstandard port separately.";

const suffix: Record<LiteralHostProblem, string> = {
  brackets: "Leave the brackets out.",
  zone: "Leave the zone out.",
  mapped: "Write the IPv4 address as a.b.c.d.",
  unspecified: "The unspecified address cannot name a machine.",
  multicast: "A multicast address cannot name one machine.",
  "link-local": "A link-local address cannot be dialed from another machine.",
  invalid: "",
};

export const literalHostRefusal = (host: string): string => {
  const problem = literalHostProblem(host);
  return problem === undefined ? LITERAL_HOST_REFUSAL : `${LITERAL_HOST_REFUSAL} ${suffix[problem]}`;
};
