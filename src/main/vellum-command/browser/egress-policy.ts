import { isIP } from "node:net";
import {
  BROWSER_DNS_POLICY_TIMEOUT_MS,
  BROWSER_EGRESS_CONNECT_TIMEOUT_MS,
  BROWSER_EGRESS_HAPPY_EYEBALLS_DELAY_MS,
  BROWSER_MAX_EGRESS_HAPPY_EYEBALLS_INFLIGHT,
  BROWSER_MAX_PENDING_DNS_HOSTS,
  BROWSER_MAX_URL_BYTES,
  isUtf8WithinLimit,
} from "@shared/browser-limits";
import {
  classifyBrowserTarget,
  classifyIpAddress,
} from "@shared/browser-policy";
import {
  browserTestOnlyExactOrigin,
  isAllowedByBrowserTestOnlyExactOriginGrant,
  type BrowserTestOnlyExactOriginGrant,
} from "./web-policy";

export type EgressAddressFamily = "ipv4" | "ipv6";

export interface ApprovedEgressEndpoint {
  readonly address: string;
  readonly family: EgressAddressFamily;
}

export interface ResolvedHostEndpoints {
  readonly endpoints: ReadonlyArray<{
    readonly address: string;
    readonly family?: string;
  }>;
}

export type ResolveEgressHost = (hostname: string) => Promise<ResolvedHostEndpoints>;

export type DialApprovedEndpoint = (
  endpoint: ApprovedEgressEndpoint,
  port: number,
  signal: AbortSignal,
) => Promise<EgressSocket>;

export interface EgressSocket {
  readonly remoteAddress?: string;
  readonly destroyed: boolean;
  readonly destroy: (error?: Error) => void;
}

export type EgressDestinationDecision =
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "grant"; readonly host: string; readonly port: number }
  | {
      readonly kind: "literal";
      readonly endpoint: ApprovedEgressEndpoint;
      readonly port: number;
    }
  | { readonly kind: "resolve"; readonly hostname: string; readonly port: number };

const stripIpv6Brackets = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

const familyForAddress = (address: string): EgressAddressFamily | undefined => {
  const version = isIP(address);
  if (version === 4) return "ipv4";
  if (version === 6) return "ipv6";
  return undefined;
};

export const normalizeConnectedAddress = (address: string | undefined): string | undefined => {
  if (address === undefined || address === "") return undefined;
  const unbracketed = stripIpv6Brackets(address);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(unbracketed);
  return mapped?.[1] ?? unbracketed.toLowerCase();
};

export const approvedEndpointForAddress = (
  address: string,
): ApprovedEgressEndpoint | undefined => {
  const family = familyForAddress(address);
  if (family === undefined) return undefined;
  if (classifyIpAddress(address) !== "public") return undefined;
  return { address, family };
};

export const approveResolvedEndpoints = (
  endpoints: ResolvedHostEndpoints["endpoints"],
): ReadonlyArray<ApprovedEgressEndpoint> | undefined => {
  if (endpoints.length === 0) return undefined;
  const approved: ApprovedEgressEndpoint[] = [];
  for (const endpoint of endpoints) {
    const next = approvedEndpointForAddress(endpoint.address);
    if (next === undefined) return undefined;
    approved.push(next);
  }
  return approved;
};

const grantAuthority = (
  grant: BrowserTestOnlyExactOriginGrant,
): { readonly host: string; readonly port: number } => {
  const parsed = new URL(browserTestOnlyExactOrigin(grant));
  return { host: parsed.hostname, port: Number(parsed.port) };
};

const matchesGrantConnect = (
  host: string,
  port: number,
  grant: BrowserTestOnlyExactOriginGrant,
): boolean => {
  const expected = grantAuthority(grant);
  return stripIpv6Brackets(host) === expected.host && port === expected.port;
};

export const classifyEgressAuthority = (
  host: string,
  port: number,
  grant?: BrowserTestOnlyExactOriginGrant,
): EgressDestinationDecision => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { kind: "deny", reason: "port" };
  }
  if (host.length === 0 || !isUtf8WithinLimit(host, BROWSER_MAX_URL_BYTES)) {
    return { kind: "deny", reason: "host" };
  }
  const unbracketed = stripIpv6Brackets(host);
  if (grant !== undefined && matchesGrantConnect(unbracketed, port, grant)) {
    return { kind: "grant", host: unbracketed, port };
  }

  const literalScope = classifyIpAddress(unbracketed);
  if (literalScope === "public") {
    const endpoint = approvedEndpointForAddress(unbracketed);
    return endpoint === undefined
      ? { kind: "deny", reason: "literal" }
      : { kind: "literal", endpoint, port };
  }
  if (literalScope === "non_public") return { kind: "deny", reason: "non_public_ip" };

  const bracketed = unbracketed.includes(":") ? `[${unbracketed}]` : unbracketed;
  const target = classifyBrowserTarget(`https://${bracketed}/`);
  if (!target.allowed) return { kind: "deny", reason: target.reason };
  return { kind: "resolve", hostname: target.hostname, port };
};

export const classifyEgressHttpUrl = (
  url: string,
  grant?: BrowserTestOnlyExactOriginGrant,
): EgressDestinationDecision => {
  if (!isUtf8WithinLimit(url, BROWSER_MAX_URL_BYTES)) return { kind: "deny", reason: "url" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "deny", reason: "url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "deny", reason: "scheme" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { kind: "deny", reason: "credentials" };
  }
  if (grant !== undefined && isAllowedByBrowserTestOnlyExactOriginGrant(url, grant)) {
    const port =
      parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
    return { kind: "grant", host: parsed.hostname, port };
  }
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  return classifyEgressAuthority(parsed.hostname, port, grant);
};

export const createBoundedHostResolver = (
  resolveHost: ResolveEgressHost,
): ((hostname: string) => Promise<ReadonlyArray<ApprovedEgressEndpoint> | undefined>) => {
  const pending = new Map<string, Promise<ReadonlyArray<ApprovedEgressEndpoint> | undefined>>();

  return (hostname: string): Promise<ReadonlyArray<ApprovedEgressEndpoint> | undefined> => {
    const existing = pending.get(hostname);
    if (existing !== undefined) return existing;
    if (pending.size >= BROWSER_MAX_PENDING_DNS_HOSTS) {
      return Promise.resolve(undefined);
    }

    let settle!: (value: ReadonlyArray<ApprovedEgressEndpoint> | undefined) => void;
    const bounded = new Promise<ReadonlyArray<ApprovedEgressEndpoint> | undefined>((resolve) => {
      settle = resolve;
    });
    pending.set(hostname, bounded);

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: ReadonlyArray<ApprovedEgressEndpoint> | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (pending.get(hostname) === bounded) pending.delete(hostname);
      settle(value);
    };
    timer = setTimeout(() => finish(undefined), BROWSER_DNS_POLICY_TIMEOUT_MS);

    try {
      void resolveHost(hostname).then(
        (result) => finish(approveResolvedEndpoints(result.endpoints)),
        () => finish(undefined),
      );
    } catch {
      finish(undefined);
    }
    return bounded;
  };
};

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Synchronous permission check consulted before every dial attempt. Returning
 * false must stop further attempts for this connect; the caller owns charging
 * each dialing or connected socket against its budget. The callback must be
 * pure (no reservation side effect) so a skipped dial cannot leak a charge.
 */
export type EgressDialBudget = () => boolean;

export const connectApprovedEndpoints = async (
  endpoints: ReadonlyArray<ApprovedEgressEndpoint>,
  port: number,
  dial: DialApprovedEndpoint,
  parentSignal?: AbortSignal,
  budget?: EgressDialBudget,
): Promise<EgressSocket> => {
  if (endpoints.length === 0) throw new Error("no approved egress endpoint");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, BROWSER_EGRESS_CONNECT_TIMEOUT_MS);
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) controller.abort();

  const ipv6 = endpoints.filter((endpoint) => endpoint.family === "ipv6");
  const ipv4 = endpoints.filter((endpoint) => endpoint.family === "ipv4");
  const ordered = ipv6.length === 0 || ipv4.length === 0 ? [...endpoints] : [...ipv6, ...ipv4];

  let winner: EgressSocket | undefined;
  let firstError: unknown;
  let budgetRefused = false;
  const resolved: EgressSocket[] = [];
  const active = new Set<Promise<void>>();

  const attempt = async (endpoint: ApprovedEgressEndpoint): Promise<void> => {
    if (winner !== undefined || controller.signal.aborted) return;
    if (budget !== undefined && !budget()) {
      budgetRefused = true;
      firstError ??= new Error("egress socket budget exhausted");
      return;
    }
    try {
      const socket = await dial(endpoint, port, controller.signal);
      resolved.push(socket);
      if (winner !== undefined || controller.signal.aborted || socket.destroyed) {
        socket.destroy();
        return;
      }
      const remote = normalizeConnectedAddress(socket.remoteAddress);
      if (remote !== endpoint.address.toLowerCase()) {
        socket.destroy();
        throw new Error("egress peer address mismatch");
      }
      winner = socket;
      abort();
    } catch (error) {
      firstError ??= error;
    }
  };

  const launch = (endpoint: ApprovedEgressEndpoint): void => {
    const flight = attempt(endpoint);
    active.add(flight);
    void flight.then(() => {
      active.delete(flight);
    });
  };

  try {
    for (const [index, endpoint] of ordered.entries()) {
      if (winner !== undefined || controller.signal.aborted || budgetRefused) break;
      if (index > 0 && active.size > 0) {
        // Happy Eyeballs stagger: give the previous attempt a head start
        // before opening the next family or address.
        await Promise.race([
          ...active,
          delay(BROWSER_EGRESS_HAPPY_EYEBALLS_DELAY_MS, controller.signal),
        ]);
      }
      // Bound concurrent dials instead of accumulating one attempt per
      // candidate answer: a many-address batch must not fan out into dozens
      // of simultaneous outbound sockets.
      while (
        active.size >= BROWSER_MAX_EGRESS_HAPPY_EYEBALLS_INFLIGHT &&
        winner === undefined &&
        !controller.signal.aborted
      ) {
        await Promise.race([...active]);
      }
      if (winner !== undefined || controller.signal.aborted || budgetRefused) break;
      launch(endpoint);
    }
    await Promise.allSettled(active);
    for (const socket of resolved) {
      if (socket !== winner) socket.destroy();
    }
    if (winner !== undefined) return winner;
    throw firstError instanceof Error ? firstError : new Error("egress connect failed");
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
};
