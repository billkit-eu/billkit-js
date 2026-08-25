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

/** Where the iframe calls the confirm/element API by default. */
export const DEFAULT_API_BASE = "https://api.billkit.eu";

export type ElementKind = "checkout" | "payment-method";

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
      theme?: BillKitThemeTokens;
      locale?: string;
      /** Only for the payment-method element. */
      customerId?: string;
    }
  | { type: "billkit:theme"; theme: BillKitThemeTokens }
  | { type: "billkit:submit" };

/** Messages the iframe sends OUT to the loader. */
export type HostMessage =
  | { type: "billkit:ready" }
  | { type: "billkit:resize"; height: number }
  | { type: "billkit:loaded"; sessionId: string }
  | { type: "billkit:change"; complete: boolean; method?: string }
  | { type: "billkit:redirect"; url: string }
  | { type: "billkit:success"; sessionId: string; paymentStatus: string }
  | { type: "billkit:error"; message: string; code?: string };

const HOST_MESSAGE_TYPES = new Set<HostMessage["type"]>([
  "billkit:ready",
  "billkit:resize",
  "billkit:loaded",
  "billkit:change",
  "billkit:redirect",
  "billkit:success",
  "billkit:error",
]);

/** Schemes the loader will hand to `location.assign`. */
const SAFE_REDIRECT_SCHEMES = new Set(["http:", "https:"]);

/**
 * True when `url` is a same-window-navigable absolute HTTP(S) URL.
 *
 * The loader navigates the **top** window to this value, so a
 * `javascript:` URL would execute in the *merchant's* origin. Since the
 * value arrives over postMessage, honouring it unchecked would turn an
 * XSS confined to the element document (js.billkit.eu) into a
 * same-origin-policy escape onto every page hosting the element. The
 * origin + source checks make that a narrow path, but the check costs
 * nothing and removes the escalation entirely.
 */
export function isSafeRedirectUrl(url: unknown): url is string {
  if (typeof url !== "string" || url === "") return false;
  try {
    return SAFE_REDIRECT_SCHEMES.has(new URL(url).protocol);
  } catch {
    // Relative or malformed. The provider always sends an absolute URL,
    // so anything unparseable is not something to navigate to.
    return false;
  }
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
      return { type: "billkit:ready" };

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
      const method = candidate["method"];
      return {
        type: "billkit:change",
        complete: candidate["complete"],
        ...(typeof method === "string" ? { method } : {}),
      };
    }

    case "billkit:redirect": {
      if (!isSafeRedirectUrl(candidate["url"])) return null;
      return { type: "billkit:redirect", url: candidate["url"] };
    }

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
