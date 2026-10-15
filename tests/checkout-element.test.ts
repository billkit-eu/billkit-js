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

/**
 * Intercept the loader's top-window navigation, and hand back the undo.
 *
 * `handleRedirect` sets `(window.top ?? window).location.href = url`, so
 * replacing `window.top` with a stand-in whose `location.href` setter is a
 * spy captures the navigation without performing it. The stand-in's
 * `assign()` throws a SecurityError, as a cross-origin top window's does
 * when the merchant's page is itself framed by another origin: of a
 * cross-origin `Location`, only the `href` setter and `replace()` are
 * allowed, so a loader that used `assign()` misses the spy. `window.location`
 * itself cannot be stubbed: its members are `[LegacyUnforgeable]` and
 * jsdom refuses the redefinition, which is why the top window is the
 * seam. The `catch` fallback to `window.location` is covered by the
 * logger assertions instead: the "redirecting the top window" debug line
 * sits immediately before the navigation, on the far side of the guard, so
 * its absence is proof the guard refused before either branch ran.
 */
function stubTopNavigation(spy: (url: string) => void): () => void {
  const original = window.top;
  Object.defineProperty(window, "top", {
    configurable: true,
    writable: true,
    value: {
      location: {
        set href(url: string) {
          spy(url);
        },
        assign() {
          throw new DOMException(
            "Blocked a frame from accessing a cross-origin frame.",
            "SecurityError",
          );
        },
      },
    },
  });
  return () => {
    Object.defineProperty(window, "top", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
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

  it("normalises iframeOrigin to the origin a browser reports, so messages still match", () => {
    const onReady = vi.fn();
    mountCheckoutElement("#checkout", {
      clientSecret: CS,
      iframeOrigin: "https://Pay.ACME.com:443/some/path/",
      onReady,
    });
    const iframe = getIframe(host);
    expect(iframe.src).toBe("https://pay.acme.com/embed");
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    fromIframe(iframe, { type: "billkit:ready" }, "https://pay.acme.com");
    fromIframe(iframe, { type: "billkit:loaded", sessionId: CS_SESSION_ID }, "https://pay.acme.com");

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![1]).toBe("https://pay.acme.com");
  });

  it.each([
    "pay.acme.com",
    "not a url",
    "javascript:alert(1)",
    "data:text/html,x",
    "",
    // Plain http off loopback would post the client_secret in clear text.
    "http://pay.acme.com",
    "http://localhost.evil.example",
  ])(
    "refuses the iframeOrigin %j at mount",
    (iframeOrigin) => {
      expect(() => mountCheckoutElement("#checkout", { clientSecret: CS, iframeOrigin })).toThrow(
        /`iframeOrigin` must be an absolute https:\/\/ origin/,
      );
      expect(host.querySelector("iframe")).toBeNull();
    },
  );

  it.each([
    ["http://localhost:5173/", "http://localhost:5173"],
    ["http://checkout.localhost:8080", "http://checkout.localhost:8080"],
    ["http://127.0.0.1:4000", "http://127.0.0.1:4000"],
    ["http://[::1]:4000", "http://[::1]:4000"],
  ])("accepts the loopback http origin %j for local development", (iframeOrigin, origin) => {
    mountCheckoutElement("#checkout", { clientSecret: CS, iframeOrigin });
    expect(getIframe(host).src).toBe(`${origin}/embed`);
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
    fromIframe(iframe, { type: "billkit:change", complete: true, payment_method: "creditcard" });
    fromIframe(iframe, {
      type: "billkit:success",
      sessionId: "cs_1",
      paymentStatus: "paid",
    });

    expect(onReady).toHaveBeenCalledOnce();
    expect(iframe.style.height).toBe("512px");
    expect(onChange).toHaveBeenCalledWith({ complete: true, payment_method: "creditcard" });
    expect(onSuccess).toHaveBeenCalledWith({ sessionId: "cs_1", paymentStatus: "paid" });
  });

  it("routes processing changes to onProcessing, once per change", () => {
    const onProcessing = vi.fn();
    mountCheckoutElement("#checkout", { clientSecret: CS, onProcessing });
    const iframe = getIframe(host);

    fromIframe(iframe, { type: "billkit:processing", active: true });
    fromIframe(iframe, { type: "billkit:processing", active: true });
    fromIframe(iframe, { type: "billkit:processing", active: false });
    // A malformed one is dropped, not read as either answer.
    fromIframe(iframe, { type: "billkit:processing", active: "yes" } as unknown as HostMessage);

    expect(onProcessing.mock.calls).toEqual([[{ processing: true }], [{ processing: false }]]);
  });

  it("routes Escape pressed inside the element to onEscape", () => {
    const onEscape = vi.fn();
    mountCheckoutElement("#checkout", { clientSecret: CS, onEscape });
    fromIframe(getIframe(host), { type: "billkit:escape" });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("ends processing when it refuses an unsafe redirect, since nothing is left to wait for", () => {
    const onProcessing = vi.fn();
    const navigate = vi.fn();
    const restoreTop = stubTopNavigation(navigate);
    try {
      mountCheckoutElement("#checkout", { clientSecret: CS, onProcessing, onError: () => {} });
      const iframe = getIframe(host);
      fromIframe(iframe, { type: "billkit:processing", active: true });
      fromIframe(iframe, { type: "billkit:redirect", url: "https://phish.example/checkout" });
      expect(onProcessing.mock.calls).toEqual([[{ processing: true }], [{ processing: false }]]);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      restoreTop();
    }
  });

  it("ends processing when onRedirect takes the navigation over", () => {
    // The host owns it now (a popup, or nothing), and the element cannot hear how it went.
    const onProcessing = vi.fn();
    mountCheckoutElement("#checkout", {
      clientSecret: CS,
      onProcessing,
      onRedirect: () => false,
    });
    const iframe = getIframe(host);
    fromIframe(iframe, { type: "billkit:processing", active: true });
    fromIframe(iframe, { type: "billkit:redirect", url: "https://www.mollie.com/3ds/x" });
    expect(onProcessing.mock.calls).toEqual([[{ processing: true }], [{ processing: false }]]);
  });

  it("keeps processing on through a hand-off that leaves, and ends it if the page stays", () => {
    // A `beforeunload` "Stay" cancels the navigation without a word.
    vi.useFakeTimers();
    const navigate = vi.fn();
    const restoreTop = stubTopNavigation(navigate);
    try {
      const onProcessing = vi.fn();
      mountCheckoutElement("#checkout", { clientSecret: CS, onProcessing });
      const iframe = getIframe(host);
      fromIframe(iframe, { type: "billkit:processing", active: true });
      fromIframe(iframe, { type: "billkit:redirect", url: "https://www.mollie.com/3ds/x" });
      expect(navigate).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(14_000);
      expect(onProcessing.mock.calls).toEqual([[{ processing: true }]]);
      vi.advanceTimersByTime(1_000);
      expect(onProcessing.mock.calls).toEqual([[{ processing: true }], [{ processing: false }]]);
    } finally {
      restoreTop();
      vi.useRealTimers();
    }
  });

  it("does not report after destroy() when a hand-off timer was pending", () => {
    vi.useFakeTimers();
    const restoreTop = stubTopNavigation(vi.fn());
    try {
      const onProcessing = vi.fn();
      const handle = mountCheckoutElement("#checkout", { clientSecret: CS, onProcessing });
      const iframe = getIframe(host);
      fromIframe(iframe, { type: "billkit:processing", active: true });
      fromIframe(iframe, { type: "billkit:redirect", url: "https://www.mollie.com/3ds/x" });
      handle.destroy();
      vi.advanceTimersByTime(60_000);
      expect(onProcessing.mock.calls).toEqual([[{ processing: true }]]);
    } finally {
      restoreTop();
      vi.useRealTimers();
    }
  });

  it("ends processing when the frame reloads, since its attempt cannot report any more", () => {
    const onProcessing = vi.fn();
    mountCheckoutElement("#checkout", { clientSecret: CS, onProcessing });
    const iframe = getIframe(host);
    fromIframe(iframe, { type: "billkit:ready", protocol: 1 });
    fromIframe(iframe, { type: "billkit:processing", active: true });
    fromIframe(iframe, { type: "billkit:ready", protocol: 1 });
    expect(onProcessing.mock.calls).toEqual([[{ processing: true }], [{ processing: false }]]);
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

  it.each([Number.NaN, "5000" as unknown as number])(
    "treats loadTimeoutMs %j as unset rather than firing at once",
    (loadTimeoutMs) => {
      vi.useFakeTimers();
      try {
        const onError = vi.fn();
        mountCheckoutElement("#checkout", { clientSecret: CS, onError, loadTimeoutMs });
        vi.advanceTimersByTime(1);
        expect(onError).not.toHaveBeenCalled();
        // The default, 20 seconds, still applies.
        vi.advanceTimersByTime(20_000);
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "load_timeout" }));
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([Number.POSITIVE_INFINITY, 2 ** 31])(
    "treats loadTimeoutMs %s as never, not as now",
    (loadTimeoutMs) => {
      vi.useFakeTimers();
      try {
        const onError = vi.fn();
        mountCheckoutElement("#checkout", { clientSecret: CS, onError, loadTimeoutMs });
        vi.advanceTimersByTime(60_000);
        expect(onError).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

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

  it("cancels the load watchdog on ready, before the element finishes loading", () => {
    // The iframe booting is what the watchdog guards; fetching the
    // element view afterwards can legitimately outrun `loadTimeoutMs` on
    // a slow connection. Firing `load_timeout` there showed an error over
    // a form that was about to render perfectly well.
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const onReady = vi.fn();
      mountCheckoutElement("#checkout", {
        clientSecret: CS,
        onError,
        onReady,
        loadTimeoutMs: 5000,
      });
      const iframe = getIframe(host);

      vi.advanceTimersByTime(1000);
      fromIframe(iframe, { type: "billkit:ready" });
      // Well past the deadline, with `loaded` only arriving now.
      vi.advanceTimersByTime(30_000);
      fromIframe(iframe, { type: "billkit:loaded", sessionId: "cs_1" });

      expect(onError).not.toHaveBeenCalled();
      expect(onReady).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a payment_declined error to onError", () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    mountCheckoutElement("#checkout", { clientSecret: CS, onError, onSuccess });
    const iframe = getIframe(host);

    fromIframe(iframe, {
      type: "billkit:error",
      message: "Your bank didn't approve this payment.",
      code: "payment_declined",
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({
      message: "Your bank didn't approve this payment.",
      code: "payment_declined",
    });
  });

  it("carries the LATEST theme in init when updateTheme() runs before ready", () => {
    const handle = mountCheckoutElement("#checkout", {
      clientSecret: CS,
      theme: { colorScheme: "light" },
    });
    const iframe = getIframe(host);
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    // The tenant flips to dark while the bundle is still downloading.
    handle.updateTheme({ colorScheme: "dark" });
    // Nothing is posted yet: there is no listener in the frame to hear it.
    expect(post).not.toHaveBeenCalled();

    fromIframe(iframe, { type: "billkit:ready" });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({
      type: "billkit:init",
      theme: { colorScheme: "dark" },
    });
  });

  it("posts billkit:theme immediately once the element is ready", () => {
    const handle = mountCheckoutElement("#checkout", { clientSecret: CS });
    const iframe = getIframe(host);
    fromIframe(iframe, { type: "billkit:ready" });
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    handle.updateTheme({ colorPrimary: "#0f766e" });

    expect(post).toHaveBeenCalledWith(
      { type: "billkit:theme", theme: { colorPrimary: "#0f766e" } },
      DEFAULT_IFRAME_ORIGIN,
    );
  });

  it("fires onError(unsafe_redirect) and never navigates, for every unsafe target", () => {
    // THE invariant. `parseHostMessage` checks the redirect's shape and
    // nothing more, so the guarantee that only http(s) reaches the top
    // window's `location` rests entirely on `handleRedirect`'s call to
    // `isSafeRedirectUrl`. If that call were ever dropped, a
    // `javascript:` URL arriving over postMessage would execute in the
    // MERCHANT's origin, an element-scoped XSS escalated into a
    // same-origin-policy escape onto every page hosting the element.
    //
    // So this asserts the negative directly: the navigation never happens.
    const unsafe = [
      "javascript:alert(document.domain)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "/relative/path",
      // Well-formed https, but not the provider: a compromised element
      // must not be able to send the merchant's buyers to a clone.
      "https://phish.example/checkout",
      "http://www.mollie.com/checkout/x",
      "",
    ];

    for (const url of unsafe) {
      const onError = vi.fn();
      const onRedirect = vi.fn();
      const warn = vi.fn();
      const debug = vi.fn();
      const navigate = vi.fn();
      const restoreTop = stubTopNavigation(navigate);

      try {
        mountCheckoutElement("#checkout", {
          clientSecret: CS,
          onError,
          onRedirect,
          logger: { debug, warn },
        });
        const iframe = getIframe(host);

        fromIframe(iframe, { type: "billkit:redirect", url });

        expect(navigate, `navigated to ${JSON.stringify(url)}`).not.toHaveBeenCalled();
        // Covers the `catch` branch too, which falls back to
        // `window.location` and cannot be stubbed under jsdom: this debug
        // line is the last statement before either navigation, so if it
        // never ran, neither did they.
        expect(debug).not.toHaveBeenCalledWith(
          "BillKit redirecting the top window",
          expect.anything(),
        );
        // An empty url is dropped by the parser as a malformed message, so
        // it never reaches the refusal at all, which is also correct, and
        // the reason this asserts on navigation first.
        if (url !== "") {
          expect(onError).toHaveBeenCalledWith({
            message: "Refused to follow an unsafe redirect target.",
            code: "unsafe_redirect",
          });
          expect(warn).toHaveBeenCalledWith(
            "BillKit refused an unsafe redirect",
            expect.objectContaining({ element: "checkout" }),
          );
          // The refusal comes BEFORE the tenant's interception hook: a
          // merchant must never be handed a `javascript:` URL to navigate
          // to themselves.
          expect(onRedirect).not.toHaveBeenCalled();
        }
      } finally {
        restoreTop();
        document.body.innerHTML = "";
        host = document.createElement("div");
        host.id = "checkout";
        document.body.appendChild(host);
      }
    }
  });

  it("navigates for an http(s) target, which is the same code path", () => {
    // The positive half: the guard refuses, it does not refuse
    // everything. Without this the test above would pass against a
    // `handleRedirect` that had stopped navigating altogether.
    const navigate = vi.fn();
    const restoreTop = stubTopNavigation(navigate);
    try {
      mountCheckoutElement("#checkout", { clientSecret: CS });
      fromIframe(getIframe(host), {
        type: "billkit:redirect",
        url: "https://www.mollie.com/checkout/3ds/x",
      });
      expect(navigate).toHaveBeenCalledWith("https://www.mollie.com/checkout/3ds/x");
    } finally {
      restoreTop();
    }
  });

  it("titles the frame per element kind, and lets a merchant localise it", () => {
    // The frame title is announced as focus crosses into the element and
    // is the one string of ours that lives on the merchant's page, so
    // `locale` cannot reach it. "Secure checkout" on a saved-methods
    // wallet also described a payment the customer was not making.
    mountCheckoutElement("#checkout", { clientSecret: CS });
    expect(getIframe(host).title).toBe("BillKit secure checkout");

    document.body.innerHTML = "";
    const methods = document.createElement("div");
    methods.id = "methods";
    document.body.appendChild(methods);
    mountPaymentMethodElement(methods, { clientSecret: CS, customerId: "cus_1" });
    expect(getIframe(methods).title).toBe("BillKit saved payment methods");

    methods.innerHTML = "";
    mountPaymentMethodElement(methods, {
      clientSecret: CS,
      customerId: "cus_1",
      title: "Opgeslagen betaalmethoden",
    });
    expect(getIframe(methods).title).toBe("Opgeslagen betaalmethoden");
  });

  it("lays the iframe out as a block", () => {
    // An inline iframe sits on the text baseline, so the line box leaves
    // descender space under it, a stray gap below the payment form on
    // the merchant's page that no margin of theirs can remove.
    mountCheckoutElement("#checkout", { clientSecret: CS });
    expect(getIframe(host).style.display).toBe("block");
  });

  it("queues a submit made before ready and flushes it after init", () => {
    // A merchant's own pay button is clickable the moment their page
    // renders, which can be long before a third-party frame has booted.
    // That submit used to be posted into a frame with no listener and
    // dropped in silence: the buyer pressed pay and nothing happened.
    const debug = vi.fn();
    const handle = mountCheckoutElement("#checkout", { clientSecret: CS, logger: { debug, warn: vi.fn() } });
    const iframe = getIframe(host);
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    handle.submit();
    expect(post).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      "BillKit queued a submit until the element is ready",
      expect.anything(),
    );

    fromIframe(iframe, { type: "billkit:ready" });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![0]).toMatchObject({ type: "billkit:init" });
    expect(post.mock.calls[1]![0]).toEqual({ type: "billkit:submit" });
    expect(post.mock.calls[1]![1]).toBe(DEFAULT_IFRAME_ORIGIN);
  });

  it("queues at most one pending submit", () => {
    // Two presses before boot are the same intent, not two payments.
    const handle = mountCheckoutElement("#checkout", { clientSecret: CS });
    const iframe = getIframe(host);
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    handle.submit();
    handle.submit();
    handle.submit();
    fromIframe(iframe, { type: "billkit:ready" });

    const submits = post.mock.calls.filter(
      ([message]) => (message as { type: string }).type === "billkit:submit",
    );
    expect(submits).toHaveLength(1);
  });

  it("posts billkit:focus once ready, and drops a focus() made before", () => {
    // Not queued, unlike submit: focus is about where the buyer is
    // looking now, and replaying it after a slow boot would pull the
    // caret out of whatever they had started typing on the host page.
    const debug = vi.fn();
    const handle = mountCheckoutElement("#checkout", { clientSecret: CS, logger: { debug, warn: vi.fn() } });
    const iframe = getIframe(host);
    const early = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    handle.focus();
    expect(early).not.toHaveBeenCalled();

    fromIframe(iframe, { type: "billkit:ready" });
    early.mockClear();
    handle.focus();

    expect(early).toHaveBeenCalledWith({ type: "billkit:focus" }, DEFAULT_IFRAME_ORIGIN);
  });

  it("warns when a second element is mounted into the same target", () => {
    // Warned, not thrown: the second element works, it just stacks under
    // the first with two `message` listeners racing for the same
    // traffic. Throwing would take down a page about to take a payment.
    const warn = vi.fn();
    mountCheckoutElement("#checkout", { clientSecret: CS, logger: { debug: vi.fn(), warn } });
    expect(warn).not.toHaveBeenCalled();

    mountCheckoutElement("#checkout", { clientSecret: CS, logger: { debug: vi.fn(), warn } });

    expect(warn).toHaveBeenCalledWith(
      "BillKit mounted a second element into a target that already had one",
      expect.objectContaining({ target: "#checkout" }),
    );
    expect(host.querySelectorAll("iframe")).toHaveLength(2);
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

describe("the versioned handshake", () => {
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

  function readyAndCaptureInit(ready: Record<string, unknown>, logger?: { debug: (m: string, c?: Record<string, unknown>) => void; warn: () => void }) {
    mountCheckoutElement("#checkout", { clientSecret: CS, ...(logger ? { logger } : {}) });
    const iframe = getIframe(host);
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");
    fromIframe(iframe, ready as unknown as HostMessage);
    return post;
  }

  it("sends protocol 1 in init", () => {
    const post = readyAndCaptureInit({ type: "billkit:ready", protocol: 1 });
    expect(post.mock.calls[0]![0]).toMatchObject({ type: "billkit:init", protocol: 1 });
  });

  it("still initialises an element that predates the protocol field", () => {
    // Every element deployment before 1.0 sends a bare ready.
    const post = readyAndCaptureInit({ type: "billkit:ready" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({ type: "billkit:init", protocol: 1 });
  });

  it("degrades gracefully in front of a newer element: its own protocol, and a debug line", () => {
    const lines: Array<[string, Record<string, unknown> | undefined]> = [];
    const post = readyAndCaptureInit(
      { type: "billkit:ready", protocol: 9 },
      { debug: (m, c) => lines.push([m, c]), warn: () => undefined },
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({ type: "billkit:init", protocol: 1 });
    expect(lines).toContainEqual([
      "BillKit element speaks a newer protocol; using this loader's",
      { element: "checkout", elementProtocol: 9, loaderProtocol: 1 },
    ]);
  });

  it("does not drop a ready whose protocol is malformed", () => {
    const post = readyAndCaptureInit({ type: "billkit:ready", protocol: "2" });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("mountPaymentMethodElement without a customerId", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("mounts, and init carries no customerId: the secret names the customer", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountPaymentMethodElement(host, { clientSecret: CS });
    const iframe = getIframe(host);
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");
    fromIframe(iframe, { type: "billkit:ready", protocol: 1 });
    const init = post.mock.calls[0]![0] as Record<string, unknown>;
    expect(init).toMatchObject({ type: "billkit:init", element: "payment-method" });
    expect("customerId" in init).toBe(false);
  });
});
