import { describe, expect, it } from "vitest";
import {
  listNamedServices,
  parseTailscaleServeStatus,
  preferredPublicUrlForLocalPorts,
} from "../src/shared/tailscale-serve";

/** Mirrors live remote-a `tailscale serve status --json`. */
const miniFixture = {
  TCP: {
    "443": { HTTPS: true },
    "8090": { TCPForward: "127.0.0.1:5175" },
    "8092": { TCPForward: "127.0.0.1:3213" },
    "8180": { TCPForward: "127.0.0.1:6180" },
  },
  Web: {
    "remote-a.example.ts.net:443": {
      Handlers: {
        "/": { Proxy: "http://127.0.0.1:6167" },
      },
    },
  },
  Services: {
    "svc:booth-control": {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "booth-control.example.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:5175" },
            "/booth": { Proxy: "http://127.0.0.1:5175" },
            "/booth-api": { Proxy: "http://127.0.0.1:3213" },
          },
        },
      },
    },
    "svc:quasar": {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "quasar.example.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:7180" },
          },
        },
      },
    },
    "svc:tower-control": {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "tower-control.example.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:5173" },
            "/tower-api": { Proxy: "http://127.0.0.1:3212" },
          },
        },
      },
    },
  },
};

describe("tailscale-serve parse", () => {
  it("parses SVCs, machine web, and TCP forwards", () => {
    const cat = parseTailscaleServeStatus(miniFixture, {
      hostId: "remote-a",
      hostBase: "remote-a.example.ts.net",
    });
    expect(cat.hostId).toBe("remote-a");
    const svcs = cat.entries.filter((e) => e.kind === "svc");
    expect(svcs.some((e) => e.publicUrl?.includes("booth-control"))).toBe(true);
    expect(svcs.some((e) => e.publicUrl?.includes("quasar"))).toBe(true);
    expect(svcs.some((e) => e.publicUrl?.includes("tower-control"))).toBe(true);

    const web = cat.entries.filter((e) => e.kind === "web");
    expect(web.some((e) => e.localPort === 6167)).toBe(true);

    const tcp = cat.entries.filter((e) => e.kind === "tcp-forward");
    expect(tcp.find((e) => e.publicPort === 8090)?.localPort).toBe(5175);
    expect(tcp.find((e) => e.publicPort === 8090)?.publicUrl).toBe(
      "http://remote-a.example.ts.net:8090",
    );
  });

  it("lists one root row per named SVC", () => {
    const cat = parseTailscaleServeStatus(miniFixture, { hostId: "remote-a" });
    const named = listNamedServices(cat);
    const labels = named.map((e) => e.label).sort();
    expect(labels).toEqual(["booth-control", "quasar", "tower-control"]);
  });
});

describe("tailscale-serve port join", () => {
  const cat = parseTailscaleServeStatus(miniFixture, {
    hostId: "remote-a",
    hostBase: "remote-a.example.ts.net",
  });

  it("prefers svc https root over tcp-forward for same local port", () => {
    const hit = preferredPublicUrlForLocalPorts(cat, [5175]);
    expect(hit?.url).toBe("https://booth-control.example.ts.net");
    expect(hit?.entry.kind).toBe("svc");
  });

  it("joins tower local 5173 to tower-control SVC", () => {
    const hit = preferredPublicUrlForLocalPorts(cat, [5173]);
    expect(hit?.url).toBe("https://tower-control.example.ts.net");
  });

  it("joins quasar 7180", () => {
    const hit = preferredPublicUrlForLocalPorts(cat, [7180]);
    expect(hit?.url).toBe("https://quasar.example.ts.net");
  });

  it("falls back to tcp-forward when no svc", () => {
    const hit = preferredPublicUrlForLocalPorts(cat, [6180]);
    expect(hit?.url).toBe("http://remote-a.example.ts.net:8180");
    expect(hit?.entry.kind).toBe("tcp-forward");
  });

  it("returns undefined when no match", () => {
    expect(preferredPublicUrlForLocalPorts(cat, [9999])).toBeUndefined();
  });
});
