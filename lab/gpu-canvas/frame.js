// Frame mode: the canvas is a page from another site, so Chromium gives it its
// own process. Input lands here directly and never waits for the host page.

import { bindInput } from "./input.js";
import { serveEngine } from "./port.js";

const query = new URLSearchParams(location.search);
const canvas = document.querySelector("canvas");
const handle = serveEngine((message) => parent.postMessage(message, "*"));
const size = () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio });

handle({ type: "init", canvas, scale: Number(query.get("scale") ?? 1), ...size() });
bindInput(canvas, handle);
addEventListener("resize", () => handle({ type: "resize", ...size() }));
addEventListener("message", (event) => handle(event.data));
