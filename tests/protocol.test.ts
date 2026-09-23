import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_BASE,
  DEFAULT_IFRAME_ORIGIN,
  ELEMENT_ERROR_CODES,
  isSafeRedirectUrl,
  parseHostMessage,
  sessionIdFromClientSecret,
} from "../src/protocol";

describe("protocol constants", () => {
  it("defaults the element origin to the BillKit-hosted js.billkit.eu", () => {
    expect(DEFAULT_IFRAME_ORIGIN).toBe("https://js.billkit.eu");
    expect(DEFAULT_API_BASE).toBe("https://api.billkit.eu");
  });
});

describe("parseHostMessage", () => {
  it("accepts every known host message type with a well-formed payload", () => {
    const wellFormed: unknown[] = [
      { type: "billkit:ready" },
      { type: "billkit:resize", height: 480 },
      { type: "billkit:loaded", sessionId: "cs_1" },
      { type: "billkit:change", complete: true },
      { type: "billkit:redirect", url: "https://www.mollie.com/3ds/x" },
      { type: "billkit:success", sessionId: "cs_1", paymentStatus: "paid" },
      { type: "billkit:error", message: "declined" },
    ];
    for (const message of wellFormed) {
      expect(parseHostMessage(message)).not.toBeNull();
    }
  });

  it("rejects unknown / malformed payloads", () => {
    expect(parseHostMessage(null)).toBeNull();
    expect(parseHostMessage(42)).toBeNull();
    expect(parseHostMessage("billkit:ready")).toBeNull();
    expect(parseHostMessage({})).toBeNull();
    expect(parseHostMessage({ type: 123 })).toBeNull();
    expect(parseHostMessage({ type: "evil:message" })).toBeNull();
    // A same-origin script trying to spoof a Stripe-shaped event.
    expect(parseHostMessage({ type: "stripe:success" })).toBeNull();
  });

  it("rejects a known type whose payload doesn't match it", () => {
    // The `HostMessage` union is only honest if the fields are checked.
    // Without this, a `billkit:success` carrying no `sessionId` still
    // reaches the tenant's `onSuccess` typed as `string`, and their first
    // property access throws from inside our callback.
    expect(parseHostMessage({ type: "billkit:success" })).toBeNull();
    expect(parseHostMessage({ type: "billkit:success", sessionId: "cs_1" })).toBeNull();
    expect(parseHostMessage({ type: "billkit:loaded" })).toBeNull();
    expect(parseHostMessage({ type: "billkit:change" })).toBeNull();
    expect(parseHostMessage({ type: "billkit:change", complete: "yes" })).toBeNull();
    expect(parseHostMessage({ type: "billkit:error" })).toBeNull();
    expect(parseHostMessage({ type: "billkit:resize" })).toBeNull();
    expect(parseHostMessage({ type: "billkit:resize", height: "480" })).toBeNull();
    expect(parseHostMessage({ type: "billkit:resize", height: Number.NaN })).toBeNull();
  });

  it("drops optional fields that are present but the wrong type", () => {
    expect(parseHostMessage({ type: "billkit:change", complete: true, method: 7 })).toEqual({
      type: "billkit:change",
      complete: true,
    });
    expect(parseHostMessage({ type: "billkit:error", message: "x", code: 7 })).toEqual({
      type: "billkit:error",
      message: "x",
    });
  });

  it("preserves the documented payment_declined code", () => {
    // The element's only way of telling the host "this attempt is over"
    // after a decline. Dropping the code would leave the merchant unable
    // to tell a decline from a load failure.
    expect(ELEMENT_ERROR_CODES).toContain("payment_declined");
    expect(
      parseHostMessage({
        type: "billkit:error",
        message: "Your bank didn't approve this payment.",
        code: "payment_declined",
      }),
    ).toEqual({
      type: "billkit:error",
      message: "Your bank didn't approve this payment.",
      code: "payment_declined",
    });
  });

  it("clamps an absurd resize height instead of applying it", () => {
    // Unbounded height is a layout DoS on the merchant's page; dropping the
    // message instead would wedge the element at its initial size.
    expect(parseHostMessage({ type: "billkit:resize", height: 10_000_000 })).toEqual({
      type: "billkit:resize",
      height: 5000,
    });
  });

  it("parses a redirect by SHAPE only, leaving the scheme to handleRedirect", () => {
    // Deliberately NOT a scheme check. This used to call
    // `isSafeRedirectUrl` and return null for anything else, which made
    // the documented `onError({ code: "unsafe_redirect" })` unreachable:
    // the refusal branch in `handleRedirect` never ran, and the merchant
    // got a "dropped a malformed message" logger line instead, on the
    // one event that is a security refusal rather than a version skew.
    //
    // The guarantee did not move: `handleRedirect` re-checks immediately
    // before `location.assign`, and `checkout-element.test.ts` pins that
    // none of these ever reach it.
    for (const url of [
      "javascript:alert(document.domain)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "/relative/path",
    ]) {
      expect(parseHostMessage({ type: "billkit:redirect", url })).toEqual({
        type: "billkit:redirect",
        url,
      });
    }
    // A non-string or empty url is still not a message at all.
    for (const url of ["", 42, null, undefined, {}]) {
      expect(parseHostMessage({ type: "billkit:redirect", url })).toBeNull();
    }
    expect(parseHostMessage({ type: "billkit:redirect", url: "https://mollie.com/x" })).toEqual({
      type: "billkit:redirect",
      url: "https://mollie.com/x",
    });
  });

  it("carries the codes the element can emit", () => {
    // The element emits five, and `ELEMENT_ERROR_CODES` listed two of
    // them, so three real outcomes (`no_payment_methods`,
    // `missing_session_id`, `missing_client_secret`) reached merchants
    // as codes documented nowhere.
    expect([...ELEMENT_ERROR_CODES]).toEqual([
      "payment_declined",
      "element_crashed",
      "no_payment_methods",
      "missing_session_id",
      "missing_client_secret",
    ]);
  });
});

describe("isSafeRedirectUrl", () => {
  it("accepts http and https only", () => {
    expect(isSafeRedirectUrl("https://www.mollie.com/checkout/x")).toBe(true);
    expect(isSafeRedirectUrl("http://localhost:3000/return")).toBe(true);
    expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("data:text/html,x")).toBe(false);
    expect(isSafeRedirectUrl("not a url")).toBe(false);
    expect(isSafeRedirectUrl(undefined)).toBe(false);
  });
});

describe("sessionIdFromClientSecret", () => {
  it("parses the session id from a Stripe-shaped secret", () => {
    expect(sessionIdFromClientSecret("cs_test_abc123_secret_r4nd0m")).toBe("cs_test_abc123");
  });

  it("splits on the first delimiter", () => {
    // A random tail that itself contains the delimiter must not confuse it.
    expect(sessionIdFromClientSecret("cs_x_secret_a_secret_b")).toBe("cs_x");
  });

  it("returns null for a malformed secret", () => {
    expect(sessionIdFromClientSecret("no-delimiter-here")).toBeNull();
    expect(sessionIdFromClientSecret("_secret_leading")).toBeNull();
  });
});
