/**
 * Pad agent refusal e2e: a process-bound mock seat pad.patch of ink or
 * image is InputError. No real Claude, Codex, or Grok.
 */
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchVellum } from "../harness/launch";
import { test } from "@playwright/test";

const CANVAS = "pad-agent-refusal";
const PAD_ID = "pad-1";
const SEAT_ID = "seat";

const MOCK_CODEX = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const inbox = process.env.PAD_E2E_INBOX;
const outbox = process.env.PAD_E2E_OUTBOX;
const workHome =
  process.env.JUNTO_WORK_HOME ||
  path.join(process.env.HOME || "", ".junto", "work");
const sock = path.join(workHome, "control.sock");
const tokPath = path.join(workHome, "token");

const call = (op, args) =>
  new Promise((resolve, reject) => {
    let token;
    try {
      token = fs.readFileSync(tokPath, "utf8").trim();
    } catch (error) {
      reject(error);
      return;
    }
    const socket = net.createConnection({ path: sock });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("work call timed out"));
    }, 15_000);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ token, op, args }) + "\\n");
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buf.subarray(0, nl).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const loop = async () => {
  if (!inbox || !outbox || !fs.existsSync(inbox)) return;
  try {
    const job = JSON.parse(fs.readFileSync(inbox, "utf8"));
    fs.unlinkSync(inbox);
    const result = await call(job.op, job.args);
    fs.writeFileSync(outbox, JSON.stringify(result));
  } catch (error) {
    try {
      fs.writeFileSync(
        outbox,
        JSON.stringify({
          ok: false,
          error: { type: "InternalError", message: String(error && error.message ? error.message : error) },
        }),
      );
    } catch {
      // ignore
    }
  }
};
setInterval(() => {
  void loop();
}, 100);
`;

type WorkEnvelope =
  | { readonly ok: true; readonly data?: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly type: string; readonly message: string };
    };

const padNode = {
  id: PAD_ID,
  type: "text" as const,
  text: "pad",
  x: 320,
  y: 40,
  width: 240,
  height: 120,
  ether: { entity: { kind: "pad" as const } },
};

const inkPatch = {
  op: "upsert" as const,
  layer: "ink" as const,
  ink: {
    id: "agent-ink",
    z: 0,
    color: "#fff",
    width: 2,
    points: [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
    ],
  },
};

const imagePatch = {
  op: "upsert" as const,
  layer: "image" as const,
  image: {
    id: "agent-image",
    x: 0,
    y: 0,
    w: 12,
    h: 12,
    z: 0,
    ref: {
      sha256: "a".repeat(64),
      byteLength: 4,
      mediaType: "image/png",
    },
  },
};

const e2ePath = (mockDir: string): string => {
  const fakes = join(process.cwd(), "e2e/fakes/bin");
  const nodeDir = dirname(process.execPath);
  return `${mockDir}:${fakes}:${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`;
};

const callSeat = async (
  inbox: string,
  outbox: string,
  op: string,
  args?: unknown,
): Promise<WorkEnvelope> => {
  await unlink(outbox).catch(() => undefined);
  await writeFile(inbox, JSON.stringify({ op, args }), "utf8");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(outbox, "utf8");
      await unlink(outbox).catch(() => undefined);
      return JSON.parse(raw) as WorkEnvelope;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`seat work ${op} produced no envelope`);
};

test("pad agent refusal: mock seat pad.patch ink and image are InputError", async () => {
  const mockDir = await mkdtemp(join(tmpdir(), "junto-pad-seat-"));
  const inbox = join(mockDir, "inbox.json");
  const outbox = join(mockDir, "outbox.json");
  const mockBin = join(mockDir, "codex");
  await writeFile(mockBin, MOCK_CODEX, "utf8");
  await chmod(mockBin, 0o755);

  const seatNode = agentTextNode({
    id: SEAT_ID,
    key: "local:pad-refuse",
    label: "seat",
    x: 40,
    y: 40,
  });
  const vellumCommand = await launchVellum({
    extraEnv: {
      PATH: e2ePath(mockDir),
      PAD_E2E_INBOX: inbox,
      PAD_E2E_OUTBOX: outbox,
    },
    seedCanvases: {
      [CANVAS]: canvasDoc(
        [seatNode, padNode],
        [{ id: "e-seat-pad", fromNode: SEAT_ID, toNode: PAD_ID }],
      ),
    },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          page.evaluate(() => typeof window.vellumCommand?.workPadRead === "function"),
        { timeout: 30_000 },
      )
      .toBe(true);

    const pause = page.getByTestId("factory-pause");
    await expect(pause).toBeVisible({ timeout: 30_000 });
    if ((await pause.getAttribute("data-pause-state")) !== "playing") {
      await pause.click();
      const confirm = page.getByTestId("first-play-confirm");
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.getByRole("button", { name: /play/i }).click();
      }
      await expect(pause).toHaveAttribute("data-pause-state", "playing");
    }

    const node = page.locator(`.react-flow__node[data-id="${SEAT_ID}"]`);
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.click();
    const openTerminal = page.getByRole("button", { name: "Open terminal" });
    if (await openTerminal.isVisible().catch(() => false)) {
      await openTerminal.click();
    } else {
      await node.dblclick();
    }

    const occupySeat = () =>
      page.evaluate(
        async ([canvas, node]) => {
          const api = window.vellumCommand!;
          if (typeof api.terminalCreate !== "function") {
            throw new Error("terminalCreate missing");
          }
          await api.terminalCreate({ node, canvasName: canvas });
        },
        [CANVAS, seatNode] as const,
      );

    await occupySeat().catch(() => undefined);

    await expect
      .poll(async () => {
        const ping = await callSeat(inbox, outbox, "ping");
        if (ping.ok) return true;
        await occupySeat().catch(() => undefined);
        return false;
      }, { timeout: 30_000 })
      .toBe(true);

    const ink = await callSeat(inbox, outbox, "pad.patch", {
      target: PAD_ID,
      patches: [inkPatch],
    });
    expect(ink.ok).toBe(false);
    if (ink.ok) return;
    expect(ink.error.type).toBe("InputError");
    expect(ink.error.message).toMatch(/ink/i);

    const image = await callSeat(inbox, outbox, "pad.patch", {
      target: PAD_ID,
      patches: [imagePatch],
    });
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.error.type).toBe("InputError");
    expect(image.error.message).toMatch(/image/i);

    const read = await page.evaluate(
      ([canvas, id]) => window.vellumCommand!.workPadRead(canvas, id),
      [CANVAS, PAD_ID] as const,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.pad.inks).toEqual([]);
    expect(read.data.pad.images).toEqual([]);
  } finally {
    await vellumCommand.close();
    await rm(mockDir, { recursive: true, force: true });
  }
});
