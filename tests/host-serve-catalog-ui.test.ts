import { describe, expect, it } from "vitest";
import { listNamedServices, parseTailscaleServeStatus } from "../src/shared/tailscale-serve";

/**
 * UI row model contract: Settings → Hosts Services list shows named SVCs first,
 * then machine web roots, then TCP forwards — same order as HostServeCatalog.
 */
describe("HostServeCatalog UI row model", () => {
  const fixture = {
    TCP: {
      "8090": { TCPForward: "127.0.0.1:5175" },
    },
    Web: {
      "remote-a.tail.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:6167" } },
      },
    },
    Services: {
      "svc:booth-control": {
        Web: {
          "booth-control.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:5175" } },
          },
        },
      },
      "svc:quasar": {
        Web: {
          "quasar.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:7180" } },
          },
        },
      },
    },
  };

  it("named services are openable with public https urls", () => {
    const cat = parseTailscaleServeStatus(fixture, {
      hostId: "remote-a",
      hostBase: "remote-a.tail.ts.net",
    });
    const services = listNamedServices(cat);
    expect(services.map((s) => s.label).sort()).toEqual(["booth-control", "quasar"]);
    for (const s of services) {
      expect(s.publicUrl?.startsWith("https://")).toBe(true);
    }
  });

  it("forwards and web roots remain available as secondary open targets", () => {
    const cat = parseTailscaleServeStatus(fixture, {
      hostId: "remote-a",
      hostBase: "remote-a.tail.ts.net",
    });
    const forwards = cat.entries.filter((e) => e.kind === "tcp-forward" && e.publicUrl);
    const web = cat.entries.filter((e) => e.kind === "web" && e.path === "/");
    expect(forwards[0]?.publicUrl).toContain(":8090");
    expect(web[0]?.publicUrl).toContain("remote-a.tail.ts.net");
  });
});
