import type { BillKitThemeTokens } from "./theme";

/**
 * The `postMessage` contract between this loader (the parent page) and the
 * BillKit element served from js.billkit.eu (the iframe).
 *
 * Security model, and the whole point of the fixed origin:
 *
 * - The iframe is served from ONE origin (`DEFAULT_IFRAME_ORIGIN`). The
 *   loader validates `event.origin` against it on every inbound message
 *   and always posts outbound messages with an explicit `targetOrigin`.
 *   A page hosting the element cannot read what the customer types: the
 *   card fields live cross-origin, which is what keeps the tenant on PCI
 *   SAQ A.
 * - The `client_secret` is NEVER put in the iframe URL (no query, no
 *   fragment) so it can't leak via `Referer`, history, or server logs. It
 *   is handed to the iframe only after the iframe announces `ready`, over
 *   a targeted `postMessage`.
 * - Messages are additionally correlated by `event.source === iframe
 *   .contentWindow`, so two elements mounted on the same page never see
 *   each other's traffic.
 */

/** The single BillKit-hosted origin the element is served from. */
export const DEFAULT_IFRAME_ORIGIN = "https://js.billkit.eu";

/** Where the iframe calls the confirm/element API by default. Internal. */
export const DEFAULT_API_BASE = "https://api.billkit.eu";

/**
 * The loader-to-iframe protocol version this loader speaks.
 *
 * An integer, carried in `billkit:init` (the loader's version) and in
 * `billkit:ready` (the iframe's), and bumped only for a change one side
 * cannot simply ignore. The rule, in DEVELOPMENT.md: the iframe keeps
 * honouring every protocol a released loader sends, for as long as that
 * loader can be in a merchant's bundle; a loader that meets a higher
 * protocol than its own carries on speaking its own. A message without the
 * field is protocol 0, which is every loader and iframe before 1.0.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Which element the iframe should render.
 *
 * `"one-shot"` (added in loader 0.4.0) is the one-off payment form for a
 * `POST /v1/checkout/one_shot` created with `ui_mode: "embedded"`: no
 * subscription, no mandate, no coupon. It is its own kind rather than a
 * `"checkout"` that sniffs the secret's prefix, so the iframe is told what
 * it is rendering instead of guessing, and an element deployment that
 * predates it refuses the unknown kind in `parseInboundMessage` rather than
 * treating a one-shot secret as a checkout session.
 */
export type ElementKind = "checkout" | "payment-method" | "one-shot";

/** Delimiter separating the session id from the random tail in a secret. */
const CHECKOUT_SECRET_DELIM = "_secret_";

/**
 * Parse the checkout session id out of a `client_secret`
 * (`<sessionId>_secret_<random>`, Stripe-shaped). Returns `null` for a
 * malformed value. Splits on the first delimiter, since the session id is
 * minted first, so the first `_secret_` is the real boundary.
 */
export function sessionIdFromClientSecret(clientSecret: string): string | null {
  const idx = clientSecret.indexOf(CHECKOUT_SECRET_DELIM);
  return idx > 0 ? clientSecret.slice(0, idx) : null;
}

/** Messages the loader sends INTO the iframe. */
export type ClientMessage =
  | {
      type: "billkit:init";
      element: ElementKind;
      /** Ephemeral checkout `client_secret` (`<sessionId>_secret_...`). */
      clientSecret: string;
      /**
       * The checkout session id, parsed from `clientSecret` by the loader.
       * The iframe needs it for the `/v1/checkout/sessions/{id}/...` path;
       * it is not a secret (echoed in every response). `null` if the
       * secret wasn't well-formed.
       */
      sessionId: string | null;
      /** API origin the iframe calls for `/element` + `/confirm`. */
      apiBase: string;
      /** Loader version, for iframe-side compatibility checks. */
      loaderVersion: string;
      /** {@link PROTOCOL_VERSION}. Absent from every loader before 1.0. */
      protocol: number;
      theme?: BillKitThemeTokens;
      locale?: string;
      /** Only for the payment-method element. */
      customerId?: string;
    }
  | { type: "billkit:theme"; theme: BillKitThemeTokens }
  | { type: "billkit:submit" }
  /**
   * Ask the element to move keyboard focus to the first control of
   * whatever it is currently showing (the first field on the form, the
   * retry button on the declined panel).
   *
   * Added in loader 0.3.0. An element older than the release that
   * understood it drops the message in `parseInboundMessage`, so the call
   * is a no-op there rather than a failure, which is also why the iframe
   * had to ship this first. See DEVELOPMENT.md, "The protocol is a
   * contract with a separate deployment".
   */
  | { type: "billkit:focus" };

/** Messages the iframe sends OUT to the loader. */
export type HostMessage =
  /**
   * `protocol` is the highest protocol the iframe speaks; 0 when the iframe
   * predates the field.
   */
  | { type: "billkit:ready"; protocol: number }
  | { type: "billkit:resize"; height: number }
  | { type: "billkit:loaded"; sessionId: string }
  /**
   * `payment_method` is the API's name for the chosen method. Elements
   * before 1.0 sent it as `method`, which {@link parseHostMessage} still
   * reads when `payment_method` is absent; the element now sends both.
   */
  | { type: "billkit:change"; complete: boolean; payment_method?: string }
  /**
   * Hand the top window to the provider (3DS / iDEAL / PayPal).
   *
   * **`url` is UNCHECKED here.** `parseHostMessage` asserts only that it
   * is a non-empty string; the target guard (https on a Mollie host) lives
   * at the navigation site,
   * in `ElementController.handleRedirect`, which calls `isSafeRedirectUrl`
   * immediately before `location.assign` and otherwise refuses with
   * `onError({ code: "unsafe_redirect" })`. That single call site is the
   * whole invariant, so `handleRedirect` must stay the only consumer of
   * this message: a second one would be a second path to `location`
   * carrying no guard of its own.
   */
  | { type: "billkit:redirect"; url: string }
  /**
   * A payment is, or is no longer, in flight. Sent on each change, never
   * repeated, routed to `onProcessing`. Added in 1.1: an older element never
   * sends it, so a host must not wait on it to unlock anything it would
   * otherwise leave usable.
   */
  | { type: "billkit:processing"; active: boolean }
  /** Escape was pressed inside the element. Routed to `onEscape`. Added in 1.1. */
  | { type: "billkit:escape" }
  /**
   * The payment completed without leaving the page.
   *
   * `sessionId` is the id of the object the element was mounted for: the
   * checkout session (`cs_…`) for the checkout element, the one-off payment
   * (`osp_…`) for the one-shot element. The wire name predates the one-shot
   * element and is kept so a newer element still talks to an older loader;
   * `mountOneShotPaymentElement` surfaces it to the merchant as
   * `oneShotPaymentId`.
   */
  | { type: "billkit:success"; sessionId: string; paymentStatus: string }
  /**
   * Any terminal failure of the current attempt, routed to `onError`.
   *
   * `code` is a stable machine-readable tag; `message` is the
   * human-readable text, already localised by the element. Codes the
   * iframe sends:
   *
   * - `payment_declined`: the confirm came back with a failed
   *   `payment_status` and no redirect. The element keeps its own retry
   *   panel on screen, so treat this as "this attempt is over", not "the
   *   session is dead": re-enable your pay button rather than navigating
   *   away.
   *
   * The loader adds `load_timeout` and `unsafe_redirect` of its own; see
   * `iframe.ts`. Unknown codes are always possible (a newer element can
   * mint one), so branch on the ones you handle and fall through to
   * `message` for the rest.
   */
  | { type: "billkit:error"; message: string; code?: string };

/**
 * Every `code` `onError` can receive from this version of the SDK.
 *
 * - `load_timeout` (the loader): the iframe never booted within
 *   `loadTimeoutMs`. CSP `frame-src`, an ad blocker or the network.
 * - `unsafe_redirect` (the loader): the element asked for a navigation to a
 *   target that is not an https URL on a Mollie host, and the loader
 *   refused it.
 *
 * The rest come from the element:
 *
 * - `payment_declined`: the confirm came back unpaid. The element keeps
 *   its own retry panel up, so re-enable your button rather than navigate.
 * - `element_crashed`: the element hit an unrecoverable render error and
 *   replaced itself with an error pane. Nothing was charged, and only a
 *   reload recovers it, so re-enable your button and stop waiting.
 * - `no_payment_methods`: nothing the tenant enabled is payable for this
 *   session's currency and the buyer's country. The element refuses to
 *   draw a form rather than show one whose `/confirm` would be rejected.
 *   Nothing was charged and a retry changes nothing: send the buyer to a
 *   surface that can take the payment, and check the price's method
 *   allowlist.
 * - `missing_session_id`: the loader sent a `client_secret` it could not
 *   parse a session id out of. An integration bug, not a buyer one: check
 *   that the secret is the whole `<sessionId>_secret_…` value from
 *   `POST /v1/checkout/sessions`, unmodified.
 * - `missing_client_secret`: the payment-method element was initialised
 *   without a secret at all. Same class: nothing to retry, fix the mount.
 * - `payment_not_open`: the one-shot element was mounted for a one-off
 *   payment that is no longer payable: it expired unpaid or it failed.
 *   Nothing was charged; create a fresh one-shot to take the payment again.
 * - `payment_refunded`: the one-shot was paid and then refunded. Neither a
 *   success nor "nothing was charged": the money went out and came back.
 *   Do not create another one-shot on this signal alone.
 * - `client_secret_expired`: the one-shot's `client_secret` stopped
 *   working (30 minutes after the create; a confirm does not extend it),
 *   so the element can no longer show the payment. Its status is unknown
 *   here: it may have been paid, or be a bank transfer still in flight.
 *   Retrieve the one-shot server-side (`GET /v1/checkout/one_shot/{id}`)
 *   or wait for its webhook before creating another, or you risk charging
 *   the buyer twice.
 * - `client_secret_invalid`: the API refused the one-shot's
 *   `client_secret` for any other reason (not a one-shot secret, or one it
 *   does not know). An integration fault: pass the whole value from the
 *   create response, unmodified.
 * - `session_expired`: the checkout session expired, or its
 *   `client_secret` window closed. Final: create a new session.
 * - `session_closed`: the checkout session is no longer open for another
 *   reason (completed elsewhere, or overtaken by a session that bought the
 *   same thing). Final. Look the session up server-side before creating
 *   another: it may have been paid.
 * - `payment_in_progress`: a payment for this checkout is already in
 *   flight (the buyer came back from 3-D Secure or their bank without
 *   finishing, or an earlier answer was lost). The element shows the way
 *   back to it; nothing new was charged. Re-enable your button: a submit
 *   then continues to that payment's page, or, where it has none, looks
 *   again and sends `payment_in_progress` again while it is still in flight.
 * - `request_timeout`: a request to the API got no answer in time. The
 *   element keeps its retry on offer, after re-reading the session when a
 *   confirm's outcome is unknown.
 *
 * On the one-shot element `payment_declined` is final: a one-off payment
 * makes at most one provider payment, so the element shows no retry and
 * the merchant has to create a new one-shot for the buyer to try again.
 *
 * Not exhaustive at runtime: `code` is passed through verbatim, so branch
 * on the ones you handle and fall back to `message`.
 */
export const ELEMENT_ERROR_CODES = [
  // From the loader itself.
  "load_timeout",
  "unsafe_redirect",
  // From the element.
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
] as const;

/**
 * A `code` the SDK knows. `BillKitElementError.code` is wider than this
 * (`ElementErrorCode | (string & {})`): a newer element can send one this
 * loader has never seen, and it reaches `onError` verbatim.
 */
export type ElementErrorCode = (typeof ELEMENT_ERROR_CODES)[number];

const HOST_MESSAGE_TYPES = new Set<HostMessage["type"]>([
  "billkit:ready",
  "billkit:resize",
  "billkit:loaded",
  "billkit:change",
  "billkit:redirect",
  "billkit:processing",
  "billkit:escape",
  "billkit:success",
  "billkit:error",
]);

/**
 * The only host family the element ever sends the buyer to. Every
 * `billkit:redirect` the element emits carries the payment provider's own
 * checkout link (`_links.checkout.href`: 3-D Secure, iDEAL, PayPal), which
 * Mollie serves from `mollie.com`. The merchant's success and cancel pages
 * are reached by Mollie redirecting back, never by the element.
 */
const PROVIDER_HOST = "mollie.com";

/**
 * True when `url` is an absolute `https` URL on `mollie.com` or one of its
 * subdomains, with no credentials in it: the only targets the element has a
 * reason to send the top window to.
 *
 * The loader navigates the **top** window to this value, so a
 * `javascript:` URL would execute in the *merchant's* origin, and any other
 * https URL would let whatever controls the element send the merchant's
 * buyers somewhere of its choosing. Since the value arrives over
 * postMessage, honouring it unchecked would turn an XSS confined to the
 * element document (js.billkit.eu) into a same-origin-policy escape, or a
 * phishing redirect, on every page hosting the element. The origin +
 * source checks make that a narrow path, but the check costs nothing and
 * removes the escalation entirely.
 */
export function isSafeRedirectUrl(url: unknown): url is string {
  if (typeof url !== "string" || url === "") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    const host = parsed.hostname.toLowerCase();
    return host === PROVIDER_HOST || host.endsWith(`.${PROVIDER_HOST}`);
  } catch {
    // Relative or malformed. The provider always sends an absolute URL,
    // so anything unparseable is not something to navigate to.
    return false;
  }
}

/** A protocol number from the wire: a non-negative integer, else 0. */
export function protocolOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Largest iframe height the loader will apply, in CSS pixels. */
const MAX_ELEMENT_HEIGHT_PX = 5000;

function isFiniteHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Narrow an untrusted `MessageEvent.data` to a {@link HostMessage}.
 * Returns `null` for anything that isn't a recognised BillKit message.
 *
 * The caller has already checked `origin` + `source`, but those only
 * establish *who* sent the message, not that its payload matches the
 * declared type. Without per-variant checks the `HostMessage` union is a
 * lie at runtime: a `billkit:success` with no `sessionId` would still be
 * handed to the tenant's `onSuccess` typed as `string`, and their first
 * property access would throw inside our callback. Validate the fields
 * each variant actually carries, and drop the message otherwise.
 */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Record<string, unknown>;
  if (typeof candidate["type"] !== "string") return null;
  if (!HOST_MESSAGE_TYPES.has(candidate["type"] as HostMessage["type"])) return null;

  switch (candidate["type"] as HostMessage["type"]) {
    case "billkit:ready":
      // A missing or malformed protocol is not a reason to drop the ready:
      // that would wedge the handshake. It reads as an iframe that predates
      // the field.
      return { type: "billkit:ready", protocol: protocolOf(candidate["protocol"]) };

    case "billkit:resize": {
      // Clamped rather than dropped: a bad height should not wedge the
      // element at its initial size, and an unbounded one is a layout DoS
      // on the merchant's page.
      if (!isFiniteHeight(candidate["height"])) return null;
      return {
        type: "billkit:resize",
        height: Math.min(candidate["height"], MAX_ELEMENT_HEIGHT_PX),
      };
    }

    case "billkit:loaded": {
      if (typeof candidate["sessionId"] !== "string") return null;
      return { type: "billkit:loaded", sessionId: candidate["sessionId"] };
    }

    case "billkit:change": {
      if (typeof candidate["complete"] !== "boolean") return null;
      // `method` is the pre-1.0 element's name for the same field, read
      // only when `payment_method` is absent.
      const current = candidate["payment_method"];
      const legacy = candidate["method"];
      const paymentMethod =
        typeof current === "string" ? current : typeof legacy === "string" ? legacy : undefined;
      return {
        type: "billkit:change",
        complete: candidate["complete"],
        ...(paymentMethod !== undefined ? { payment_method: paymentMethod } : {}),
      };
    }

    case "billkit:redirect": {
      // Shape only: any non-empty string is a well-formed *message*, and
      // whether it is a safe *target* is decided at the navigation site.
      //
      // This used to call `isSafeRedirectUrl` and return null, which made
      // the documented `onError({ code: "unsafe_redirect" })` unreachable:
      // the refusal branch in `ElementController.handleRedirect` could
      // never run, and a merchant saw nothing but a "dropped a malformed
      // message" logger line, on the one event that is a security
      // refusal rather than a version skew. The guard itself did not move;
      // `handleRedirect` still re-checks before `location.assign`, which
      // is the line that matters.
      if (typeof candidate["url"] !== "string" || candidate["url"] === "") return null;
      return { type: "billkit:redirect", url: candidate["url"] };
    }

    case "billkit:processing": {
      if (typeof candidate["active"] !== "boolean") return null;
      return { type: "billkit:processing", active: candidate["active"] };
    }

    case "billkit:escape":
      return { type: "billkit:escape" };

    case "billkit:success": {
      if (
        typeof candidate["sessionId"] !== "string" ||
        typeof candidate["paymentStatus"] !== "string"
      ) {
        return null;
      }
      return {
        type: "billkit:success",
        sessionId: candidate["sessionId"],
        paymentStatus: candidate["paymentStatus"],
      };
    }

    case "billkit:error": {
      if (typeof candidate["message"] !== "string") return null;
      const code = candidate["code"];
      return {
        type: "billkit:error",
        message: candidate["message"],
        ...(typeof code === "string" ? { code } : {}),
      };
    }
  }
}
