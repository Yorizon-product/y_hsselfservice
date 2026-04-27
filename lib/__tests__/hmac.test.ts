import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSignature, verifySignature, SIGNATURE_MAX_AGE_SECONDS } from "../hmac.ts";

const SECRET = "test-secret";
const METHOD = "POST";
const URL = "https://hsselfservice.cdit-dev.de/webhooks/hubspot";
const BODY = '[{"eventId":1,"subscriptionType":"company.propertyChange"}]';
// Use a fixed timestamp so we can pin "now" against it.
const NOW_S = 1_700_000_000;
const TS_MS = String(NOW_S * 1000);

/* computeSignature */

test("computeSignature is deterministic for the same inputs", () => {
  const a = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  const b = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  assert.equal(a, b);
  // base64 of a 32-byte sha256 is 44 chars (with =-padding).
  assert.equal(a.length, 44);
});

test("computeSignature differs when any input changes", () => {
  const base = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  assert.notEqual(base, computeSignature("other-secret", METHOD, URL, BODY, TS_MS));
  assert.notEqual(base, computeSignature(SECRET, "GET", URL, BODY, TS_MS));
  assert.notEqual(base, computeSignature(SECRET, METHOD, URL + "/x", BODY, TS_MS));
  assert.notEqual(base, computeSignature(SECRET, METHOD, URL, BODY + "x", TS_MS));
  assert.notEqual(base, computeSignature(SECRET, METHOD, URL, BODY, String(Number(TS_MS) + 1)));
});

test("computeSignature normalises method to upper-case", () => {
  assert.equal(
    computeSignature(SECRET, "post", URL, BODY, TS_MS),
    computeSignature(SECRET, "POST", URL, BODY, TS_MS)
  );
});

/* verifySignature */

test("verifySignature accepts a freshly-computed signature within the window", () => {
  const sig = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  assert.equal(
    verifySignature({
      secret: SECRET,
      method: METHOD,
      url: URL,
      body: BODY,
      signatureHeader: sig,
      timestampHeader: TS_MS,
      nowSeconds: NOW_S,
    }),
    true
  );
});

test("verifySignature rejects when the signature mismatches", () => {
  const sig = computeSignature("other-secret", METHOD, URL, BODY, TS_MS);
  assert.equal(
    verifySignature({
      secret: SECRET,
      method: METHOD,
      url: URL,
      body: BODY,
      signatureHeader: sig,
      timestampHeader: TS_MS,
      nowSeconds: NOW_S,
    }),
    false
  );
});

test("verifySignature rejects when the URL doesn't match what was signed", () => {
  const sig = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  assert.equal(
    verifySignature({
      secret: SECRET,
      method: METHOD,
      url: "https://attacker.example/webhooks/hubspot",
      body: BODY,
      signatureHeader: sig,
      timestampHeader: TS_MS,
      nowSeconds: NOW_S,
    }),
    false
  );
});

test("verifySignature rejects stale timestamps (> 5 minutes old)", () => {
  const sig = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  assert.equal(
    verifySignature({
      secret: SECRET,
      method: METHOD,
      url: URL,
      body: BODY,
      signatureHeader: sig,
      timestampHeader: TS_MS,
      nowSeconds: NOW_S + SIGNATURE_MAX_AGE_SECONDS + 1,
    }),
    false
  );
});

test("verifySignature accepts inside the skew window in either direction", () => {
  const sig = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  for (const skew of [-SIGNATURE_MAX_AGE_SECONDS, 0, SIGNATURE_MAX_AGE_SECONDS]) {
    assert.equal(
      verifySignature({
        secret: SECRET,
        method: METHOD,
        url: URL,
        body: BODY,
        signatureHeader: sig,
        timestampHeader: TS_MS,
        nowSeconds: NOW_S + skew,
      }),
      true,
      `expected acceptance at skew=${skew}s`
    );
  }
});

test("verifySignature accepts timestamps in seconds (not just ms)", () => {
  const tsSec = String(NOW_S);
  const sig = computeSignature(SECRET, METHOD, URL, BODY, tsSec);
  assert.equal(
    verifySignature({
      secret: SECRET,
      method: METHOD,
      url: URL,
      body: BODY,
      signatureHeader: sig,
      timestampHeader: tsSec,
      nowSeconds: NOW_S,
    }),
    true
  );
});

test("verifySignature rejects when headers are missing", () => {
  const sig = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  assert.equal(
    verifySignature({
      secret: SECRET,
      method: METHOD,
      url: URL,
      body: BODY,
      signatureHeader: null,
      timestampHeader: TS_MS,
      nowSeconds: NOW_S,
    }),
    false
  );
  assert.equal(
    verifySignature({
      secret: SECRET,
      method: METHOD,
      url: URL,
      body: BODY,
      signatureHeader: sig,
      timestampHeader: null,
      nowSeconds: NOW_S,
    }),
    false
  );
});

test("verifySignature rejects non-numeric timestamp header", () => {
  const sig = computeSignature(SECRET, METHOD, URL, BODY, TS_MS);
  assert.equal(
    verifySignature({
      secret: SECRET,
      method: METHOD,
      url: URL,
      body: BODY,
      signatureHeader: sig,
      timestampHeader: "not-a-number",
      nowSeconds: NOW_S,
    }),
    false
  );
});
