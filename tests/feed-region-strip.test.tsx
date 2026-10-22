// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FeedRegionChip } from "../src/renderer/lib/operator-feed";
import { FeedRegionStrip } from "../src/renderer/components/feed/FeedRegionStrip";

let root: Root;
let host: HTMLDivElement;

const chip = (path: ReadonlyArray<string>, count: number, color?: string): FeedRegionChip => ({
  key: path.join("\u0000"),
  path,
  label: path.at(-1) ?? "open field",
  outer: path.slice(0, -1),
  color,
  open: path.length === 0,
  count,
});

const junto = chip(["Junto"], 4);
const cli = chip(["Junto", "CLI"], 2, "6");
const open = chip([], 1);

const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("draws All first, then each chip with its outer regions, its name and its count", async () => {
  await act(async () => root.render(<FeedRegionStrip chips={[junto, cli, open]} chosen={undefined} total={5} onPick={() => {}} />));
  expect(radios().map((radio) => radio.getAttribute("aria-label"))).toEqual([
    "All regions, 5 waiting",
    "Junto, 4 waiting",
    "Junto > CLI, 2 waiting",
    "open field, 1 waiting",
  ]);
  expect(radios()[0]?.getAttribute("aria-checked")).toBe("true");
  const cliChip = radios()[2]!;
  expect(cliChip.querySelector(".feed-region-chip__outer")?.textContent).toBe("Junto > ");
  expect(cliChip.querySelector(".feed-region-chip__label")?.textContent).toBe("CLI");
  expect(cliChip.querySelector(".feed-region-chip__count")?.textContent).toBe("2");
  expect(radios()[3]?.getAttribute("data-open-field")).toBe("true");
});

it("picks a chip, and the picked chip again goes back to All", async () => {
  const onPick = vi.fn();
  await act(async () => root.render(<FeedRegionStrip chips={[junto, cli]} chosen={cli.key} total={5} onPick={onPick} />));
  expect(radios()[2]?.getAttribute("aria-checked")).toBe("true");
  await act(async () => radios()[1]!.click());
  expect(onPick).toHaveBeenLastCalledWith(junto);
  await act(async () => radios()[2]!.click());
  expect(onPick).toHaveBeenLastCalledWith(undefined);
  await act(async () => radios()[0]!.click());
  expect(onPick).toHaveBeenLastCalledWith(undefined);
});

it("is not drawn when there is one region and nothing picked, and shows no count at none", async () => {
  await act(async () => root.render(<FeedRegionStrip chips={[junto]} chosen={undefined} total={4} onPick={() => {}} />));
  expect(radios()).toHaveLength(0);
  const emptied = chip(["Junto", "CLI"], 0);
  await act(async () => root.render(<FeedRegionStrip chips={[emptied]} chosen={emptied.key} total={0} onPick={() => {}} />));
  expect(radios().map((radio) => radio.getAttribute("aria-label"))).toEqual(["All regions", "Junto > CLI"]);
  expect(host.querySelector(".feed-region-chip__count")).toBeNull();
});
