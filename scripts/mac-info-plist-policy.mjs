// macOS Info.plist privacy surface for the packaged app.
//
// Electron's template Info.plist declares camera, Bluetooth, audio-capture,
// and microphone purpose strings for every app built on it. Junto declares
// only the purpose strings for APIs it calls (docs/macos-privacy.md). The
// afterPack hook strips the rest before signing; the packaged-app audit
// refuses a bundle that still carries one.

/** Purpose strings the shipped app may declare. */
export const PERMITTED_USAGE_DESCRIPTIONS = Object.freeze([
  "NSMicrophoneUsageDescription",
]);

const USAGE_DESCRIPTION = /^NS[A-Za-z]+UsageDescription$/u;

/** Purpose-string keys present in `keys` that the app must not declare. */
export const unpermittedUsageDescriptions = (keys) =>
  keys
    .filter((key) => USAGE_DESCRIPTION.test(key))
    .filter((key) => !PERMITTED_USAGE_DESCRIPTIONS.includes(key))
    .sort();

// App Transport Security governs Foundation networking only (NSURLSession),
// not Chromium or Node traffic. In Junto its sole consumer is Squirrel.Mac,
// which installs updates by fetching from electron-updater's loopback proxy
// (http://127.0.0.1:<port>, electron-updater MacUpdater). electron-builder
// writes this exact dictionary for that path (app-builder-lib
// electronMac.js configureLocalhostAts, electron-builder#3377). Pin it so the
// dictionary cannot widen silently.
const LOOPBACK_EXCEPTION = Object.freeze({
  NSIncludesSubdomains: false,
  NSTemporaryExceptionAllowsInsecureHTTPLoads: true,
  NSTemporaryExceptionAllowsInsecureHTTPSLoads: false,
  NSTemporaryExceptionMinimumTLSVersion: "1.0",
  NSTemporaryExceptionRequiresForwardSecrecy: false,
});

export const EXPECTED_APP_TRANSPORT_SECURITY = Object.freeze({
  NSAllowsArbitraryLoads: true,
  NSAllowsLocalNetworking: true,
  NSExceptionDomains: Object.freeze({
    "127.0.0.1": LOOPBACK_EXCEPTION,
    localhost: LOOPBACK_EXCEPTION,
  }),
});

const canonical = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      )
    : value;

/** True when the ATS dictionary is exactly the loopback updater shape. */
export const isExpectedAppTransportSecurity = (value) =>
  JSON.stringify(canonical(value)) ===
  JSON.stringify(canonical(EXPECTED_APP_TRANSPORT_SECURITY));
