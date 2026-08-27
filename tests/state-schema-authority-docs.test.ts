import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_MIGRATIONS,
} from "../src/main/vellum/state/migrations";

const root = process.cwd();
const governingDocuments = [
  "AGENTS.md",
  "docs/security-doctrine.md",
  "docs/vellum-protocol.md",
  "docs/state-architecture.md",
] as const;

const publicMacosVersion = "0.1.14";
const publicMacosSchemaVersion = 18;

const registeredChain = STATE_SCHEMA_MIGRATIONS.map(
  ({ fromVersion, toVersion, name }) => ({
    fromVersion,
    toVersion,
    name,
  }),
);

const readDocument = (path: string): string =>
  readFileSync(join(root, path), "utf8");

const normalizeProse = (source: string): string =>
  source.replace(/\s+/g, " ").trim();

const enumeratedMigrationRows = (
  source: string,
): ReadonlyArray<{
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly name: string;
}> =>
  [...source.matchAll(
    /^\s*\|\s*`?(\d+)\s*(?:→|->)\s*(\d+)`?\s*\|\s*`?([a-z0-9-]+)`?\s*\|/gim,
  )].map((match) => ({
    fromVersion: Number(match[1]),
    toVersion: Number(match[2]),
    name: match[3],
  }));

describe("state schema documentation authority", () => {
  it("freezes schema 22 and its complete source migration chain", () => {
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(22);
    expect(
      registeredChain.map(({ fromVersion, toVersion }) => ({
        fromVersion,
        toVersion,
      })),
    ).toEqual(
      Array.from(
        { length: CURRENT_STATE_SCHEMA_VERSION - 1 },
        (_, index) => ({
          fromVersion: index + 1,
          toVersion: index + 2,
        }),
      ),
    );
    expect(registeredChain.slice(-3)).toEqual([
      {
        fromVersion: 19,
        toVersion: 20,
        name: "witness-every-projected-work-table",
      },
      {
        fromVersion: 20,
        toVersion: 21,
        name: "add-canvas-relational-authority",
      },
      {
        fromVersion: 21,
        toVersion: 22,
        name: "add-canvas-authoring-change-tail",
      },
    ]);
  });

  it.each(governingDocuments)(
    "%s distinguishes the current source/runtime head from the public package",
    (path) => {
      const prose = normalizeProse(readDocument(path));

      expect(prose).toContain(
        `The current source/runtime schema is version ${CURRENT_STATE_SCHEMA_VERSION}`,
      );
      expect(prose).toContain(
        `The public macOS ${publicMacosVersion} package remains historical evidence for schema version ${publicMacosSchemaVersion}; it does not define the current source/runtime head.`,
      );
      expect(prose).toContain(
        "The frozen `18 → 19`, `19 → 20`, and `20 → 21` migrations must never be edited, squashed, renumbered, or reused.",
      );
      expect(prose).toContain(
        `The next schema change must append \`${CURRENT_STATE_SCHEMA_VERSION} → ${CURRENT_STATE_SCHEMA_VERSION + 1}\`.`,
      );
    },
  );

  it.each(governingDocuments)(
    "%s has no stale numeric current-schema declaration",
    (path) => {
      const prose = normalizeProse(readDocument(path));
      const declarations = [
        /\bcurrent(?: source\/runtime| local| SQLite)? schema is version (\d+)\b/gi,
        /\bschema version (\d+) is current\b/gi,
        /\bversion (\d+) is current through\b/gi,
      ];

      for (const declaration of declarations) {
        for (const match of prose.matchAll(declaration)) {
          expect(
            Number(match[1]),
            `${path} has stale declaration: ${match[0]}`,
          ).toBe(CURRENT_STATE_SCHEMA_VERSION);
        }
      }
    },
  );

  it("requires any retained migration table to equal the source registry", () => {
    for (const path of governingDocuments) {
      const rows = enumeratedMigrationRows(readDocument(path));
      if (rows.length > 0) {
        expect(rows, `${path} duplicates an incomplete migration chain`).toEqual(
          registeredChain,
        );
      }
    }
  });
});
