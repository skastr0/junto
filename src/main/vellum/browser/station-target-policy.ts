import { isValidProfileId } from "@shared/browser";
import { classifyBrowserTarget } from "@shared/browser-policy";
import type { CanvasDoc } from "@shared/canvas";
import { parseNodeRef } from "@shared/node-ref";
import { resolveNodeHostId } from "@shared/station";
import {
  canonicalStationBrowserJson,
  type StationBrowserRequest,
} from "@shared/station-browser";
import {
  connectedPageRefs,
  findNode,
  isPageNode,
  nodeKind,
} from "./authz";
import type { StationBrowserVerificationContext } from "./station-delegation";

export interface StationBrowserTargetPolicyDeps {
  readonly stationId: string;
  readonly readCanvas: (name: string) => Promise<CanvasDoc | undefined>;
  /** Remote freshness authority (station config + complete current mirror). */
  readonly admitStation: () => Promise<Readonly<{ ok: boolean }>>;
  /** Current physical host/role/capability readiness from local composition. */
  readonly browserReady: () => boolean;
  readonly currentGeneration: (
    request: StationBrowserRequest,
  ) => string | undefined;
  readonly now?: () => number;
}

interface PagePolicy {
  readonly pageRef: string;
  readonly hostId: string;
  readonly edgeAllowed: boolean;
  readonly policyAllowed: boolean;
}

interface RequestPolicy {
  readonly ready: boolean;
  readonly requestWire: string;
  readonly pages: ReadonlyMap<string, PagePolicy>;
}

const canonicalStationId = (value: string): boolean =>
  /^[A-Za-z0-9._:-]{1,128}$/.test(value);

const emptyPolicy = (
  request: StationBrowserRequest,
): RequestPolicy => ({
  ready: false,
  requestWire: canonicalStationBrowserJson(request),
  pages: new Map(),
});

const pagePolicy = (
  doc: CanvasDoc,
  canvasName: string,
  callerNodeId: string,
  stationId: string,
): ReadonlyMap<string, PagePolicy> => {
  const connected = new Set(
    connectedPageRefs(doc, canvasName, callerNodeId),
  );
  const pages = new Map<string, PagePolicy>();
  for (const node of doc.nodes) {
    if (!isPageNode(node) || node.type !== "link") continue;
    let pageRef: string | undefined;
    for (const candidate of connected) {
      const parsed = parseNodeRef(candidate);
      if (
        parsed.ok &&
        parsed.value.canvasName === canvasName &&
        parsed.value.nodeId === node.id
      ) {
        pageRef = candidate;
        break;
      }
    }
    if (pageRef === undefined) continue;
    const profile = node.ether?.browser?.profile;
    pages.set(pageRef, {
      pageRef,
      hostId: resolveNodeHostId(node),
      edgeAllowed: true,
      policyAllowed:
        resolveNodeHostId(node) === stationId &&
        profile !== undefined &&
        isValidProfileId(profile) &&
        classifyBrowserTarget(node.url).allowed,
    });
  }
  return pages;
};

/**
 * Target-side authority reconstructed from the Remote's current pulled
 * document for every signed request. No origin-supplied identity or host is
 * trusted: agentRef is only a bounded lookup hint while the envelope is being
 * verified, and the direct browser.automate edge + page host + URL/profile
 * policy are read from the local mirror. No target work executes until the
 * signature and the reconstructed policy both verify.
 */
export const makeStationBrowserTargetPolicy = (
  deps: StationBrowserTargetPolicyDeps,
) => {
  if (!canonicalStationId(deps.stationId)) {
    throw new Error("station browser target policy requires a canonical station id");
  }

  const inspect = async (
    request: StationBrowserRequest,
  ): Promise<RequestPolicy> => {
    const empty = emptyPolicy(request);
    if (
      request.targetStationId !== deps.stationId ||
      request.authority !== "agent-edge" ||
      request.agentRef === undefined
    ) {
      return empty;
    }
    const agent = parseNodeRef(request.agentRef);
    if (!agent.ok) return empty;
    let admitted = false;
    let doc: CanvasDoc | undefined;
    try {
      const [station, canvas] = await Promise.all([
        deps.admitStation(),
        deps.readCanvas(agent.value.canvasName),
      ]);
      admitted = station.ok;
      doc = canvas;
    } catch {
      return empty;
    }
    if (!admitted || !deps.browserReady() || doc === undefined) return empty;
    const caller = findNode(doc, agent.value.nodeId);
    if (caller === undefined || nodeKind(caller) !== "agent") return empty;
    return {
      ready: true,
      requestWire: empty.requestWire,
      pages: pagePolicy(
        doc,
        agent.value.canvasName,
        agent.value.nodeId,
        deps.stationId,
      ),
    };
  };

  const verification = async (
    request: StationBrowserRequest,
  ): Promise<StationBrowserVerificationContext> => {
    const policy = await inspect(request);
    const sameRequest = (candidate: StationBrowserRequest): boolean => {
      try {
        return canonicalStationBrowserJson(candidate) === policy.requestWire;
      } catch {
        return false;
      }
    };
    const eligible = (pageRef: string): boolean => {
      const page = policy.pages.get(pageRef);
      return page?.edgeAllowed === true &&
        page.policyAllowed &&
        page.hostId === deps.stationId;
    };
    const now = (deps.now ?? Date.now)();
    return {
      stationId: deps.stationId,
      now: Number.isSafeInteger(now) && now >= 0 ? now : 0,
      role: "remote",
      browserReady: policy.ready,
      resolvePage: (pageRef) => {
        const page = policy.pages.get(pageRef);
        return page === undefined
          ? undefined
          : {
              hostId: page.hostId,
              edgeAllowed: page.edgeAllowed,
              policyAllowed: page.policyAllowed,
            };
      },
      currentGeneration: (candidate) =>
        policy.ready && sameRequest(candidate)
          ? deps.currentGeneration(candidate)
          : undefined,
      allowAction: (candidate) => {
        if (!policy.ready || !sameRequest(candidate)) return false;
        if (candidate.pageRef !== undefined) {
          return eligible(candidate.pageRef);
        }
        return [...policy.pages.values()].some(
          (page) =>
            page.hostId === deps.stationId &&
            page.edgeAllowed &&
            page.policyAllowed,
        );
      },
    };
  };

  const discoverPages = async (
    request: StationBrowserRequest,
  ): Promise<ReadonlyArray<Readonly<{ pageRef: string; hostId: string }>>> => {
    const policy = await inspect(request);
    if (!policy.ready) return [];
    return [...policy.pages.values()]
      .filter(
        (page) =>
          page.hostId === deps.stationId &&
          page.edgeAllowed &&
          page.policyAllowed,
      )
      .map((page) => ({
        pageRef: page.pageRef,
        hostId: page.hostId,
      }))
      .sort((left, right) => left.pageRef.localeCompare(right.pageRef));
  };

  return Object.freeze({ verification, discoverPages });
};

export type StationBrowserTargetPolicy = ReturnType<
  typeof makeStationBrowserTargetPolicy
>;
