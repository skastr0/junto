import { Effect, Result } from "effect";
import { isValidProfileId } from "@shared/browser";
import type { NodeRefKey } from "@shared/node-ref";
import { parseNodeRef } from "@shared/node-ref";
import { resolveNodeHostId } from "@shared/station";
import {
  resolveNodeRef,
  type CanvasNodeReader,
  type NodeRefResolutionError,
} from "../node-ref-resolver";

export interface ResolvedPageTarget {
  readonly ref: NodeRefKey;
  readonly nodeId: string;
  readonly hostId: string;
  readonly url: string;
  readonly profile: string;
}

export type PageTargetErrorCode = "invalid" | "not_found" | "failed";

export type PageTargetResult =
  | { readonly ok: true; readonly data: ResolvedPageTarget }
  | { readonly ok: false; readonly code: PageTargetErrorCode; readonly message: string };

export type PageTargetResolver = (ref: unknown) => Promise<PageTargetResult>;

const fail = (code: PageTargetErrorCode, message: string): PageTargetResult => ({
  ok: false,
  code,
  message,
});

const resolutionFailure = (error: NodeRefResolutionError): PageTargetResult => {
  switch (error._tag) {
    case "CanvasNotFound":
      return fail("not_found", `canvas not found for ${error.ref.canvasName}`);
    case "NodeNotFound":
      return fail("not_found", `page node not found for ${error.ref.nodeId}`);
    case "CanvasReadError":
      return fail("failed", "canvas could not be read");
    case "DuplicateNodeId":
      return fail("invalid", `page ref resolves to ${error.count} nodes`);
    case "NodeKindMismatch":
      return fail("invalid", "node ref does not identify a page");
    case "InvalidNodeRef":
      return fail("invalid", "node ref is invalid");
  }
};

/**
 * Resolve a locator against the current canvas document. The caller supplies
 * only the canonical ref; URL, profile, and display node id always come from
 * the uniquely resolved page link.
 */
export const makePageTargetResolver = (canvases: CanvasNodeReader): PageTargetResolver =>
  async (candidate) => {
    if (typeof candidate !== "string") return fail("invalid", "canonical page ref required");
    const parsed = parseNodeRef(candidate);
    if (!parsed.ok) return fail("invalid", parsed.error.message);

    try {
      const resolved = await Effect.runPromise(
        Effect.result(resolveNodeRef(canvases, parsed.success, { expectedEntityKind: "page" })),
      );
      if (Result.isFailure(resolved)) return resolutionFailure(resolved.failure);

      const node = resolved.success.node;
      if (node.type !== "link") return fail("invalid", "page node must be a link node");
      const profile = node.ether?.browser?.profile;
      if (profile === undefined || !isValidProfileId(profile)) {
        return fail("invalid", "page node must bind a valid browser profile");
      }
      return {
        ok: true,
        data: {
          ref: resolved.success.key,
          nodeId: node.id,
          hostId: resolveNodeHostId(node),
          url: node.url,
          profile,
        },
      };
    } catch {
      return fail("failed", "page ref resolution failed");
    }
  };
