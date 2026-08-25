import {
  type ClientMessage,
  DEFAULT_API_BASE,
  DEFAULT_IFRAME_ORIGIN,
  type ElementKind,
  type HostMessage,
  isSafeRedirectUrl,
  parseHostMessage,
  sessionIdFromClientSecret,
} from "./protocol";
import { NOOP_ELEMENT_LOGGER, type BillKitElementLogger } from "./logging";
import type { BillKitThemeTokens } from "./theme";
import { VERSION } from "./version";

export interface SuccessEvent {
  sessionId: string;
  paymentStatus: string;
}

export interface ChangeEvent {
  complete: boolean;
  method?: string;
}

export interface BillKitElementError {
  message: string;
  code?: string;
}

/** Options common to every BillKit element. */
export interface BaseElementOptions {
  /**
   * Ephemeral checkout `client_secret` (`<sessionId>_secret_...`) from
   * `POST /v1/checkout/sessions` with `ui_mode: "embedded"`.
   */
  clientSecret: string;
  /** Theme tokens forwarded to the iframe (colour / radius / font). */
  theme?: BillKitThemeTokens;
  /** BCP-47 locale, e.g. `"nl"`. Defaults to the customer's browser. */
  locale?: string;
  /**
   * Origin the element iframe is served from. Defaults to the BillKit-
   * hosted `https://js.billkit.eu`. Overriding it is the seam for a
   * future tenant custom-domain (CNAME) that BillKit still operates:
   * point it at your vanity host once that's provisioned.
   */
  iframeOrigin?: string;
  /** API origin the iframe calls for `/element` + `/confirm`. */
  apiBase?: string;
  /**
   * Milliseconds to wait for the element to finish loading before firing
   * `onError({ code: "load_timeout" })`. Guards against a silent hang when
   * the iframe origin is blocked (missing CSP `frame-src`, network/ad
   * blocker) and never boots. Default 20000; pass `0` to disable.
   */
  loadTimeoutMs?: number;
  /** Fired once the iframe has booted and loaded the session. */
  onReady?: () => void;
  /** Fired as the customer edits the form (drives an external pay button). */
  onChange?: (event: ChangeEvent) => void;
  /**
   * Fired when the payment reaches a terminal success without a redirect.
   * Redirect-based methods (3DS / iDEAL) navigate the top window instead;
   * see {@link BaseElementOptions.onRedirect}.
   */
  onSuccess?: (event: SuccessEvent) => void;
  /** Fired on any element or payment error. */
  onError?: (error: BillKitElementError) => void;
  /**
   * Where to send the element's lifecycle diagnostics: iframe boot,
   * the `ready`→`init` handshake, dropped `postMessage`s, refused
   * redirects, load timeouts. Omitted (the default) means a no-op: the
   * loader never writes to `console` on its own.
   *
   * `console` works as-is. The `clientSecret` is never passed to it;
   * see {@link BillKitElementLogger}.
   */
  logger?: BillKitElementLogger;
  /**
   * Called just before the loader redirects the TOP window to Mollie for
   * 3DS / bank authorisation. Return `false` to take over navigation
   * yourself (e.g. to persist state first). Default: navigate immediately.
   */
  onRedirect?: (url: string) => boolean | void;
}

/** Handle returned from every mount, to control the element afterwards. */
export interface BillKitElementHandle {
  /** Ask the iframe to submit the current form (external pay button). */
  submit(): void;
  /** Push new theme tokens into a mounted element. */
  updateTheme(theme: BillKitThemeTokens): void;
  /** Tear down: remove the iframe and detach all listeners. */
  destroy(): void;
}

/**
 * The origin of an absolute URL, for logging only.
 *
 * A 3DS / iDEAL redirect URL carries provider payment identifiers in its
 * path and query. "we sent the customer to https://www.mollie.com" is
 * the useful part for debugging; the rest is not ours to copy into the
 * merchant's log sink.
 */
function safeOriginOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(unparseable)";
  }
}

function resolveTarget(target: HTMLElement | string): HTMLElement {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!(el instanceof HTMLElement)) {
    throw new Error(
      `BillKit: mount target ${JSON.stringify(target)} was not found in the DOM.`,
    );
  }
  return el;
}

/**
 * Owns one element iframe: creation, the `ready`→`init` handshake, inbound
 * message validation/routing, resize, redirect, and teardown. Both
 * `<CheckoutElement/>` and `<PaymentMethodElement/>` are thin wrappers
 * over this.
 */
export class ElementController implements BillKitElementHandle {
  private readonly origin: string;
  private readonly apiBase: string;
  private readonly iframe: HTMLIFrameElement;
  private readonly options: BaseElementOptions;
  private readonly kind: ElementKind;
  private readonly customerId: string | undefined;
  private readonly onMessage: (event: MessageEvent) => void;
  private readonly logger: BillKitElementLogger;
  private destroyed = false;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    target: HTMLElement | string,
    kind: ElementKind,
    options: BaseElementOptions,
    extra: { customerId?: string } = {},
  ) {
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("BillKit elements can only be mounted in a browser.");
    }
    if (!options.clientSecret) {
      throw new Error("BillKit: `clientSecret` is required.");
    }

    this.kind = kind;
    this.options = options;
    this.logger = options.logger ?? NOOP_ELEMENT_LOGGER;
    this.customerId = extra.customerId;
    this.origin = (options.iframeOrigin ?? DEFAULT_IFRAME_ORIGIN).replace(/\/$/, "");
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");

    const mountPoint = resolveTarget(target);
    this.iframe = this.createIframe();
    mountPoint.appendChild(this.iframe);
    this.logger.debug("BillKit element mounting", {
      element: this.kind,
      origin: this.origin,
      apiBase: this.apiBase,
      loaderVersion: VERSION,
    });

    this.startLoadTimer();
    this.onMessage = (event) => this.handleMessage(event);
    // Origin IS validated: `handleMessage` rejects any event whose
    // `origin` isn't exactly `this.origin` (and whose `source` isn't this
    // iframe) before touching the payload. The check lives in the handler,
    // not this line, so the static rule can't see it.
    // nosemgrep: javascript.browser.security.insufficient-postmessage-origin-validation.insufficient-postmessage-origin-validation
    window.addEventListener("message", this.onMessage);
  }

  private createIframe(): HTMLIFrameElement {
    const iframe = document.createElement("iframe");
    const path = this.kind === "checkout" ? "/embed" : "/methods";
    // No secret in the URL. The client_secret is delivered over
    // postMessage after the ready handshake.
    iframe.src = `${this.origin}${path}`;
    iframe.title = "BillKit secure checkout";
    iframe.setAttribute("allow", "payment");
    // Defence in depth. The frame is already cross-origin, so the
    // same-origin policy stops it reaching into the merchant's page; the
    // sandbox constrains what it could do if the element origin itself
    // were ever compromised (a dependency in the checkout bundle, a
    // stored-XSS in a merchant-supplied field we render).
    //
    // Grant list, and why each is needed:
    //   allow-scripts       : the element is a React app.
    //   allow-same-origin   : it needs its own origin's fetch credentials
    //                         and storage. Safe here precisely because
    //                         the frame is cross-origin: the pair only
    //                         becomes an escape when a frame is sandboxed
    //                         from its *own* parent's origin.
    //   allow-forms         : Mollie Components submit a form for 3DS.
    //   allow-popups + ...-to-escape-sandbox: some issuer 3DS flows open a
    //                         bank window, which must not inherit this
    //                         sandbox or the bank's own page breaks.
    //
    // Deliberately absent: `allow-top-navigation`. Redirects travel up as
    // a `billkit:redirect` message and the loader performs them after
    // `isSafeRedirectUrl`, so the frame never needs to steer the top
    // window itself, and withholding it is what stops a compromised
    // element from navigating the merchant's page to a phishing clone.
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );
    iframe.setAttribute("loading", "eager");
    iframe.style.border = "0";
    iframe.style.width = "100%";
    iframe.style.minHeight = "120px";
    iframe.style.colorScheme = "normal";
    return iframe;
  }

  private post(message: ClientMessage): void {
    // Always target the specific BillKit origin, never "*".
    this.iframe.contentWindow?.postMessage(message, this.origin);
  }

  private handleMessage(event: MessageEvent): void {
    if (this.destroyed) return;
    // 1. Origin must be exactly the element origin.
    if (event.origin !== this.origin) {
      // Not logged: a page can host any number of unrelated frames and
      // widgets all posting to `window`, so almost every message that
      // lands here is simply not ours. Logging them would drown the
      // signal and leak other integrations' traffic into this sink.
      return;
    }
    // 2. Correlate to THIS iframe (two elements can share a page).
    if (event.source !== this.iframe.contentWindow) {
      // Right origin, different frame. That is the normal case when a checkout
      // and a payment-method element share a page.
      this.logger.debug("BillKit ignoring message from another element", {
        element: this.kind,
      });
      return;
    }
    const message = parseHostMessage(event.data);
    if (message === null) {
      // Our own origin, our own frame, and the payload still failed
      // validation. That is a version skew or a bug, never routine, and
      // it is otherwise completely invisible from the outside.
      this.logger.warn("BillKit dropped a malformed message", {
        element: this.kind,
        // The *type* only. Payloads can carry session detail.
        type:
          typeof (event.data as { type?: unknown } | null)?.type === "string"
            ? (event.data as { type: string }).type
            : null,
      });
      return;
    }
    this.route(message);
  }

  private route(message: HostMessage): void {
    switch (message.type) {
      case "billkit:ready":
        this.logger.debug("BillKit element ready; sending init", { element: this.kind });
        this.sendInit();
        break;
      case "billkit:loaded":
        this.clearLoadTimer();
        this.logger.debug("BillKit element loaded", { element: this.kind });
        this.options.onReady?.();
        break;
      case "billkit:resize":
        this.iframe.style.height = `${message.height}px`;
        break;
      case "billkit:change":
        this.options.onChange?.({ complete: message.complete, method: message.method });
        break;
      case "billkit:redirect":
        this.handleRedirect(message.url);
        break;
      case "billkit:success":
        this.options.onSuccess?.({
          sessionId: message.sessionId,
          paymentStatus: message.paymentStatus,
        });
        break;
      case "billkit:error":
        // The iframe booted far enough to report an error, so cancel the
        // load watchdog so we don't also fire a spurious load_timeout.
        this.clearLoadTimer();
        this.options.onError?.({ message: message.message, code: message.code });
        break;
    }
  }

  private startLoadTimer(): void {
    const ms = this.options.loadTimeoutMs ?? 20_000;
    if (ms <= 0) return;
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      if (this.destroyed) return;
      this.logger.warn("BillKit element failed to load", {
        element: this.kind,
        origin: this.origin,
        timeoutMs: ms,
        hint: "the iframe never booted; check CSP frame-src, network and ad blockers",
      });
      this.options.onError?.({
        message:
          "The checkout could not be loaded. Check the connection and that " +
          "js.billkit.eu is allowed to load, then try again.",
        code: "load_timeout",
      });
    }, ms);
  }

  private clearLoadTimer(): void {
    if (this.loadTimer !== null) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
  }

  private sendInit(): void {
    this.post({
      type: "billkit:init",
      element: this.kind,
      clientSecret: this.options.clientSecret,
      sessionId: sessionIdFromClientSecret(this.options.clientSecret),
      apiBase: this.apiBase,
      loaderVersion: VERSION,
      ...(this.options.theme ? { theme: this.options.theme } : {}),
      ...(this.options.locale ? { locale: this.options.locale } : {}),
      ...(this.customerId ? { customerId: this.customerId } : {}),
    });
  }

  private handleRedirect(url: string): void {
    // Defence in depth: `parseHostMessage` already drops any redirect whose
    // URL is not absolute http(s), so a `javascript:` URL can never reach
    // here. Re-checking at the navigation site keeps the guarantee local to
    // the dangerous call. This is the line that would turn an
    // element-scoped XSS into a same-origin-policy escape onto the
    // merchant's page.
    if (!isSafeRedirectUrl(url)) {
      // A security refusal, not a payment failure. Worth a warning even
      // though `onError` also fires, since the merchant's error handler
      // usually shows a toast and moves on.
      this.logger.warn("BillKit refused an unsafe redirect", { element: this.kind });
      this.options.onError?.({
        message: "Refused to follow an unsafe redirect target.",
        code: "unsafe_redirect",
      });
      return;
    }
    // Let the tenant intercept (return false) before we take over the top
    // window. 3DS/iDEAL pages set X-Frame-Options and can't render inside
    // our iframe, so the redirect must be top-level.
    const proceed = this.options.onRedirect?.(url);
    if (proceed === false) {
      this.logger.debug("BillKit redirect deferred to the host page", { element: this.kind });
      return;
    }
    // The origin only. The full URL carries provider-side payment
    // identifiers in its path and query.
    this.logger.debug("BillKit redirecting the top window", {
      element: this.kind,
      target: safeOriginOf(url),
    });
    try {
      (window.top ?? window).location.assign(url);
    } catch {
      // Cross-origin top access blocked, so fall back to this window.
      window.location.assign(url);
    }
  }

  submit(): void {
    this.post({ type: "billkit:submit" });
  }

  updateTheme(theme: BillKitThemeTokens): void {
    this.post({ type: "billkit:theme", theme });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.logger.debug("BillKit element destroyed", { element: this.kind });
    this.clearLoadTimer();
    window.removeEventListener("message", this.onMessage);
    this.iframe.remove();
  }
}
