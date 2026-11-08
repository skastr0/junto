/*
 * Electron -r preload, executed before the product main module. Constrain
 * only this test process: loopback and Unix sockets keep the renderer and
 * local control planes available. Chromium requests are rejected at each
 * session's request boundary, including native net.fetch.
 */
"use strict";

const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const { app } = require("electron");

const loopback = (host) =>
  host === undefined ||
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "[::1]";

const offline = () => Object.assign(new Error("E2E external network is offline"), {
  code: "ENETUNREACH",
});

// Register before app readiness, so the first request is already constrained.
// Product proxy configuration cannot undo this independent request boundary.
app.on("session-created", (session) => {
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !loopback(url.hostname) });
  });
});

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node's createConnection may pass its normalized [options, callback] tuple.
  const input = Array.isArray(args[0]) ? args[0] : args;
  const target = input[0];
  if (typeof target === "object" && target !== null) {
    const unixSocket = typeof target.path === "string" && target.path.length > 0;
    if (!unixSocket && !loopback(target.host)) throw offline();
  } else if (typeof target === "number" || /^\d+$/u.test(String(target))) {
    if (typeof input[1] === "string" && !loopback(input[1])) throw offline();
  } else if (typeof target !== "string") {
    throw offline();
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports();

const fetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!loopback(url.hostname)) throw offline();
  return fetch(input, init);
};

globalThis.__juntoOfflineHarness = true;
