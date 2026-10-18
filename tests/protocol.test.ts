import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  protocolOf,
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
      { type: "billkit:processing", active: false },
      { type: "billkit:escape" },
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

  it("reads billkit:change's method as payment_method, from either name", () => {
    // 1.0 renamed the field. An element deployed before the rename sends
    // only `method`; the current one sends both, and `payment_method` wins.
    expect(
      parseHostMessage({ type: "billkit:change", complete: true, payment_method: "ideal" }),
    ).toEqual({ type: "billkit:change", complete: true, payment_method: "ideal" });
    expect(parseHostMessage({ type: "billkit:change", complete: true, method: "ideal" })).toEqual({
      type: "billkit:change",
      complete: true,
      payment_method: "ideal",
    });
    expect(
      parseHostMessage({
        type: "billkit:change",
        complete: false,
        payment_method: "creditcard",
        method: "creditcard",
      }),
    ).toEqual({ type: "billkit:change", complete: false, payment_method: "creditcard" });
  });

  it("drops optional fields that are present but the wrong type", () => {
    expect(
      parseHostMessage({ type: "billkit:change", complete: true, payment_method: 7 }),
    ).toEqual({
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
    // before it navigates, and `checkout-element.test.ts` pins that
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

  it("carries every code onError can receive", () => {
    // The element emits five, and `ELEMENT_ERROR_CODES` listed two of
    // them, so three real outcomes (`no_payment_methods`,
    // `missing_session_id`, `missing_client_secret`) reached merchants
    // as codes documented nowhere.
    // 1.0 added the loader's own two, which reached onError in 0.x without
    // being listed anywhere a merchant would look.
    expect([...ELEMENT_ERROR_CODES]).toEqual([
      "load_timeout",
      "unsafe_redirect",
      "payment_declined",
      "element_crashed",
      "no_payment_methods",
      "missing_session_id",
      "missing_client_secret",
      "payment_not_open",
      "payment_refunded",
      "client_secret_expired",
      "client_secret_invalid",
      "session_expired",
      "session_closed",
      "payment_in_progress",
      "request_timeout",
    ]);
  });

  it("parses a one-shot secret's id the same way as a checkout secret's", () => {
    expect(sessionIdFromClientSecret("osp_AbC-123_secret_r4nd0m")).toBe("osp_AbC-123");
  });
});

describe("isSafeRedirectUrl", () => {
  it("accepts https on mollie.com, mollie.nl and their subdomains only", () => {
    expect(isSafeRedirectUrl("https://www.mollie.com/checkout/x")).toBe(true);
    expect(isSafeRedirectUrl("https://mollie.com/checkout/x")).toBe(true);
    expect(isSafeRedirectUrl("https://pay.Mollie.com/x")).toBe(true);
    // A live card's 3-D Secure hand-off, verbatim from a live payment's
    // `_links.checkout.href`. Refused before 1.1.1.
    expect(
      isSafeRedirectUrl("https://pay.mollie.nl/payment/prepare-authentication/58055fd11df02e3924a87ad39b7c1191"),
    ).toBe(true);
    expect(isSafeRedirectUrl("https://mollie.nl/x")).toBe(true);
    // Not Mollie: a merchant look-alike, a suffix trick, plain http, and
    // credentials smuggled into the authority.
    expect(isSafeRedirectUrl("https://shop.example/return")).toBe(false);
    expect(isSafeRedirectUrl("https://evilmollie.com/x")).toBe(false);
    expect(isSafeRedirectUrl("https://evilmollie.nl/x")).toBe(false);
    expect(isSafeRedirectUrl("https://pay.mollie.nl.evil.example/x")).toBe(false);
    expect(isSafeRedirectUrl("http://pay.mollie.nl/x")).toBe(false);
    // Other Mollie-looking TLDs are not Mollie's checkout hosts.
    expect(isSafeRedirectUrl("https://pay.mollie.be/x")).toBe(false);
    expect(isSafeRedirectUrl("https://www.mollie.com.evil.example/x")).toBe(false);
    expect(isSafeRedirectUrl("http://www.mollie.com/checkout/x")).toBe(false);
    expect(isSafeRedirectUrl("http://localhost:3000/return")).toBe(false);
    expect(isSafeRedirectUrl("https://user:pw@www.mollie.com/x")).toBe(false);
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

describe("the protocol version on billkit:ready", () => {
  it("reads an integer protocol", () => {
    expect(parseHostMessage({ type: "billkit:ready", protocol: 1 })).toEqual({
      type: "billkit:ready",
      protocol: 1,
    });
    expect(parseHostMessage({ type: "billkit:ready", protocol: 7 })).toEqual({
      type: "billkit:ready",
      protocol: 7,
    });
  });

  it("reads a missing or malformed one as 0 and still accepts the ready", () => {
    // Dropping a ready over its protocol field would wedge the handshake:
    // an element from before 1.0 sends none at all.
    for (const protocol of [undefined, "1", -1, 1.5, null, Number.NaN]) {
      expect(parseHostMessage({ type: "billkit:ready", protocol })).toEqual({
        type: "billkit:ready",
        protocol: 0,
      });
    }
    expect(protocolOf(2)).toBe(2);
  });

  it("is 1 in this loader", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
