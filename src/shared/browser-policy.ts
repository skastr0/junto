// Pure hostile-web admission policy. This module intentionally performs no DNS
// lookup: it rejects ambiguous and non-public literal targets synchronously.
// A DNS hostname passing this function is not proof that its resolved endpoint
// is public; the Electron adapter must enforce that separate runtime boundary.

export type BrowserTargetRejection =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "ambiguous_host"
  | "local_host"
  | "non_public_ip";

export type BrowserTargetDecision =
  | {
      readonly allowed: true;
      readonly normalizedUrl: string;
      readonly hostname: string;
    }
  | {
      readonly allowed: false;
      readonly reason: BrowserTargetRejection;
    };

const deny = (reason: BrowserTargetRejection): BrowserTargetDecision => ({
  allowed: false,
  reason,
});

const rawAuthority = (input: string): string | undefined => {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(input);
  return match?.[1];
};

const rawHostname = (authority: string): string | undefined => {
  if (authority.includes("@")) return undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return undefined;
    const suffix = authority.slice(end + 1);
    if (suffix !== "" && !/^:[0-9]+$/u.test(suffix)) return undefined;
    return authority.slice(0, end + 1);
  }

  const colon = authority.lastIndexOf(":");
  if (colon < 0) return authority;
  const port = authority.slice(colon + 1);
  if (!/^[0-9]+$/u.test(port) || authority.slice(0, colon).includes(":")) {
    return undefined;
  }
  return authority.slice(0, colon);
};

const parseCanonicalIpv4 = (hostname: string): ReadonlyArray<number> | undefined => {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) =>
    /^(0|[1-9][0-9]{0,2})$/u.test(part) ? Number(part) : -1,
  );
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
};

const isNonPublicIpv4 = (octets: ReadonlyArray<number>): boolean => {
  const [a = -1, b = -1, c = -1] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

const parseIpv6 = (hostname: string): ReadonlyArray<number> | undefined => {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return undefined;
  const body = hostname.slice(1, -1).toLowerCase();
  if (body.includes("%") || !/^[0-9a-f:]+$/u.test(body)) return undefined;
  const halves = body.split("::");
  if (halves.length > 2) return undefined;

  const parseHalf = (half: string): ReadonlyArray<number> | undefined => {
    if (half === "") return [];
    const parts = half.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return undefined;
    return parts.map((part) => Number.parseInt(part, 16));
  };

  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
};

const hasPrefix = (
  words: ReadonlyArray<number>,
  prefix: ReadonlyArray<number>,
  bits: number,
): boolean => {
  const wholeWords = Math.floor(bits / 16);
  for (let index = 0; index < wholeWords; index += 1) {
    if (words[index] !== prefix[index]) return false;
  }
  const remaining = bits % 16;
  if (remaining === 0) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return ((words[wholeWords] ?? 0) & mask) === ((prefix[wholeWords] ?? 0) & mask);
};

const isNonPublicIpv6 = (words: ReadonlyArray<number>): boolean =>
  words.every((word) => word === 0) ||
  (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
  hasPrefix(words, [0, 0, 0, 0, 0, 0], 96) ||
  hasPrefix(words, [0, 0, 0, 0, 0, 0xffff], 96) ||
  hasPrefix(words, [0x64, 0xff9b, 0, 0, 0, 0], 96) ||
  hasPrefix(words, [0x64, 0xff9b, 1], 48) ||
  hasPrefix(words, [0x100, 0, 0, 0], 64) ||
  hasPrefix(words, [0x2001, 0], 32) ||
  hasPrefix(words, [0x2001, 0x2, 0], 48) ||
  hasPrefix(words, [0x2001, 0x10], 28) ||
  hasPrefix(words, [0x2001, 0x20], 28) ||
  hasPrefix(words, [0x2001, 0xdb8], 32) ||
  hasPrefix(words, [0x2002], 16) ||
  hasPrefix(words, [0x3fff], 20) ||
  hasPrefix(words, [0x5f00], 16) ||
  hasPrefix(words, [0xfc00], 7) ||
  hasPrefix(words, [0xfe80], 10) ||
  hasPrefix(words, [0xff00], 8);

const LOCAL_DNS_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home.arpa",
  "test",
  "example",
  "invalid",
] as const;

const isLocalDnsName = (hostname: string): boolean =>
  !hostname.includes(".") ||
  LOCAL_DNS_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );

const isCanonicalDnsName = (hostname: string): boolean =>
  hostname.length <= 253 &&
  hostname
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );

/**
 * Admission for a user-visible top-level browser target. It deliberately
 * rejects non-canonical numeric hosts so WHATWG legacy IPv4 normalization
 * cannot turn an apparently different spelling into loopback/private space.
 */
export const classifyBrowserTarget = (input: string): BrowserTargetDecision => {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return deny("invalid_url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return deny("scheme");
  const authority = rawAuthority(input);
  if (authority === undefined) return deny("ambiguous_host");
  if (authority.includes("@") || parsed.username !== "" || parsed.password !== "") {
    return deny("credentials");
  }
  const sourceHostname = rawHostname(authority);
  if (sourceHostname === undefined || sourceHostname === "") return deny("ambiguous_host");

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".")) return deny("ambiguous_host");
  const ipv4 = parseCanonicalIpv4(hostname);
  if (ipv4 !== undefined) {
    if (sourceHostname !== hostname) return deny("ambiguous_host");
    return isNonPublicIpv4(ipv4)
      ? deny("non_public_ip")
      : { allowed: true, normalizedUrl: parsed.href, hostname };
  }

  if (hostname.startsWith("[") || hostname.endsWith("]")) {
    const ipv6 = parseIpv6(hostname);
    if (ipv6 === undefined) return deny("ambiguous_host");
    return isNonPublicIpv6(ipv6)
      ? deny("non_public_ip")
      : { allowed: true, normalizedUrl: parsed.href, hostname };
  }

  if (!isCanonicalDnsName(hostname)) return deny("ambiguous_host");
  if (isLocalDnsName(hostname)) return deny("local_host");
  return { allowed: true, normalizedUrl: parsed.href, hostname };
};

export const isAllowedBrowserTarget = (input: string): boolean =>
  classifyBrowserTarget(input).allowed;
