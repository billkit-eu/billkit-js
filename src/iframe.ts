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
   * Accessible name for the element's `<iframe>`, announced by screen
   * readers as they move through your page.
   *
   * Defaults to "BillKit secure checkout" / "BillKit saved payment
   * methods" per element kind. Those defaults are English, and the frame
   * title is the one string of ours that lives on YOUR page rather than
   * inside the element, so it is the one `locale` cannot reach. Set it
   * when the rest of your page is not in English.
   */
  title?: string;
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
  /**
   * Ask the iframe to submit the current form (external pay button).
   *
   * Safe to call before the element has booted: one pending submit is
   * queued and flushed as soon as the `ready`→`init` handshake completes.
   */
  submit(): void;
  /**
   * Move keyboard focus into the element, onto the first control of
   * whatever it is currently showing.
   *
   * For a page that reveals the element in a step or a drawer: focus has
   * to cross the iframe boundary deliberately, because your page cannot
   * reach inside a cross-origin frame to do it. A call before the element
   * has booted is dropped rather than queued: there is nothing to focus
   * yet, and the buyer will have moved on by the time there is.
   */
  focus(): void;
  /** Push new theme tokens into a mounted element. */
  updateTheme(theme: BillKitThemeTokens): void;
  /** Tear down: remove the iframe and detach all listeners. */
  destroy(): void;
}

/** The iframe's default accessible name, per element kind. */
const DEFAULT_IFRAME_TITLE: Record<ElementKind, string> = {
  checkout: "BillKit secure checkout",
  "payment-method": "BillKit saved payment methods",
};

/**
 * Marks an iframe as ours, so a second mount into the same container can
 * be spotted. A `data-` attribute rather than a class: a merchant's own
 * stylesheet will not collide with it, and it survives their CSS reset.
 */
const ELEMENT_MARKER = "data-billkit-element";

/**
 * A mount target, named well enough to find in a template, and nothing
 * more. Selector strings are the merchant's own, and an id is the only
 * thing worth echoing back from a resolved node.
 */
function describeTarget(target: HTMLElement | string): string {
  if (typeof target === "string") return target;
  return target.id ? `#${target.id}` : target.tagName.toLowerCase();
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
  private ready = false;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A `submit()` that arrived before the iframe could hear it.
   *
   * Posting into a frame with no listener yet is a silent drop, and the
   * shape that produces it is ordinary: a merchant's own pay button is
   * clickable the moment their page renders, which can be well before a
   * third-party frame has booted. The buyer pressed pay and nothing
   * happened, with no callback to say why.
   *
   * One pending call, not a queue: a second press before boot means the
   * same intent, not a second payment.
   */
  private pendingSubmit = false;
  /**
   * The theme the iframe should be showing.
   *
   * Seeded from the constructor options and replaced by every
   * `updateTheme()` call, so the token set is stored in exactly one
   * place. `sendInit` reads it rather than `options.theme`: the init
   * handshake happens whenever the iframe finishes booting, which can be
   * well after a caller has already switched themes (a dark-mode toggle
   * fired during a slow bundle fetch), and replaying the constructor's
   * theme there would repaint the element back to the stale one.
   */
  private theme: BillKitThemeTokens | undefined;

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
    this.theme = options.theme;
    this.logger = options.logger ?? NOOP_ELEMENT_LOGGER;
    this.customerId = extra.customerId;
    this.origin = (options.iframeOrigin ?? DEFAULT_IFRAME_ORIGIN).replace(/\/$/, "");
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");

    const mountPoint = resolveTarget(target);
    if (mountPoint.querySelector(`iframe[${ELEMENT_MARKER}]`) !== null) {
      // Warned, not thrown. A duplicate mount is almost always a SPA that
      // re-ran an effect without calling `destroy()`, and the second
      // element does work: it just sits under the first one, with two
      // `message` listeners on `window` racing for the same traffic and a
      // container that is now twice as tall. Throwing would take down a
      // page that was otherwise about to take a payment; saying so loudly
      // in the logger is the proportionate answer.
      this.logger.warn("BillKit mounted a second element into a target that already had one", {
        element: this.kind,
        target: describeTarget(target),
        hint: "call destroy() on the first element before mounting another into the same node",
      });
    }
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
    // The frame's accessible name. Per kind, because "secure checkout" on
    // a saved-methods wallet describes a payment the customer is not
    // making, and overridable, because this string lives on the
    // merchant's page and so is the one piece of element copy `locale`
    // cannot reach.
    iframe.title = this.options.title ?? DEFAULT_IFRAME_TITLE[this.kind];
    iframe.setAttribute(ELEMENT_MARKER, this.kind);
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
    // An iframe is `display: inline` by default, so it sits on the text
    // baseline and the line-box leaves a few pixels of descender space
    // under it. On a merchant's page that reads as a stray gap below the
    // payment form that no amount of margin on their container removes,
    // because it is inside ours.
    iframe.style.display = "block";
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
        // `ready` is proof the iframe booted, which is the only thing the
        // watchdog was ever guarding against. What follows — fetching the
        // element bundle's session view over the network — can legitimately
        // outlast `loadTimeoutMs` on a slow connection, and firing
        // `load_timeout` then told the merchant the element had failed
        // while a perfectly working form finished rendering underneath the
        // error they had just shown. The never-boots case still times out,
        // because it never gets here.
        this.clearLoadTimer();
        this.ready = true;
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
      ...(this.theme ? { theme: this.theme } : {}),
      ...(this.options.locale ? { locale: this.options.locale } : {}),
      ...(this.customerId ? { customerId: this.customerId } : {}),
    });
    if (this.pendingSubmit) {
      this.pendingSubmit = false;
      this.logger.debug("BillKit flushing the submit queued before ready", {
        element: this.kind,
      });
      this.post({ type: "billkit:submit" });
    }
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

  /**
   * Submit the element's current form.
   *
   * Before the `ready`→`init` handshake the frame has no listener, so the
   * message is queued and flushed the moment `init` goes out. The element
   * still decides whether it can act on it: a submit that reaches it
   * before its session view has finished loading is ignored there, and the
   * buyer presses pay again, which is the right outcome, and a long way
   * from the silent drop this replaces.
   */
  submit(): void {
    if (!this.ready) {
      this.pendingSubmit = true;
      this.logger.debug("BillKit queued a submit until the element is ready", {
        element: this.kind,
      });
      return;
    }
    this.post({ type: "billkit:submit" });
  }

  /**
   * Move keyboard focus into the element.
   *
   * Not queued, unlike `submit()`: focus is about where the buyer is
   * looking right now, and replaying it after a slow boot would yank the
   * caret out of whatever they had started typing on the host page.
   */
  focus(): void {
    if (!this.ready) {
      this.logger.debug("BillKit dropped a focus() call made before the element was ready", {
        element: this.kind,
      });
      return;
    }
    this.post({ type: "billkit:focus" });
  }

  /**
   * Push new theme tokens into the element.
   *
   * Safe to call at any point in the lifecycle, including before the
   * iframe has booted. A pre-`ready` call used to be posted into a frame
   * with no listener yet and silently dropped, and then `init` replayed
   * the *constructor's* theme over the top — so mounting in light mode
   * and immediately switching to dark left a light element. Storing the
   * tokens is what makes the call stick; the post is the fast path for
   * an element already on screen.
   */
  updateTheme(theme: BillKitThemeTokens): void {
    this.theme = theme;
    if (this.ready) this.post({ type: "billkit:theme", theme });
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
