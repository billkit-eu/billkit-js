/**
 * Live-API harness shared by BOTH browser-SDK integration suites
 * (`sdk/js` and `sdk/react`). One copy so the two can't drift.
 *
 * What makes these *integration* tests rather than more unit tests: the
 * existing `tests/*.test.ts` mount the element with a hardcoded
 * `cs_test_abc123_secret_r4nd0m` and assert the loader's own state machine.
 * That proves the loader is self-consistent, and nothing more.
 *
 * These suites instead mint a **real** `client_secret` from a live API and
 * then check the boundary the unit tests cannot reach:
 *
 *  1. `sessionIdFromClientSecret()`, the loader's parse of the secret it
 *     is handed, actually yields the session id the API will accept in
 *     `/v1/checkout/sessions/{id}/element`. A change to either the mint
 *     format or the parser silently breaks embedded checkout in production;
 *     nothing else in the repo pins the two together.
 *  2. That secret genuinely authenticates on the embedded surface, and a
 *     secret API key genuinely does not.
 *  3. Confirming drives the real subscription to `active`.
 *
 * The iframe itself is simulated by making the same HTTP calls the real
 * js.billkit.eu document would make. Rendering the actual BillKit-hosted
 * iframe is out of scope here; that is the Playwright checkout project's
 * job (`frontend/e2e/specs/checkout`).
 *
 * Gated on `BILLKIT_INTEGRATION_BASE_URL`; skips when unset.
 */

export const BASE_URL = process.env["BILLKIT_INTEGRATION_BASE_URL"] ?? "";

export const INTEGRATION_ENABLED = BASE_URL.length > 0;

export interface TestTenant {
  apiKey: string;
  tenantId: string;
  mollieRouteId: string;
}

function uid(): string {
  return globalThis.crypto.randomUUID();
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Provision a brand-new tenant (fresh email => fresh tenant). */
export async function provisionTenant(label = "browser-sdk-it"): Promise<TestTenant> {
  const res = await post("/v1/console/auth/_test/login", {
    email: `${label}-${uid()}@sdk-it.example.com`,
    mode: "test",
    tenant_name: `Browser SDK IT ${label}`,
  });
  if (res.status === 404) {
    throw new Error(
      "test-login backdoor returned 404; boot the API with BILLKIT_E2E_TEST_LOGIN=1 " +
        "(see sdk/integration/boot-api.sh).",
    );
  }
  if (!res.ok) throw new Error(`test-login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    api_key: string;
    mollie_route_id: string;
    operator: { tenant_id: string };
  };
  return {
    apiKey: body.api_key,
    tenantId: body.operator.tenant_id,
    mollieRouteId: body.mollie_route_id,
  };
}

export interface EmbeddedSession {
  sessionId: string;
  clientSecret: string;
  priceId: string;
}

/**
 * Create a product + price and open an **embedded** checkout session.
 *
 * `ui_mode: "embedded"` is the whole point: it defers the Mollie charge and
 * returns a `client_secret` for the element instead of a redirect `url`.
 */
export async function createEmbeddedSession(tenant: TestTenant): Promise<EmbeddedSession> {
  const auth = { authorization: `Bearer ${tenant.apiKey}` };

  const product = (await (
    await post("/v1/products", { name: `Element Plan ${uid()}` }, auth)
  ).json()) as { id: string };

  const price = (await (
    await post(
      "/v1/prices",
      { product_id: product.id, amount_cents: 2500, currency: "EUR", interval: "month" },
      auth,
    )
  ).json()) as { id: string };

  const res = await post(
    "/v1/checkout/sessions",
    {
      price_id: price.id,
      customer_email: `buyer-${uid()}@sdk-it.example.com`,
      success_url: "https://merchant.example.com/ok",
      cancel_url: "https://merchant.example.com/cancel",
      ui_mode: "embedded",
    },
    auth,
  );
  if (!res.ok) throw new Error(`embedded checkout create failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string; client_secret: string | null };
  if (!body.client_secret) {
    throw new Error("embedded checkout returned no client_secret");
  }
  return { sessionId: body.id, clientSecret: body.client_secret, priceId: price.id };
}

/**
 * Call the embedded bootstrap the way the real iframe does, with the
 * `Checkout` auth scheme, which is the only scheme that surface accepts.
 */
export async function fetchElementView(
  sessionId: string,
  credential: string,
  scheme = "Checkout",
): Promise<Response> {
  return fetch(`${BASE_URL}/v1/checkout/sessions/${sessionId}/element`, {
    headers: { authorization: `${scheme} ${credential}` },
  });
}

/** Confirm the embedded session, as the iframe's pay button would. */
export async function confirmElement(
  sessionId: string,
  clientSecret: string,
  method = "creditcard",
): Promise<Response> {
  return post(
    `/v1/checkout/sessions/${sessionId}/confirm`,
    { method, card_token: "tkn_test_success" },
    { authorization: `Checkout ${clientSecret}` },
  );
}

export const mollie = {
  async settle(paymentId: string, status = "paid") {
    const res = await post("/v1/console/auth/_test/mollie/settle", {
      payment_id: paymentId,
      status,
    });
    if (!res.ok) throw new Error(`mollie settle failed: ${res.status} ${await res.text()}`);
  },
};

/** Post the provider webhook the way Mollie does, form-encoded `id=tr_...`. */
export async function deliverMollieWebhook(routeId: string, providerPaymentId: string) {
  const res = await fetch(`${BASE_URL}/internal/webhooks/mollie/${routeId}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `id=${encodeURIComponent(providerPaymentId)}`,
  });
  if (!res.ok) throw new Error(`webhook delivery failed: ${res.status} ${await res.text()}`);
}

/** Read a checkout session back with the tenant's API key. */
export async function getCheckoutSession(
  tenant: TestTenant,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/v1/checkout/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${tenant.apiKey}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

/** List subscriptions with the tenant's API key. */
export async function listSubscriptions(
  tenant: TestTenant,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE_URL}/v1/subscriptions?limit=100`, {
    headers: { authorization: `Bearer ${tenant.apiKey}` },
  });
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}
