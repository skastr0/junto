/*
 * Electron -r preload, executed before the product main module. Constrain
 * only this test process: loopback and Unix sockets keep the renderer and
 * local control planes available. Chromium HTTP uses the harness server as
 * a rejecting proxy (configured by launch.ts), including native net.fetch.
 */
"use strict";

const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const { app } = require("electron");

// Production deliberately bypasses inherited proxies. This harness owns a
// rejecting loopback proxy solely to simulate an unavailable external network;
// retain it for this process without changing production's direct-network rule.
const appendSwitch = app.commandLine.appendSwitch.bind(app.commandLine);
app.commandLine.appendSwitch = (name, value) => {
  if (name === "no-proxy-server") return;
  if (value === undefined) appendSwitch(name);
  else appendSwitch(name, value);
};

const loopback = (host) =>
  host === undefined ||
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "[::1]";

const offline = () => Object.assign(new Error("E2E external network is offline"), {
  code: "ENETUNREACH",
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

globalThis.__vellumCommandOfflineHarness = true;
