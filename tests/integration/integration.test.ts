/**
 * `@billkit-eu/js` integration suite, run against a **live** BillKit API.
 *
 * Skipped unless `BILLKIT_INTEGRATION_BASE_URL` is set; boot a stack with
 * `make sdk-integration`.
 *
 * The unit suite (`tests/checkout-element.test.ts`) mounts the element with
 * a hardcoded secret and proves the loader's state machine is
 * self-consistent. This suite proves the loader agrees with the **server**:
 * a real minted `client_secret` parses to the session id the API actually
 * serves, authenticates on the embedded surface, and drives a real
 * subscription to `active`.
 *
 * The iframe document itself is simulated by making the same HTTP calls it
 * would; rendering the real js.billkit.eu page is the Playwright checkout
 * project's job.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mountCheckoutElement } from "../../src/checkout-element";
import { mountPaymentMethodElement } from "../../src/payment-method-element";
import { DEFAULT_IFRAME_ORIGIN, type HostMessage, sessionIdFromClientSecret } from "../../src/protocol";
import { assertManifestCoverage, COVERED } from "../../integration/browser/coverage.js";
import {
  confirmElement,
  createEmbeddedSession,
  deliverMollieWebhook,
  type EmbeddedSession,
  fetchElementView,
  INTEGRATION_ENABLED,
  listSubscriptions,
  mollie,
  provisionTenant,
  type TestTenant,
} from "../../integration/browser/harness.js";

const d = INTEGRATION_ENABLED ? describe : describe.skip;

function scenario(id: string, name: string, fn: () => void | Promise<void>) {
  COVERED.add(id);
  return it(`[${id}] ${name}`, fn, 30_000);
}

let tenant: TestTenant;
let session: EmbeddedSession;
let host: HTMLDivElement;

function getIframe(el: HTMLElement): HTMLIFrameElement {
  const iframe = el.querySelector("iframe");
  if (!iframe) throw new Error("no iframe mounted");
  return iframe;
}

/** Dispatch a message as if it came from the element iframe. */
function fromIframe(
  iframe: HTMLIFrameElement,
  data: HostMessage,
  origin = DEFAULT_IFRAME_ORIGIN,
  source: unknown = iframe.contentWindow,
): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, source: source as Window }),
  );
}

d("@billkit-eu/js against a live API", () => {
  beforeAll(async () => {
    tenant = await provisionTenant();
    session = await createEmbeddedSession(tenant);
  });

  // Fresh mount point per test so iframes never leak between cases.
  beforeEach(() => {
    host = document.createElement("div");
    host.id = "billkit-host";
    document.body.appendChild(host);
  });

  afterEach(() => {
    // `replaceChildren()` rather than `innerHTML = ""`. Same effect, but it
    // is a DOM call rather than an HTML-parsing sink, so it doesn't trip
    // XSS linters on a line that is only ever clearing the tree.
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  scenario("element.mount", "mounts the iframe without ever putting the secret in the URL", () => {
    mountCheckoutElement(host, { clientSecret: session.clientSecret });
    const iframe = getIframe(host);

    expect(iframe.src).toBe(`${DEFAULT_IFRAME_ORIGIN}/embed`);
    expect(iframe.getAttribute("allow")).toBe("payment");
    // The real secret must not leak via URL: Referer, history, and server
    // logs would all capture it.
    expect(iframe.src).not.toContain(session.clientSecret);
    expect(iframe.src).not.toContain("_secret_");

    // The wallet element is a different document on the same origin.
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    mountPaymentMethodElement(host2, {
      clientSecret: session.clientSecret,
      customerId: "cus_x",
    });
    expect(getIframe(host2).src).toBe(`${DEFAULT_IFRAME_ORIGIN}/methods`);
  });

  scenario(
    "element.handshake",
    "posts init only after ready, targeted, with the real secret + parsed session id",
    () => {
      mountCheckoutElement(host, {
        clientSecret: session.clientSecret,
        theme: { colorPrimary: "#111" },
      });
      const iframe = getIframe(host);
      const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");

      // Nothing is sent before the iframe announces itself. That ordering
      // is what keeps the secret off the wire until a same-origin document
      // is listening.
      expect(post).not.toHaveBeenCalled();

      fromIframe(iframe, { type: "billkit:ready" });

      expect(post).toHaveBeenCalledTimes(1);
      const [message, targetOrigin] = post.mock.calls[0]!;
      expect(targetOrigin).toBe(DEFAULT_IFRAME_ORIGIN);
      expect(message).toMatchObject({
        type: "billkit:init",
        element: "checkout",
        clientSecret: session.clientSecret,
        // The crux: the id the loader parsed must be the id the API minted.
        sessionId: session.sessionId,
        theme: { colorPrimary: "#111" },
      });
    },
  );

  scenario("element.origin_isolation", "ignores foreign origins and foreign sources", () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    mountCheckoutElement(host, { clientSecret: session.clientSecret, onError, onSuccess });
    const iframe = getIframe(host);

    // Wrong origin: an attacker's frame on the page.
    fromIframe(iframe, { type: "billkit:error", message: "spoofed" }, "https://evil.example");
    // Right origin, wrong source: a sibling BillKit element, or the page.
    fromIframe(
      iframe,
      { type: "billkit:success", sessionId: "cs_x", paymentStatus: "paid" },
      DEFAULT_IFRAME_ORIGIN,
      window,
    );

    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  scenario(
    "element.live_secret_authenticates",
    "the minted secret authenticates at the session id the loader parsed",
    async () => {
      // Drive the request off the *parsed* id, not the one the API handed
      // back, so a divergence between mint format and parser fails here.
      const parsed = sessionIdFromClientSecret(session.clientSecret);
      expect(parsed).toBe(session.sessionId);

      const res = await fetchElementView(parsed!, session.clientSecret);
      expect(res.status).toBe(200);
      const view = (await res.json()) as { session_id: string; currency: string };
      expect(view.session_id).toBe(session.sessionId);
      expect(view.currency).toBe("EUR");
    },
  );

  scenario("element.api_key_rejected", "a secret API key is refused on the embedded surface", async () => {
    // The embedded surface accepts exactly one scheme. A tenant's secret
    // key reaching the browser would be catastrophic, so the server must
    // refuse it here even though the key is otherwise valid.
    const asBearer = await fetchElementView(session.sessionId, tenant.apiKey, "Bearer");
    expect(asBearer.status).toBe(401);

    // Even under the right scheme, an API key is not a checkout token.
    const asCheckout = await fetchElementView(session.sessionId, tenant.apiKey, "Checkout");
    expect(asCheckout.status).toBe(401);
  });

  scenario(
    "element.live_confirm_activates",
    "confirm -> settle -> webhook drives the subscription active",
    async () => {
      // Its own session: confirm consumes the client_secret, so sharing the
      // suite-level one would break the other specs.
      const own = await createEmbeddedSession(tenant);

      const res = await confirmElement(own.sessionId, own.clientSecret);
      expect(res.status).toBe(200);
      const confirmation = (await res.json()) as { redirect_url: string | null };
      expect(confirmation.redirect_url).toBeTruthy();

      const providerPaymentId = confirmation.redirect_url!.split("/").pop()!;
      expect(providerPaymentId).toMatch(/^tr_/);

      await mollie.settle(providerPaymentId, "paid");
      await deliverMollieWebhook(tenant.mollieRouteId, providerPaymentId);

      const subs = await listSubscriptions(tenant);
      const sub = subs.find((s) => s["price_id"] === own.priceId);
      expect(sub, "a subscription should exist for the confirmed element").toBeTruthy();
      expect(sub!["status"]).toBe("active");
    },
  );

  scenario("element.teardown", "destroy removes the iframe and stops routing", () => {
    const onSuccess = vi.fn();
    const handle = mountCheckoutElement(host, {
      clientSecret: session.clientSecret,
      onSuccess,
    });
    const iframe = getIframe(host);

    handle.destroy();
    expect(host.querySelector("iframe")).toBeNull();

    fromIframe(iframe, { type: "billkit:success", sessionId: "cs_1", paymentStatus: "paid" });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  afterAll(() => {
    assertManifestCoverage("js");
  });
});
