import { randomBytes } from "node:crypto";
import { CONTENT_PROTOCOL_SCHEME } from "@shared/content-url";

/**
 * A video at a web address an agent named, played through the app.
 *
 * The address is untrusted, so the player never gets it. When the operator
 * presses play, main hands the player an address of the app's own
 * (`junto-content://remote/<token>`) and fetches the real one itself, a
 * range at a time as the player asks. That keeps three promises:
 *
 * - nothing is fetched before the operator presses play: there is no token
 *   until then, and a token only ever names the address that was shown;
 * - the app never follows the address anywhere else: a redirect to another
 *   origin is refused, and one within the same origin is followed by hand;
 * - the page learns nothing about the address but what plays: only the
 *   headers a player needs come back.
 *
 * Only GET and HEAD are sent, with no cookies and no credentials.
 */

export const REMOTE_VIDEO_HOST = "remote";

const MAX_OPEN = 64;
const MAX_HOPS = 5;
const PASSED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const refuse = (status: number, reason: string, method: string): Response =>
  new Response(method === "HEAD" ? null : `${reason}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });

export const createRemoteVideos = (fetchImpl: Fetch) => {
  /** Token to the one address it plays. Oldest first. */
  const open = new Map<string, string>();

  return {
    /** The operator pressed play on this address: the app's own address for it. */
    open(url: string): string {
      const token = randomBytes(16).toString("hex");
      open.set(token, url);
      for (const stale of open.keys()) {
        if (open.size <= MAX_OPEN) break;
        open.delete(stale);
      }
      return `${CONTENT_PROTOCOL_SCHEME}://${REMOTE_VIDEO_HOST}/${token}`;
    },

    /** Answer a request for one of the app's remote addresses; undefined when it is not one. */
    handle(request: Request): Promise<Response> | undefined {
      let asked: URL;
      try {
        asked = new URL(request.url);
      } catch {
        return undefined;
      }
      if (asked.protocol !== `${CONTENT_PROTOCOL_SCHEME}:` || asked.hostname !== REMOTE_VIDEO_HOST) return undefined;
      return (async () => {
        const { method } = request;
        if (method !== "GET" && method !== "HEAD") return refuse(405, "method not allowed", method);
        const target = open.get(asked.pathname.replace(/^\/+/u, ""));
        if (target === undefined) return refuse(404, "this video was not opened", method);
        const origin = new URL(target).origin;
        const range = request.headers.get("range");
        let url = target;
        try {
          for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
            const upstream = await fetchImpl(url, {
              method,
              redirect: "manual",
              credentials: "omit",
              headers: range === null ? {} : { Range: range },
              signal: request.signal,
            });
            if (upstream.status >= 300 && upstream.status < 400) {
              const location = upstream.headers.get("location");
              const next = location === null ? undefined : new URL(location, url);
              await upstream.body?.cancel().catch(() => undefined);
              // Never anywhere else: the same origin, or nothing.
              if (next === undefined || next.origin !== origin) {
                return refuse(502, `the address sends the player to another site${next ? ` (${next.host})` : ""}; not followed`, method);
              }
              url = next.href;
              continue;
            }
            if (upstream.status !== 200 && upstream.status !== 206) {
              await upstream.body?.cancel().catch(() => undefined);
              return refuse(502, `the address answered ${String(upstream.status)}`, method);
            }
            const headers = new Headers({
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
              "Access-Control-Allow-Origin": "*",
              "Cross-Origin-Resource-Policy": "cross-origin",
            });
            for (const name of PASSED_HEADERS) {
              const value = upstream.headers.get(name);
              if (value !== null) headers.set(name, value);
            }
            return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
          }
          return refuse(502, "the address redirects too many times", method);
        } catch {
          return refuse(502, "the address could not be reached", method);
        }
      })();
    },
  };
};

export type RemoteVideos = ReturnType<typeof createRemoteVideos>;

/** The app's one registry: the play handler opens, the content protocol answers. */
export const remoteVideos: RemoteVideos = createRemoteVideos((url, init) => fetch(url, init));
