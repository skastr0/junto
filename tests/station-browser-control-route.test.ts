import { describe, expect, it } from "vitest";
import {
  dispatchControlRequest,
  makeControlHandlers,
} from "../src/main/vellum/browser/control";
import type { BrowserCapabilityRegistry } from "../src/main/vellum/browser/capabilities";
import type { BrowserSessionService } from "../src/main/vellum/browser/sessions";

const responseFrame = JSON.stringify({
  version: 1,
  requestId: "request-1",
  action: "doctor",
  ok: true,
  hostId: "remote-a",
  data: { role: "remote", browserReady: true },
  error: null,
});

const handlers = (handle: (frame: string, signal?: AbortSignal) => Promise<string>) =>
  makeControlHandlers({
    sessions: {} as BrowserSessionService,
    capabilities: {} as BrowserCapabilityRegistry,
    resolvePageTarget: async () => ({
      ok: false,
      code: "not_found",
      message: "not used",
    }),
    version: "test",
    listDocuments: async () => [],
    shotsDir: "/not-used",
    stationBrowserWrapper: { handle },
  });

describe("station browser owner-local control route", () => {
  it("relays one bounded frame through the injected signed wrapper without process capability input", async () => {
    const seen: string[] = [];
    const result = await dispatchControlRequest(
      handlers(async (frame) => {
        seen.push(frame);
        return responseFrame;
      }),
      "transport-token",
      {
        method: "POST",
        path: "/station",
        token: "transport-token",
        body: { frame: '{"signed":true}' },
      },
    );
    expect(result).toMatchObject({
      status: 200,
      envelope: {
        ok: true,
        data: { frame: expect.any(String) },
      },
    });
    expect(seen).toEqual(['{"signed":true}']);
    expect(JSON.parse((result.envelope as { data: { frame: string } }).data.frame))
      .toMatchObject({
        requestId: "request-1",
        hostId: "remote-a",
      });
  });

  it("rejects unknown fields, oversized frames, malformed wrapper output, and a missing route", async () => {
    for (const body of [
      { frame: "{}", extra: true },
      { frame: "x".repeat(65 * 1024) },
      { frame: 1 },
    ]) {
      const result = await dispatchControlRequest(
        handlers(async () => responseFrame),
        "transport-token",
        {
          method: "POST",
          path: "/station",
          token: "transport-token",
          body,
        },
      );
      expect(result).toMatchObject({
        status: 400,
        envelope: { ok: false, error: { _tag: "bad_request" } },
      });
    }

    const malformed = await dispatchControlRequest(
      handlers(async () => "not-json"),
      "transport-token",
      {
        method: "POST",
        path: "/station",
        token: "transport-token",
        body: { frame: "{}" },
      },
    );
    expect(malformed).toMatchObject({
      status: 403,
      envelope: { ok: false, error: { _tag: "forbidden" } },
    });

    const absent = makeControlHandlers({
      sessions: {} as BrowserSessionService,
      capabilities: {} as BrowserCapabilityRegistry,
      resolvePageTarget: async () => ({
        ok: false,
        code: "not_found",
        message: "not used",
      }),
      version: "test",
      listDocuments: async () => [],
      shotsDir: "/not-used",
    });
    const missing = await dispatchControlRequest(
      absent,
      "transport-token",
      {
        method: "POST",
        path: "/station",
        token: "transport-token",
        body: { frame: "{}" },
      },
    );
    expect(missing.status).toBe(404);
  });
});
