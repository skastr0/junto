/**
 * A video at a web address, played through the app: main fetches it, a range
 * at a time, only for an address it opened, and never anywhere else.
 */
import { describe, expect, it } from "vitest";
import { createRemoteVideos } from "../src/main/junto/preview/remote-video";

type Call = { readonly url: string; readonly method: string; readonly range: string | null; readonly redirect: string | undefined; readonly credentials: string | undefined };

const withFetch = (answer: (url: string) => Response) => {
  const calls: Call[] = [];
  const videos = createRemoteVideos(async (url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      range: new Headers(init.headers).get("range"),
      redirect: init.redirect,
      credentials: init.credentials,
    });
    return answer(url);
  });
  return { videos, calls };
};

const ask = (videos: ReturnType<typeof createRemoteVideos>, url: string, init?: RequestInit) =>
  videos.handle(new Request(url, init));

describe("remote video", () => {
  it("leaves every other address on the scheme alone", () => {
    const { videos, calls } = withFetch(() => new Response("x"));
    expect(ask(videos, `junto-content://object/${"a".repeat(64)}?byteLength=1&mediaType=video/mp4`)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("fetches nothing for an address nobody opened", async () => {
    const { videos, calls } = withFetch(() => new Response("x"));
    const response = await ask(videos, `junto-content://remote/${"0".repeat(32)}`)!;
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("plays an opened address through main: the range goes up, the player's headers come back, no credentials", async () => {
    const { videos, calls } = withFetch(
      () =>
        new Response("0123456789", {
          status: 206,
          headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-9/100", "Accept-Ranges": "bytes", "Set-Cookie": "a=b", Server: "nginx" },
        }),
    );
    const stream = videos.open("https://media.example.com/runs/onboarding.mp4?t=1");
    expect(stream).toMatch(/^junto-content:\/\/remote\/[a-f0-9]{32}$/);
    expect(stream).not.toContain("example.com");
    const response = await ask(videos, stream, { headers: { Range: "bytes=0-9" } })!;
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("0123456789");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 0-9/100");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("server")).toBeNull();
    expect(calls).toEqual([
      { url: "https://media.example.com/runs/onboarding.mp4?t=1", method: "GET", range: "bytes=0-9", redirect: "manual", credentials: "omit" },
    ]);
  });

  it("follows a redirect within the same origin by hand and refuses one to anywhere else", async () => {
    const same = withFetch((url) =>
      url.endsWith("/old.mp4")
        ? new Response(null, { status: 302, headers: { Location: "/new.mp4" } })
        : new Response("film", { status: 200, headers: { "Content-Type": "video/mp4" } }),
    );
    const moved = await ask(same.videos, same.videos.open("https://media.example.com/old.mp4"))!;
    expect(moved.status).toBe(200);
    expect(same.calls.map((call) => call.url)).toEqual(["https://media.example.com/old.mp4", "https://media.example.com/new.mp4"]);

    const away = withFetch(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.net/x.mp4" } }));
    const refused = await ask(away.videos, away.videos.open("https://media.example.com/old.mp4"))!;
    expect(refused.status).toBe(502);
    const said = await refused.text();
    expect(said).toContain("another site");
    // The other site's name does not cross to the page side either.
    expect(said).not.toContain("elsewhere");
    // The other site was never asked.
    expect(away.calls.map((call) => call.url)).toEqual(["https://media.example.com/old.mp4"]);

    // Another port or scheme of the same host is somewhere else too.
    const port = withFetch(() => new Response(null, { status: 301, headers: { Location: "http://media.example.com/old.mp4" } }));
    expect((await ask(port.videos, port.videos.open("https://media.example.com/old.mp4"))!).status).toBe(502);
    expect(port.calls).toHaveLength(1);
  });

  it("passes on only what says it is media: a web page at the address is refused, not served", async () => {
    for (const [type, status] of [["text/html; charset=utf-8", 502], ["application/json", 502], ["video/webm", 200], ["audio/mpeg", 200], ["application/octet-stream", 200]] as const) {
      const { videos } = withFetch(() => new Response("<script>x</script>", { status: 200, headers: { "Content-Type": type } }));
      const response = await ask(videos, videos.open("https://media.example.com/thing"))!;
      expect([type, response.status]).toEqual([type, status]);
      if (status === 502) expect(await response.text()).not.toContain("<script>");
    }
    const untyped = withFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    expect((await ask(untyped.videos, untyped.videos.open("https://media.example.com/thing"))!).status).toBe(502);
  });

  it("says so when the address does not answer with a file, and sends only GET and HEAD", async () => {
    const { videos, calls } = withFetch(() => new Response("no", { status: 403 }));
    const stream = videos.open("https://media.example.com/private.mp4");
    expect((await ask(videos, stream)!).status).toBe(502);
    expect((await ask(videos, stream, { method: "POST", body: "x" })!).status).toBe(405);
    expect(calls).toHaveLength(1);
  });
});
