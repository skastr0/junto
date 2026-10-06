// @vitest-environment jsdom
/**
 * The region environment screen against a scripted port: the forms per source
 * kind, a secret that goes to the store and is never held or shown again, the
 * resolved list, the sealed switch, folders, reordering and restart to apply.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnvSource, RegionEnvironment, SourceReport } from "../src/renderer/lib/region-environment";
import { makeFakeRegionEnvironmentPort } from "./helpers/fake-region-environment-port";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RegionEnvironmentScreen } = await import(
  "../src/renderer/components/region-environment/RegionEnvironmentScreen"
);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  browsed.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

/** The screen with the canvas stood in for by a variable: edits re-render it. */
/** A fake disk for the pickers: path to what is inside it. Never the real one. */
const DISK: Record<string, { parent?: string; entries: Array<[string, "file" | "directory"]> }> = {
  "~": { entries: [["work", "directory"], ["notes.txt", "file"]] },
  "/Users/op": { parent: "/Users", entries: [["work", "directory"], ["notes.txt", "file"]] },
  "/Users/op/work": { parent: "/Users/op", entries: [["acme", "directory"], [".env", "file"], ["README.md", "file"]] },
  "/Users/op/work/acme": { parent: "/Users/op/work", entries: [["secrets", "directory"]] },
  "/Users/op/work/acme/secrets": { parent: "/Users/op/work/acme", entries: [["API_KEY", "file"]] },
};
const browsed: string[] = [];
const readDirectory = async (path: string) => {
  browsed.push(path);
  const key = path === "~" ? "/Users/op" : path;
  const dir = DISK[key];
  if (!dir) throw new Error("ENOENT");
  return {
    root: key,
    ...(dir.parent ? { parent: dir.parent } : {}),
    entries: dir.entries.map(([name, kind]) => ({
      name,
      path: `${key}/${name}`,
      kind,
      size: 0,
      modifiedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
};

const mount = async (
  initial: RegionEnvironment | undefined,
  fake = makeFakeRegionEnvironmentPort(),
) => {
  const saved: Array<RegionEnvironment | undefined> = [];
  let ids = 0;
  const render = (environment: RegionEnvironment | undefined) => {
    act(() => {
      root.render(
        <RegionEnvironmentScreen
          regionId="inner"
          environment={environment}
          port={fake.port}
          newId={() => `new-${(ids += 1)}`}
          readDirectory={readDirectory}
          onChange={(next) => {
            saved.push(next);
            render(next);
          }}
        />,
      );
    });
  };
  render(initial);
  await flush();
  return { fake, saved, current: () => saved.at(-1) };
};

const q = <T extends Element = HTMLElement>(selector: string): T | null => host.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [...host.querySelectorAll<T>(selector)];
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};
const type = async (testId: string, value: string) => {
  const input = q<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submitForm = async () => {
  await click(q('[data-testid="region-env-save-source"]'));
};
const fieldKeys = () =>
  all<HTMLInputElement>('[data-testid^="region-env-field-"]').map((input) =>
    input.getAttribute("data-testid")!.replace("region-env-field-", ""),
  );

const keychain: EnvSource = { id: "k1", kind: "keychain", name: "OP_SERVICE_ACCOUNT_TOKEN", service: "op-service-account" };
const envFile: EnvSource = { id: "f1", kind: "envFile", path: "~/work/.env" };
const plain: EnvSource = { id: "v1", kind: "value", name: "AWS_REGION", value: "eu-west-1" };

const reported = (over: Partial<SourceReport>): SourceReport => ({
  regionId: "inner",
  regionLabel: "Payments",
  sourceId: "k1",
  kind: "keychain",
  names: ["OP_SERVICE_ACCOUNT_TOKEN"],
  status: "ok",
  required: false,
  ...over,
});

describe("adding a source", () => {
  it("opens on a kind and shows only that kind's fields, with examples", async () => {
    await mount(undefined);
    expect(host.textContent).toContain("Nothing yet.");
    await click(q('[data-testid="region-env-add-source"]'));
    // What the operator already has comes first.
    expect(q('[data-testid="region-env-form"]')?.getAttribute("data-kind")).toBe("keychain");
    expect(fieldKeys()).toEqual(["name", "service", "account"]);
    expect(q<HTMLInputElement>('[data-testid="region-env-field-service"]')?.placeholder).toBe("op-service-account");

    await click(q('[data-testid="region-env-kind-envFile"]'));
    expect(fieldKeys()).toEqual(["path"]);
    expect(q<HTMLInputElement>('[data-testid="region-env-field-path"]')?.placeholder).toBe("~/work/acme/.env");

    await click(q('[data-testid="region-env-kind-onepassword"]'));
    expect(fieldKeys()).toEqual(["name", "ref"]);
    expect(q<HTMLInputElement>('[data-testid="region-env-field-ref"]')?.placeholder).toMatch(/^op:\/\//);
  });

  it("the simplest case: an existing Keychain item becomes a variable for the region", async () => {
    const { saved } = await mount(undefined);
    await click(q('[data-testid="region-env-add-source"]'));
    await type("region-env-field-name", "OP_SERVICE_ACCOUNT_TOKEN");
    await type("region-env-field-service", "op-service-account");
    await submitForm();
    expect(saved).toEqual([
      { sources: [{ id: "new-1", kind: "keychain", name: "OP_SERVICE_ACCOUNT_TOKEN", service: "op-service-account" }] },
    ]);
    expect(q('[data-testid="region-env-form"]')).toBeNull();
    expect(all('[data-testid="region-env-source"]')).toHaveLength(1);
  });

  it("says what is missing next to the field, in red, and saves nothing", async () => {
    const { saved } = await mount(undefined);
    await click(q('[data-testid="region-env-add-source"]'));
    await submitForm();
    expect(saved).toEqual([]);
    const errors = all(".region-env__error").map((node) => node.textContent);
    expect(errors).toEqual(["Variable name is needed.", "Keychain item name is needed."]);
    expect(all('[role="alert"]').length).toBe(2);
  });

  it("cancel leaves the region as it was", async () => {
    const { saved } = await mount({ sources: [keychain] });
    await click(q('[data-testid="region-env-add-source"]'));
    await type("region-env-field-name", "X");
    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "cancel"));
    expect(saved).toEqual([]);
    expect(q('[data-testid="region-env-form"]')).toBeNull();
  });
});

describe("the fields people get wrong", () => {
  it("says what a Keychain source will look up, as it is typed", async () => {
    await mount(undefined);
    await click(q('[data-testid="region-env-add-source"]'));
    expect(q('[data-testid="region-env-lookup"]')).toBeNull();
    await type("region-env-field-service", "op-service-account");
    expect(q('[data-testid="region-env-lookup"]')?.textContent).toBe(
      'Looks for the Keychain item named "op-service-account", whatever its account.',
    );
    await type("region-env-field-account", "me@example.com");
    expect(q('[data-testid="region-env-lookup"]')?.textContent).toBe(
      'Looks for the Keychain item named "op-service-account" with account "me@example.com".',
    );
  });

  it("shows a command's arguments back exactly as they will run", async () => {
    const { saved } = await mount(undefined);
    await click(q('[data-testid="region-env-add-source"]'));
    await click(q('[data-testid="region-env-kind-command"]'));
    await type("region-env-field-name", "OP_SERVICE_ACCOUNT_TOKEN");
    await type("region-env-field-argv", 'security find-generic-password -s "My Item" -w');
    expect(all('[data-testid="region-env-arg"]').map((chip) => chip.textContent)).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "My Item",
      "-w",
    ]);
    await submitForm();
    expect(saved.at(-1)?.sources?.[0]).toMatchObject({
      kind: "command",
      argv: ["security", "find-generic-password", "-s", "My Item", "-w"],
    });
  });

  it("rejects a quote that is never closed, in plain words, and saves nothing", async () => {
    const { saved } = await mount(undefined);
    await click(q('[data-testid="region-env-add-source"]'));
    await click(q('[data-testid="region-env-kind-command"]'));
    await type("region-env-field-name", "TOKEN");
    await type("region-env-field-argv", 'security -s "My Item');
    expect(all('[data-testid="region-env-arg"]')).toEqual([]);
    expect(host.textContent).toContain("A double quote is opened and never closed.");
    await submitForm();
    expect(saved).toEqual([]);
  });

  it("editing a source that carries a host leaves the host on it", async () => {
    const pinned = { ...keychain, host: "studio" } as EnvSource;
    const { saved } = await mount({ sources: [pinned] });
    await click(q('[aria-label="Edit OP_SERVICE_ACCOUNT_TOKEN"]'));
    await type("region-env-field-service", "another-item");
    await submitForm();
    expect(saved.at(-1)?.sources).toEqual([{ ...pinned, service: "another-item" }]);
  });
});

describe("where a 1Password token comes from", () => {
  it("offers named sources in scope, the inherited ones labelled with their region", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      report: [
        reported({ regionId: "outer", regionLabel: "Company", sourceId: "o1", names: ["OP_SERVICE_ACCOUNT_TOKEN"] }),
      ],
    });
    await mount({ sources: [plain] }, fake);
    await click(q('[data-testid="region-env-add-source"]'));
    await click(q('[data-testid="region-env-kind-onepassword"]'));
    // The house select opens a menu; its options are listed once it is open.
    await click(q('[aria-label="Service account token from"]'));
    const options = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(options).toEqual([
      "What op is already signed in with",
      "AWS_REGION, this region",
      "OP_SERVICE_ACCOUNT_TOKEN, from Company",
    ]);
  });
});

describe("a 1Password source above its token", () => {
  const ref: EnvSource = { id: "r1", kind: "onepassword", name: "API_KEY", ref: "op://a/b/c", tokenFrom: "k1" };

  it("marks the row in red, and one click moves it below its token source", async () => {
    const { saved } = await mount({ sources: [ref, envFile, keychain] });
    const row = all('[data-testid="region-env-source"]')[0]!;
    expect(row.querySelector('[data-testid="region-env-token-problem"]')?.textContent).toBe(
      "Its token comes from OP_SERVICE_ACCOUNT_TOKEN, which is listed below it. The token source must come first.",
    );
    expect(row.querySelector('[data-testid="region-env-token-problem"]')?.className).toContain("region-env__error");
    await click(q('[data-testid="region-env-token-fix"]'));
    expect(saved.at(-1)?.sources?.map((source) => source.id)).toEqual(["f1", "k1", "r1"]);
    expect(q('[data-testid="region-env-token-problem"]')).toBeNull();
    expect(q('[data-testid="region-env-token-fix"]')).toBeNull();
  });

  it("says so when the token source is gone, with nothing to move", async () => {
    await mount({ sources: [ref] });
    expect(q('[data-testid="region-env-token-problem"]')?.textContent).toBe(
      "The source its token came from is gone. Edit it and pick another.",
    );
    expect(q('[data-testid="region-env-token-fix"]')).toBeNull();
  });

  it("is quiet when the token comes from an outer region", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      report: [reported({ regionId: "outer", regionLabel: "Company", sourceId: "k1" })],
    });
    await mount({ sources: [ref] }, fake);
    expect(q('[data-testid="region-env-token-problem"]')).toBeNull();
  });
});

describe("picking instead of typing", () => {
  it("an env file is picked as a file, starting at home", async () => {
    const { saved } = await mount(undefined);
    await click(q('[data-testid="region-env-add-source"]'));
    await click(q('[data-testid="region-env-kind-envFile"]'));
    await click(q('[data-testid="region-env-browse-path"]'));
    expect(q('[data-testid="region-env-browser"]')?.getAttribute("data-mode")).toBe("file");
    expect(browsed).toEqual(["~"]);
    const entry = (name: string) =>
      all('[data-testid="region-env-browser-entry"]').find((button) => button.textContent === name);
    // Folders first, then files; a folder opens, a file is the pick.
    expect(all('[data-testid="region-env-browser-entry"]').map((button) => button.textContent)).toEqual([
      "work",
      "notes.txt",
    ]);
    await click(entry("work"));
    expect(q('[data-testid="region-env-browser-root"]')?.textContent).toBe("/Users/op/work");
    await click(entry(".env"));
    expect(q('[data-testid="region-env-browser"]')).toBeNull();
    expect(q<HTMLInputElement>('[data-testid="region-env-field-path"]')?.value).toBe("/Users/op/work/.env");
    await submitForm();
    expect(saved.at(-1)).toEqual({ sources: [{ id: "new-1", kind: "envFile", path: "/Users/op/work/.env" }] });
  });

  it("a secrets folder is picked as a folder: files are not offered", async () => {
    await mount(undefined);
    await click(q('[data-testid="region-env-add-source"]'));
    await click(q('[data-testid="region-env-kind-secretsDir"]'));
    await type("region-env-field-path", "/Users/op/work/acme");
    await click(q('[data-testid="region-env-browse-path"]'));
    expect(q('[data-testid="region-env-browser"]')?.getAttribute("data-mode")).toBe("directory");
    // Browsing starts from what is already typed.
    expect(browsed).toEqual(["/Users/op/work/acme"]);
    await click(q('[data-testid="region-env-browser-entry"]'));
    expect(all('[data-testid="region-env-browser-entry"]')).toEqual([]);
    expect(host.textContent).toContain("No folders inside this one.");
    await click(q('[data-testid="region-env-browser-use"]'));
    expect(q<HTMLInputElement>('[data-testid="region-env-field-path"]')?.value).toBe("/Users/op/work/acme/secrets");
  });

  it("a folder for the folders list is picked and added in one step; typing still works", async () => {
    const { saved } = await mount(undefined);
    await click(q('[data-testid="region-env-browse-folder"]'));
    await click(all('[data-testid="region-env-browser-entry"]').find((button) => button.textContent === "work"));
    await click(q('[data-testid="region-env-browser-use"]'));
    expect(saved.at(-1)).toEqual({ folders: ["/Users/op/work"] });
    expect(q('[data-testid="region-env-browser"]')).toBeNull();
    await type("region-env-folder-input", "~/.config/gcloud");
    await click([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("add folder")));
    expect(saved.at(-1)).toEqual({ folders: ["/Users/op/work", "~/.config/gcloud"] });
  });

  it("goes up a folder, and says so when a folder cannot be opened", async () => {
    await mount(undefined);
    await click(q('[data-testid="region-env-add-source"]'));
    await click(q('[data-testid="region-env-kind-secretsDir"]'));
    await type("region-env-field-path", "/Users/op/work/acme");
    await click(q('[data-testid="region-env-browse-path"]'));
    await click(q('[aria-label="Up one folder"]'));
    expect(q('[data-testid="region-env-browser-root"]')?.textContent).toBe("/Users/op/work");
    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "close"));
    await type("region-env-field-path", "/nowhere");
    await click(q('[data-testid="region-env-browse-path"]'));
    expect(host.textContent).toContain("Junto could not open /nowhere.");
  });
});

describe("a secret kept by Junto", () => {
  const SECRET = "hunter2-very-secret";

  const addSecret = async (fake = makeFakeRegionEnvironmentPort()) => {
    const mounted = await mount(undefined, fake);
    await click(q('[data-testid="region-env-add-source"]'));
    await click(q('[data-testid="region-env-kind-secret"]'));
    await type("region-env-field-name", "GITHUB_TOKEN");
    await type("region-env-field-secretValue", SECRET);
    return mounted;
  };

  it("is typed masked and never offered back by the browser", async () => {
    await addSecret();
    const input = q<HTMLInputElement>('[data-testid="region-env-field-secretValue"]')!;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
  });

  it("goes to the store once, and only its id reaches the canvas", async () => {
    const { fake, saved } = await addSecret();
    await submitForm();
    expect(fake.calls.saveSecret).toEqual([{ regionId: "inner", name: "GITHUB_TOKEN", value: SECRET }]);
    expect(saved).toEqual([{ sources: [{ id: "new-1", kind: "secret", name: "GITHUB_TOKEN", secretId: "secret-1" }] }]);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });

  it("is gone from the page after save: not in any field, attribute or text", async () => {
    await addSecret();
    await submitForm();
    expect(host.innerHTML).not.toContain(SECRET);
    expect(all<HTMLInputElement>("input").some((input) => input.value === SECRET)).toBe(false);
    expect(host.textContent).toContain("Secret kept by Junto");
  });

  it("is never echoed back when the source is edited: the field is empty and says how to keep it", async () => {
    const { fake, saved } = await addSecret();
    await submitForm();
    await click(q('[aria-label="Edit GITHUB_TOKEN"]'));
    const input = q<HTMLInputElement>('[data-testid="region-env-field-secretValue"]')!;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("leave empty to keep the stored value");
    // Saving a rename with the field empty does not touch the store.
    await type("region-env-field-name", "GH_TOKEN");
    await submitForm();
    expect(fake.calls.saveSecret).toHaveLength(1);
    expect(saved.at(-1)).toEqual({ sources: [{ id: "new-1", kind: "secret", name: "GH_TOKEN", secretId: "secret-1" }] });
  });

  it("a new value replaces the one behind the same id", async () => {
    const { fake, saved } = await addSecret();
    await submitForm();
    await click(q('[aria-label="Edit GITHUB_TOKEN"]'));
    await type("region-env-field-secretValue", "rotated-value");
    await submitForm();
    expect(fake.calls.saveSecret.at(-1)).toEqual({
      regionId: "inner",
      name: "GITHUB_TOKEN",
      value: "rotated-value",
      secretId: "secret-1",
    });
    expect(saved.at(-1)?.sources?.[0]).toMatchObject({ secretId: "secret-1" });
    expect(host.innerHTML).not.toContain("rotated-value");
  });

  it("when the store refuses, the reason shows in red and nothing is written", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      saveSecret: { ok: false, message: "The Keychain is locked." },
    });
    const { saved } = await addSecret(fake);
    await submitForm();
    expect(saved).toEqual([]);
    expect(all(".region-env__error").map((node) => node.textContent)).toContain("The Keychain is locked.");
    expect(q('[data-testid="region-env-form"]')).not.toBeNull();
  });

  it("removing the source removes the stored secret with it", async () => {
    const { fake, saved } = await addSecret();
    await submitForm();
    await click(q('[aria-label="Remove GITHUB_TOKEN"]'));
    expect(saved.at(-1)).toBeUndefined();
    expect(fake.calls.removeSecret).toEqual(["secret-1"]);
  });

  it("removing any other kind of source touches no store", async () => {
    const { fake } = await mount({ sources: [keychain] });
    await click(q('[aria-label="Remove OP_SERVICE_ACCOUNT_TOKEN"]'));
    expect(fake.calls.removeSecret).toEqual([]);
  });
});

describe("the resolved list", () => {
  it("shows each name, its source and its region, and never a value", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      report: [reported({}), reported({ sourceId: "v1", kind: "value", names: ["AWS_REGION"] })],
    });
    await mount({ sources: [keychain, plain] }, fake);
    expect(fake.calls.report).toEqual(["inner"]);
    const rows = all('[data-testid="region-env-variable"]');
    expect(rows.map((row) => row.getAttribute("data-name"))).toEqual(["AWS_REGION", "OP_SERVICE_ACCOUNT_TOKEN"]);
    expect(rows[1]?.textContent).toContain("macOS Keychain item, this region");
    // The resolved list carries names only; a plain value is shown on its
    // own source row, where the operator typed it.
    expect(rows[0]?.textContent).not.toContain("eu-west-1");
  });

  it("shows an inherited variable as inherited from the outer region", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      report: [reported({ regionId: "outer", regionLabel: "Company", sourceId: "o1", names: ["ORG_TOKEN"] })],
    });
    await mount(undefined, fake);
    const row = q('[data-testid="region-env-variable"]')!;
    expect(row.textContent).toContain("macOS Keychain item, inherited from Company");
    expect(row.querySelector('[data-inherited="true"]')).not.toBeNull();
    expect(row.textContent).toContain("inherited");
  });

  it("strikes through a source that a later one overrides", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      report: [
        reported({ regionId: "outer", regionLabel: "Company", sourceId: "o1", status: "overridden" }),
        reported({}),
      ],
    });
    await mount({ sources: [keychain] }, fake);
    const row = q('[data-testid="region-env-variable"]')!;
    expect(row.querySelector("s")?.textContent).toBe("macOS Keychain item, inherited from Company");
    expect(row.textContent).toContain("macOS Keychain item, this region");
  });

  it("shows an error inline, in red, with the reason in plain words, on the variable and on its source", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      report: [reported({ status: "missing", reason: "No Keychain item named op-service-account." })],
    });
    await mount({ sources: [keychain] }, fake);
    const variable = q('[data-testid="region-env-variable"]')!;
    expect(variable.textContent).toContain("not set");
    const inline = [...variable.querySelectorAll(".region-env__error")].map((node) => node.textContent);
    expect(inline.join(" ")).toContain("No Keychain item named op-service-account.");
    const source = q('[data-testid="region-env-source"]')!;
    expect(source.querySelector(".region-env__error")?.textContent).toBe("No Keychain item named op-service-account.");
    expect(source.textContent).toContain("Missing");
  });

  it("says seats will not start when a required source fails", async () => {
    const fake = makeFakeRegionEnvironmentPort({ report: [reported({ status: "error", required: true })] });
    await mount({ sources: [{ ...keychain, required: true }] }, fake);
    expect(q('[data-testid="region-env-blocks-launch"]')?.textContent).toMatch(/will not start/);
  });

  it("lists a source that failed before it knew its names", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      report: [reported({ sourceId: "f1", kind: "envFile", names: [], status: "missing", reason: "No file at ~/work/.env." })],
    });
    await mount({ sources: [envFile] }, fake);
    expect(host.textContent).toContain("Env file in Payments: No file at ~/work/.env.");
  });

  it("says it is reading while main consults the stores, which can take seconds", async () => {
    const fake = makeFakeRegionEnvironmentPort({ report: [reported({})] });
    let answer!: () => void;
    const slow = {
      ...fake.port,
      report: (regionId: string) =>
        new Promise<Awaited<ReturnType<typeof fake.port.report>>>((resolve) => {
          answer = () => void fake.port.report(regionId).then(resolve);
        }),
    };
    await mount({ sources: [keychain] }, { ...fake, port: slow });
    expect(q('[data-testid="region-env-reading"]')?.textContent).toBe("Reading your stores.");
    expect(all('[data-testid="region-env-variable"]')).toEqual([]);
    await act(async () => answer());
    await flush();
    expect(q('[data-testid="region-env-reading"]')).toBeNull();
    expect(all('[data-testid="region-env-variable"]')).toHaveLength(1);
  });

  it("says so when the report cannot be read, and reads it again after every change", async () => {
    const fake = makeFakeRegionEnvironmentPort({ reportFailure: "Junto could not read the Keychain." });
    await mount({ sources: [keychain] }, fake);
    expect(host.textContent).toContain("Junto could not read the Keychain.");
    await click(q('[data-testid="region-env-sealed"]'));
    expect(fake.calls.report).toEqual(["inner", "inner"]);
  });
});

describe("sealed, folders and order", () => {
  it("the sealed switch saves at once and says what it means either way", async () => {
    const { saved } = await mount({ sources: [keychain] });
    expect(host.textContent).toContain("also get what the regions around it provide");
    await click(q('[data-testid="region-env-sealed"]'));
    expect(saved.at(-1)).toEqual({ sealed: true, sources: [keychain] });
    expect(host.textContent).toContain("Nothing comes in from the regions around it");
    await click(q('[data-testid="region-env-sealed"]'));
    expect(saved.at(-1)).toEqual({ sources: [keychain] });
  });

  it("adds and removes folders, and refuses one that is not a full path", async () => {
    const { saved } = await mount(undefined);
    await type("region-env-folder-input", "relative/dir");
    expect(host.textContent).toContain("Write the full path, or start it with ~/");
    await type("region-env-folder-input", "~/.config/gcloud/");
    await click([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("add folder")));
    expect(saved.at(-1)).toEqual({ folders: ["~/.config/gcloud"] });
    expect(all('[data-testid="region-env-folder"]').map((row) => row.textContent)).toEqual(["~/.config/gcloud"]);
    // Looked up by attribute value: jsdom's selector engine trips on "~".
    await click(all("button").find((button) => button.getAttribute("aria-label") === "Remove ~/.config/gcloud"));
    expect(saved.at(-1)).toBeUndefined();
  });

  it("reorders with the arrows, for a keyboard", async () => {
    const { saved } = await mount({ sources: [keychain, envFile, plain] });
    expect(q<HTMLButtonElement>('[aria-label="Move OP_SERVICE_ACCOUNT_TOKEN up"]')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[aria-label="Move AWS_REGION down"]')?.disabled).toBe(true);
    await click(q('[aria-label="Move AWS_REGION up"]'));
    expect(saved.at(-1)?.sources?.map((source) => source.id)).toEqual(["k1", "v1", "f1"]);
  });

  it("reorders by dragging a row onto another", async () => {
    const { saved } = await mount({ sources: [keychain, envFile, plain] });
    const rows = all('[data-testid="region-env-source"]');
    expect(rows.every((row) => row.getAttribute("draggable") === "true")).toBe(true);
    const drag = (type: string, target: Element) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "", dropEffect: "" } });
      target.dispatchEvent(event);
    };
    await act(async () => drag("dragstart", rows[0]!));
    await act(async () => drag("dragover", rows[2]!));
    await act(async () => drag("drop", rows[2]!));
    await flush();
    expect(saved.at(-1)?.sources?.map((source) => source.id)).toEqual(["f1", "v1", "k1"]);
  });
});

describe("restart to apply", () => {
  const seats = [
    { seatId: "seat-1", title: "planner", changed: ["OP_SERVICE_ACCOUNT_TOKEN"] },
    { seatId: "seat-2", title: "builder", changed: [] },
  ];

  it("is absent when every running seat already has the current environment", async () => {
    await mount({ sources: [keychain] });
    expect(q('[data-testid="region-env-stale"]')).toBeNull();
  });

  it("lists the seats that started before the change, with what changes, and restarts one", async () => {
    const fake = makeFakeRegionEnvironmentPort({ seats });
    await mount({ sources: [keychain] }, fake);
    const section = q('[data-testid="region-env-stale"]')!;
    expect(section.textContent).toContain("Restart to apply");
    expect(section.textContent).toContain("planner");
    expect(section.textContent).toContain("Changes on restart: OP_SERVICE_ACCOUNT_TOKEN");
    expect(section.textContent).toContain("Its environment changes on restart.");

    await click(all('[data-testid="region-env-restart"]')[0]);
    expect(fake.calls.restartSeat).toEqual(["seat-1"]);
    // The list is read again: the restarted seat is no longer stale.
    expect(q('[data-testid="region-env-stale"]')?.textContent).not.toContain("planner");
    expect(q('[data-testid="region-env-stale"]')?.textContent).toContain("builder");
  });

  it("lists a seat by its name on the canvas, not by the id the report carries", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      seats: [
        { seatId: "seat-1", title: "local:worker", changed: [] },
        { seatId: "seat-9", title: "local:unknown", changed: [] },
      ],
      restart: { ok: false, message: "The seat is mid-turn." },
    });
    act(() => {
      root.render(
        <RegionEnvironmentScreen
          regionId="inner"
          environment={{ sources: [keychain] }}
          port={fake.port}
          newId={() => "x"}
          onChange={() => {}}
          seatName={(seatId) => (seatId === "seat-1" ? "Worker" : undefined)}
        />,
      );
    });
    await flush();
    const rows = all(".region-env__stale-seat .region-env__source-title").map((node) => node.textContent);
    // A seat the canvas cannot name falls back to what the report says.
    expect(rows).toEqual(["Worker", "local:unknown"]);
    await click(all('[data-testid="region-env-restart"]')[0]);
    expect(q('[data-testid="region-env-stale"]')?.textContent).toContain("Worker: The seat is mid-turn.");
  });

  it("says why a restart did not happen", async () => {
    const fake = makeFakeRegionEnvironmentPort({ seats, restart: { ok: false, message: "The seat is mid-turn." } });
    await mount({ sources: [keychain] }, fake);
    await click(all('[data-testid="region-env-restart"]')[0]);
    expect(q('[data-testid="region-env-stale"]')?.textContent).toContain("planner: The seat is mid-turn.");
  });
});

describe("copy", () => {
  it("carries no middle dot anywhere on the screen", async () => {
    const fake = makeFakeRegionEnvironmentPort({
      report: [reported({}), reported({ regionId: "outer", regionLabel: "Company", sourceId: "o", status: "overridden" })],
      seats: [{ seatId: "s", title: "planner", changed: ["A"] }],
    });
    await mount({ sealed: true, sources: [keychain, envFile, plain], folders: ["~/x"] }, fake);
    await click(q('[data-testid="region-env-add-source"]'));
    expect(host.textContent).not.toContain("·");
  });
});
