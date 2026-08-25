import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_BASE,
  DEFAULT_IFRAME_ORIGIN,
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

  it("clamps an absurd resize height instead of applying it", () => {
    // Unbounded height is a layout DoS on the merchant's page; dropping the
    // message instead would wedge the element at its initial size.
    expect(parseHostMessage({ type: "billkit:resize", height: 10_000_000 })).toEqual({
      type: "billkit:resize",
      height: 5000,
    });
  });

  it("refuses a redirect to anything that isn't absolute http(s)", () => {
    // The loader navigates the TOP window with this value, so a
    // `javascript:` URL would execute in the *merchant's* origin, turning
    // an XSS confined to the element document into an SOP escape.
    for (const url of [
      "javascript:alert(document.domain)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "/relative/path",
      "",
      42,
      null,
    ]) {
      expect(parseHostMessage({ type: "billkit:redirect", url })).toBeNull();
    }
    expect(parseHostMessage({ type: "billkit:redirect", url: "https://mollie.com/x" })).toEqual({
      type: "billkit:redirect",
      url: "https://mollie.com/x",
    });
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
