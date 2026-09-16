import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildNodeKindDoc, PORT_DESCRIPTIONS } from "../src/shared/junto-docs";

const readPadGuide = () =>
  readFile(new URL("../docs/pad.md", import.meta.url), "utf8");

describe("pad operator and agent docs", () => {
  it("docs node pad names the shipped ports and refusals", () => {
    const node = buildNodeKindDoc("pad")!;
    expect(node).toContain("pad.read");
    expect(node).toContain("pad.patch");
    expect(node).toContain(PORT_DESCRIPTIONS["pad.read"]);
    expect(node).toContain(PORT_DESCRIPTIONS["pad.patch"]);
    expect(node).toContain("junto pad read");
    expect(node).toContain("junto pad patch");
    expect(node).toContain("junto pad look-here");
    expect(node).toContain("junto pad tagged");
    expect(node).toContain("ink or image");
    expect(node).toContain("inbound actor");
    expect(node).not.toMatch(/\bVellum\b/);
  });

  it("docs/pad.md matches shipped ports, CLI verbs, and refusals", async () => {
    const guide = await readPadGuide();
    expect(guide).toContain("Junto pad");
    expect(guide).toContain("pad.read");
    expect(guide).toContain("pad.patch");
    for (const verb of ["read", "patch", "digest", "svg", "look-here", "get", "tagged"]) {
      expect(guide).toContain(`junto pad ${verb}`);
    }
    expect(guide).toContain("agents cannot upsert ink");
    expect(guide).toContain("agents cannot upsert images");
    expect(guide).toContain("is not an inbound actor on this pad");
    expect(guide).toContain("ScopeError");
    expect(guide).toContain("`v`");
    expect(guide).toContain("`p`");
    expect(guide).toContain("`i`");
    expect(guide).toContain("`d`");
    expect(guide).toContain("@");
    expect(guide).not.toContain("\u00b7");
    expect(guide).not.toMatch(/\bVellum\b/);
    expect(guide).not.toMatch(/\bPNG\b/);
    expect(guide).toContain("SVG + digest + look-here crop");
    expect(guide).toContain("local inverse patch — durable with the next editor write");
  });

  it("docs/pad-architecture.md product sentence matches shipped pad.read", async () => {
    const architecture = await readFile(
      new URL("../docs/pad-architecture.md", import.meta.url),
      "utf8",
    );
    expect(architecture).not.toMatch(/\bPNG\b/);
    expect(architecture).toContain("SVG + digest + look-here crop");
    expect(architecture).toContain("pad.read   → { revision, pad, digest, svg }");
    expect(architecture).toContain("local inverse patch — durable with the next editor write");
  });
});
