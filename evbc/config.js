/*
 * config.js — ALL tunable settings for the extension, in one place (SPEC §14, NFR-06).
 *
 * Who loads this file:
 *   - the service worker (background), via importScripts()
 *   - the popup and the review page, via a <script> tag
 *   - from M2 on, the content scripts in BOTH worlds (MAIN and ISOLATED)
 *
 * Because the MAIN-world copy runs inside the IRS page itself, this file must be
 * plain JavaScript: no chrome.* calls, no imports, nothing that can throw.
 *
 * Why `var` and the `globalThis.EVBC_CONFIG ||` guard (instead of the spec's `const`):
 *   if this file were ever injected twice into the same page, a second `const EVBC_CONFIG`
 *   would be a SyntaxError *inside IRS*. `var` can be declared twice harmlessly, and the
 *   guard keeps the first copy. Analogy: a hotel key card — if you ask for a second card for
 *   the same room you get a copy, not an error at the front desk.
 */
var EVBC_CONFIG = globalThis.EVBC_CONFIG || Object.freeze({
  // Pages where recording is allowed (FR-02).
  // MVP: IRS Live only. UAT + enoVestor Web are deferred; add them here AND in
  // manifest.json (host_permissions + content_scripts "matches").
  // "http://localhost/*" is ONLY for the local test fixture (test/fixture.html). A pattern
  // with no port matches every port, so localhost:8080 is covered.
  hostPatterns: ["https://irs.enovestor.com/*", "http://localhost/*"],

  // Optional. Known message/toast selectors can be added here later. Nothing depends on this (FR-19).
  extraMessageSelectors: [],

  screenshots: { maxCount: 10, jpegAboveBytes: 4_000_000, jpegQuality: 0.9, minBoxPx: 8, linkToMarkerWithinSec: 60 },
  snapshotMaxBytes: 20_000, // FR-25

  limits: { maxMinutes: 15, maxBytes: 5_000_000, maxEvents: 3000, maxBodyBytes: 20_000, maxTextBytes: 4_000 },

  // Masking (SPEC §9). NOTE: the key regex will be tightened in M3 (agreed: whole words /
  // camelCase parts only, so "mapping" or "shipping" are not masked because they contain "pin").
  maskHeaders: ["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token", "proxy-authorization"],
  maskKeyRegex: "pass(word)?|pwd|secret|token|otp|pin|api[-_]?key|refresh",

  correlationHeaders: ["x-request-id", "x-correlation-id", "traceparent", "request-id"],
});
