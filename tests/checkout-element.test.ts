import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCheckoutElement } from "../src/checkout-element";
import { mountPaymentMethodElement } from "../src/payment-method-element";
import { DEFAULT_IFRAME_ORIGIN, type HostMessage } from "../src/protocol";

// Stripe-shaped: "<sessionId>_secret_<random>".
const CS = "cs_test_abc123_secret_r4nd0m";
const CS_SESSION_ID = "cs_test_abc123";

function getIframe(host: HTMLElement): HTMLIFrameElement {
  const iframe = host.querySelector("iframe");
  if (!iframe) throw new Error("no iframe mounted");
  return iframe;
}

/** Dispatch a message as if it came from the element iframe. */
function fromIframe(
  iframe: HTMLIFrameElement,
  data: HostMessage,
  origin = DEFAULT_IFRAME_ORIGIN,
): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, source: iframe.contentWindow }),
  );
}

describe("mountCheckoutElement", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    host.id = "checkout";
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("throws without a clientSecret", () => {
    expect(() => mountCheckoutElement(host, { clientSecret: "" })).toThrow(/clientSecret/);
  });

  it("throws when the target selector matches nothing", () => {
    expect(() => mountCheckoutElement("#nope", { clientSecret: CS })).toThrow(/not found/);
  });

  it("mounts a cross-origin iframe pointed at js.billkit.eu/embed", () => {
    mountCheckoutElement("#checkout", { clientSecret: CS });
    const iframe = getIframe(host);
    expect(iframe.src).toBe("https://js.billkit.eu/embed");
    expect(iframe.getAttribute("allow")).toBe("payment");
    expect(iframe.title).toMatch(/BillKit/);
    // The secret must NOT be in the URL (no query / fragment leak).
    expect(iframe.src).not.toContain(CS);
  });

  it("sandboxes the element frame without granting top-navigation", () => {
    mountCheckoutElement("#checkout", { clientSecret: CS });
    const sandbox = getIframe(host).getAttribute("sandbox") ?? "";
    const granted = sandbox.split(/\s+/).filter(Boolean);

    // Needed for the element to function at all: it is a React app that
    // fetches with its own origin's credentials, and Mollie Components
    // submit a form (3DS) and may open a bank window.
    expect(granted).toContain("allow-scripts");
    expect(granted).toContain("allow-same-origin");
    expect(granted).toContain("allow-forms");
    expect(granted).toContain("allow-popups");
    expect(granted).toContain("allow-popups-to-escape-sandbox");

    // The load-bearing omission. Redirects travel up as a
    // `billkit:redirect` message and the loader performs them after
    // `isSafeRedirectUrl`, so the frame never needs to steer the top
    // window, and withholding this is what stops a compromised element
    // origin from navigating the merchant's page to a phishing clone.
    expect(granted).not.toContain("allow-top-navigation");
    expect(granted).not.toContain("allow-top-navigation-by-user-activation");
  });

  it("sandboxes the payment-method element the same way", () => {
    mountPaymentMethodElement("#checkout", { clientSecret: CS });
    const sandbox = getIframe(host).getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-top-navigation");
  });

  it("honours an iframeOrigin override (custom-domain seam)", () => {
    mountCheckoutElement("#checkout", {
      clientSecret: CS,
      iframeOrigin: "https://pay.acme.com/",
    });
    expect(getIframe(host).src).toBe("https://pay.acme.com/embed");
  });

  it("mounts the payment-method element at /methods", () => {
    mountPaymentMethodElement("#checkout", { clientSecret: CS, customerId: "cus_1" });
    expect(getIframe(host).src).toBe("https://js.billkit.eu/methods");
  });

  it("sends init only after the iframe announces ready, targeting the origin", () => {
    mountCheckoutElement("#checkout", { clientSecret: CS, theme: { colorPrimary: "#111" } });
    const iframe = getIframe(host);
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    fromIframe(iframe, { type: "billkit:ready" });

    expect(post).toHaveBeenCalledTimes(1);
    const [message, targetOrigin] = post.mock.calls[0]!;
    expect(targetOrigin).toBe(DEFAULT_IFRAME_ORIGIN);
    expect(message).toMatchObject({
      type: "billkit:init",
      element: "checkout",
      clientSecret: CS,
      // The loader parses the session id out of the secret for the iframe's
      // API path. It isn't a secret, so it rides in the init message.
      sessionId: CS_SESSION_ID,
      theme: { colorPrimary: "#111" },
    });
  });

  it("routes loaded/resize/change/success events to callbacks", () => {
    const onReady = vi.fn();
    const onChange = vi.fn();
    const onSuccess = vi.fn();
    mountCheckoutElement("#checkout", { clientSecret: CS, onReady, onChange, onSuccess });
    const iframe = getIframe(host);

    fromIframe(iframe, { type: "billkit:loaded", sessionId: "cs_1" });
    fromIframe(iframe, { type: "billkit:resize", height: 512 });
    fromIframe(iframe, { type: "billkit:change", complete: true, method: "creditcard" });
    fromIframe(iframe, {
      type: "billkit:success",
      sessionId: "cs_1",
      paymentStatus: "paid",
    });

    expect(onReady).toHaveBeenCalledOnce();
    expect(iframe.style.height).toBe("512px");
    expect(onChange).toHaveBeenCalledWith({ complete: true, method: "creditcard" });
    expect(onSuccess).toHaveBeenCalledWith({ sessionId: "cs_1", paymentStatus: "paid" });
  });

  it("lets onRedirect intercept the top-window navigation", () => {
    const onRedirect = vi.fn().mockReturnValue(false);
    mountCheckoutElement("#checkout", { clientSecret: CS, onRedirect });
    const iframe = getIframe(host);

    fromIframe(iframe, { type: "billkit:redirect", url: "https://www.mollie.com/3ds/x" });

    expect(onRedirect).toHaveBeenCalledWith("https://www.mollie.com/3ds/x");
  });

  it("ignores messages from a foreign origin", () => {
    const onError = vi.fn();
    mountCheckoutElement("#checkout", { clientSecret: CS, onError });
    const iframe = getIframe(host);

    fromIframe(iframe, { type: "billkit:error", message: "spoofed" }, "https://evil.example");

    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores messages whose source is not this iframe", () => {
    const onError = vi.fn();
    mountCheckoutElement("#checkout", { clientSecret: CS, onError });

    // source = window (the page), not the iframe's contentWindow.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "billkit:error", message: "spoofed" },
        origin: DEFAULT_IFRAME_ORIGIN,
        source: window,
      }),
    );

    expect(onError).not.toHaveBeenCalled();
  });

  it("fires onError(load_timeout) if the iframe never loads", () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      mountCheckoutElement("#checkout", { clientSecret: CS, onError, loadTimeoutMs: 5000 });
      expect(onError).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "load_timeout" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the load watchdog once the element loads", () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      mountCheckoutElement("#checkout", { clientSecret: CS, onError, loadTimeoutMs: 5000 });
      const iframe = getIframe(host);
      fromIframe(iframe, { type: "billkit:loaded", sessionId: "cs_1" });
      vi.advanceTimersByTime(10000);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops routing and removes the iframe after destroy()", () => {
    const onSuccess = vi.fn();
    const handle = mountCheckoutElement("#checkout", { clientSecret: CS, onSuccess });
    const iframe = getIframe(host);

    handle.destroy();
    expect(host.querySelector("iframe")).toBeNull();

    fromIframe(iframe, { type: "billkit:success", sessionId: "cs_1", paymentStatus: "paid" });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
