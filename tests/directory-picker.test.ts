import { describe, expect, it } from "vitest";
import type { HostDirectorySnapshot } from "../src/shared/host-directory";
import {
  bestDirectoryCompletion,
  directoryFromDraft,
  joinHostPath,
  matchDirectoryEntries,
  parseDirectoryDraft,
  trimTrailingSlash,
} from "../src/renderer/lib/directory-picker";

const entry = (name: string, kind: "file" | "directory" = "directory") => ({
  name,
  path: `/Users/developer/${name}`,
  kind,
  size: 0,
  modifiedAt: "2026-07-30T00:00:00.000Z",
});

const entries = [
  entry(".config"),
  entry(".cache"),
  entry("Projects"),
  entry("Pictures"),
  entry("Downloads"),
  entry("project-notes.md", "file"),
];

const snapshot: HostDirectorySnapshot = {
  root: "/Users/developer",
  parent: "/Users",
  entries,
};

describe("parseDirectoryDraft", () => {
  it("reads a settled folder when the draft ends in a separator", () => {
    expect(parseDirectoryDraft("/Users/developer/")).toEqual({
      dir: "/Users/developer",
      query: "",
    });
  });

  it("treats the trailing segment as the filter", () => {
    expect(parseDirectoryDraft("/Users/developer/Pro")).toEqual({
      dir: "/Users/developer",
      query: "Pro",
    });
  });

  it("keeps the filesystem root addressable", () => {
    expect(parseDirectoryDraft("/Users")).toEqual({ dir: "/", query: "Users" });
  });

  it("filters in place when nothing names a parent", () => {
    expect(parseDirectoryDraft("Pro")).toEqual({ dir: "", query: "Pro" });
  });

  it("reads a bare home as a folder, not a filter", () => {
    expect(parseDirectoryDraft("~")).toEqual({ dir: "~", query: "" });
  });
});

describe("matchDirectoryEntries", () => {
  it("lists folders only, hiding dotfolders until asked for", () => {
    expect(matchDirectoryEntries(entries, "").map((e) => e.name)).toEqual([
      "Projects",
      "Pictures",
      "Downloads",
    ]);
  });

  it("surfaces dotfolders once the word reaches for one", () => {
    expect(matchDirectoryEntries(entries, ".c").map((e) => e.name)).toEqual([
      ".config",
      ".cache",
    ]);
  });

  it("matches case-insensitively, prefix hits first", () => {
    expect(matchDirectoryEntries(entries, "p").map((e) => e.name)).toEqual([
      "Projects",
      "Pictures",
    ]);
  });

  it("falls back to substring hits after prefix hits", () => {
    expect(matchDirectoryEntries(entries, "o").map((e) => e.name)).toEqual([
      "Projects",
      "Downloads",
    ]);
  });
});

describe("bestDirectoryCompletion", () => {
  it("suggests the folder the word can only mean", () => {
    expect(bestDirectoryCompletion(entries, "Pro")?.name).toBe("Projects");
  });

  it("suggests nothing while the word is still ambiguous", () => {
    expect(bestDirectoryCompletion(entries, "P")).toBeUndefined();
  });

  it("suggests nothing for a word that is already the folder", () => {
    expect(bestDirectoryCompletion(entries, "Projects")).toBeUndefined();
  });

  it("suggests nothing for an empty word", () => {
    expect(bestDirectoryCompletion(entries, "")).toBeUndefined();
  });

  it("never suggests a file", () => {
    expect(bestDirectoryCompletion(entries, "project-")).toBeUndefined();
  });
});

describe("directoryFromDraft", () => {
  it("selects the listing root", () => {
    expect(directoryFromDraft("/Users/developer/", snapshot)).toBe("/Users/developer");
  });

  it("selects a folder named outright", () => {
    expect(directoryFromDraft("/Users/developer/Projects", snapshot)).toBe(
      "/Users/developer/Projects",
    );
  });

  it("selects nothing while a word is still half-typed", () => {
    expect(directoryFromDraft("/Users/developer/Pro", snapshot)).toBeUndefined();
  });

  it("never selects a file", () => {
    expect(
      directoryFromDraft("/Users/developer/project-notes.md", snapshot),
    ).toBeUndefined();
  });
});

describe("path helpers", () => {
  it("joins without doubling the filesystem root separator", () => {
    expect(joinHostPath("/", "Users")).toBe("/Users");
    expect(joinHostPath("/Users", "developer")).toBe("/Users/developer");
  });

  it("keeps the filesystem root when trimming", () => {
    expect(trimTrailingSlash("/")).toBe("/");
    expect(trimTrailingSlash("/Users/developer/")).toBe("/Users/developer");
  });
});
