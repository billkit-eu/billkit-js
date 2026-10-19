import {
  type ClientMessage,
  DEFAULT_API_BASE,
  DEFAULT_IFRAME_ORIGIN,
  type ElementErrorCode,
  type ElementKind,
  type HostMessage,
  PROTOCOL_VERSION,
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
  /**
   * The method the buyer has picked, in the API's vocabulary
   * (`creditcard`, `ideal`, ...). Named as the API names it everywhere
   * else; it was `method` before 1.0.
   */
  payment_method?: string;
}

/** What `onProcessing` receives. */
export interface ProcessingEvent {
  /**
   * True from the moment a submit passes the form's checks until the
   * attempt ends: success, a decline or an error. Stays true while the top
   * window is sent to the bank, since the page is about to go; turns false
   * if your `onRedirect` takes the navigation over, or if the page is still
   * here 15 seconds later (a navigation the buyer cancelled).
   */
  processing: boolean;
}

export interface BillKitElementError {
  /** Human-readable, already localised by the element. */
  message: string;
  /**
   * Machine-readable. Open: a newer element can send a code this SDK does
   * not list in `ELEMENT_ERROR_CODES`, so branch on the ones you handle and
   * fall back to `message`.
   */
  code?: ElementErrorCode | (string & {});
}

/** Options common to every BillKit element. */
export interface BaseElementOptions {
  /**
   * Ephemeral `client_secret` (`<id>_secret_...`): from
   * `POST /v1/checkout/sessions` with `ui_mode: "embedded"` for the
   * checkout and payment-method elements, or from
   * `POST /v1/checkout/one_shot` with `ui_mode: "embedded"` for the
   * one-shot element.
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
   * methods" / "BillKit secure payment" per element kind. Those defaults are English, and the frame
   * title is the one string of ours that lives on YOUR page rather than
   * inside the element, so it is the one `locale` cannot reach. Set it
   * when the rest of your page is not in English.
   */
  title?: string;
  /**
   * Origin the element iframe is served from. Defaults to the BillKit-
   * hosted `https://js.billkit.eu`. Overriding it is the seam for a
   * future tenant custom-domain (CNAME) that BillKit still operates:
   * point it at your vanity host once that's provisioned. Reduced to its
   * origin (`new URL(x).origin`); a value that is not an absolute https
   * URL throws at mount. Plain `http` is accepted only for a loopback host
   * (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`), for local
   * development: the frame receives the `client_secret`, which must not
   * cross the network in clear text.
   */
  iframeOrigin?: string;
  /** API origin the iframe calls for `/element` + `/confirm`. */
  apiBase?: string;
  /**
   * Milliseconds to wait for the element to finish loading before firing
   * `onError({ code: "load_timeout" })`. Guards against a silent hang when
   * the iframe origin is blocked (missing CSP `frame-src`, network/ad
   * blocker) and never boots. Default 20000; pass `0` (or `Infinity`) to
   * disable. A value that is not a number, or is `NaN`, falls back to the
   * default rather than firing at once.
   */
  loadTimeoutMs?: number;
  /** Fired once the iframe has booted and loaded the session. */
  onReady?: () => void;
  /** Fired as the customer edits the form (drives an external pay button). */
  onChange?: (event: ChangeEvent) => void;
  /**
   * Fired when a payment starts and when it stops being in flight. Use it to
   * hold anything that would tear the form down mid-payment, such as the
   * close button of a modal the element sits in. Every `true` is followed by
   * a `false` unless the page leaves for the bank: when the attempt ends,
   * when the element crashes or reloads, when the loader refuses an unsafe
   * redirect, when `onRedirect` returns false, and when a hand-off has not
   * left the page after 15 seconds. An element deployed before 1.1 never
   * fires it, so treat it as a hold to add, never as a gate to wait for.
   */
  onProcessing?: (event: ProcessingEvent) => void;
  /**
   * Fired when Escape is pressed while focus is inside the element, which
   * your page cannot hear on its own. Lets a modal close on Escape wherever
   * focus is. Keys pressed inside the provider's nested card-field frames
   * are not reported. It fires while a payment is processing too, so check
   * your own hold before closing.
   */
  onEscape?: () => void;
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
   * queued and flushed once the element has loaded the session (the
   * moment `onReady` fires). Not earlier: between `init` and `loaded` the
   * element has no form yet and ignores a submit.
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
  "one-shot": "BillKit secure payment",
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

/**
 * Reduce `iframeOrigin` to the exact string a browser puts in
 * `MessageEvent.origin`: scheme, lowercased host and a non-default port, with
 * no path and no trailing slash. Every message from the element is matched
 * against it with `===`, so `https://Pay.Acme.com:443/` written by hand used to
 * mount fine and then drop every message the frame sent. Anything without an
 * https origin is refused at mount rather than producing an element that
 * can never finish loading, and so is `http` anywhere but a loopback host:
 * the `client_secret` is posted into this frame, and an `http` element on a
 * real network hands it to anyone on the path.
 */
function normaliseIframeOrigin(value: string): string {
  const refuse = (): never => {
    throw new Error(
      `BillKit: \`iframeOrigin\` must be an absolute https:// origin (http only for localhost), got ${JSON.stringify(value)}.`,
    );
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse();
  }
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.origin;
  return refuse();
}

/** `localhost`, a `*.localhost` name, `127.0.0.0/8` or `[::1]`. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Longest delay `setTimeout` honours; anything above it fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_LOAD_TIMEOUT_MS = 20_000;
/**
 * How long after sending the top window to the bank the page may still be
 * here before processing is declared over (see `handleRedirect`).
 */
const HANDOFF_GRACE_MS = 15_000;
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
  /** The element has loaded its session and can act on a submit. */
  private loaded = false;
  /** What `onProcessing` last said, so a repeat or a refusal reports only a change. */
  private processing = false;
  /**
   * The protocol the iframe announced in `billkit:ready` (0 before it
   * announced one). Kept so a later loader can gate a newer message on what
   * the element in front of it understands.
   */
  private iframeProtocol = 0;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  /** See `handleRedirect`: ends processing when a hand-off never left the page. */
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.origin = normaliseIframeOrigin(options.iframeOrigin ?? DEFAULT_IFRAME_ORIGIN);
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
    // The one-shot form is the checkout element's own page, told which
    // kind it is by `billkit:init`; only the wallet has a page of its own.
    const path = this.kind === "payment-method" ? "/methods" : "/embed";
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
    // a `billkit:redirect` message and the loader performs them only after
    // `isSafeRedirectUrl` accepts the target, which admits nothing but an
    // https URL on Mollie's own domains (`mollie.com`, `mollie.nl` and their
    // subdomains).
    // So the frame never steers the top window itself, and a compromised
    // element can send the merchant's page to Mollie's checkout and
    // nowhere else: not to a phishing clone of the merchant.
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
        this.iframeProtocol = message.protocol;
        if (message.protocol > PROTOCOL_VERSION) {
          // A newer element in front of an older loader is the normal state
          // of a merchant who has not upgraded. It still honours this
          // loader's protocol, so this is information, not a problem.
          this.logger.debug("BillKit element speaks a newer protocol; using this loader's", {
            element: this.kind,
            elementProtocol: message.protocol,
            loaderProtocol: PROTOCOL_VERSION,
          });
        }
        // `ready` is proof the iframe booted, which is the only thing the
        // watchdog was ever guarding against. What follows (fetching the
        // element bundle's session view over the network) can legitimately
        // outlast `loadTimeoutMs` on a slow connection, and firing
        // `load_timeout` then told the merchant the element had failed
        // while a perfectly working form finished rendering underneath the
        // error they had just shown. The never-boots case still times out,
        // because it never gets here.
        this.clearLoadTimer();
        // A second `ready` is the frame reloading, which loses whatever it was
        // doing: an attempt in flight there will never report its end.
        if (this.ready) this.setProcessing(false);
        this.ready = true;
        this.loaded = false;
        this.logger.debug("BillKit element ready; sending init", {
          element: this.kind,
          elementProtocol: this.iframeProtocol,
        });
        this.sendInit();
        break;
      case "billkit:loaded":
        this.clearLoadTimer();
        this.loaded = true;
        this.logger.debug("BillKit element loaded", { element: this.kind });
        this.flushPendingSubmit();
        this.options.onReady?.();
        break;
      case "billkit:resize":
        this.iframe.style.height = `${message.height}px`;
        break;
      case "billkit:change":
        this.options.onChange?.({
          complete: message.complete,
          ...(message.payment_method !== undefined
            ? { payment_method: message.payment_method }
            : {}),
        });
        break;
      case "billkit:redirect":
        this.handleRedirect(message.url);
        break;
      case "billkit:processing":
        this.setProcessing(message.active);
        break;
      case "billkit:escape":
        this.options.onEscape?.();
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
    const raw = this.options.loadTimeoutMs;
    // `NaN <= 0` is false and `setTimeout(fn, NaN)` fires at once, so a
    // NaN (an unparsed env var, typically) used to report `load_timeout`
    // on every mount. It means "not configured", so it gets the default.
    const ms = typeof raw === "number" && !Number.isNaN(raw) ? raw : DEFAULT_LOAD_TIMEOUT_MS;
    // `Infinity`, or any delay past what `setTimeout` can hold, would also
    // fire at once; both can only mean "never".
    if (ms <= 0 || ms > MAX_TIMEOUT_MS) return;
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
      protocol: PROTOCOL_VERSION,
      ...(this.theme ? { theme: this.theme } : {}),
      ...(this.options.locale ? { locale: this.options.locale } : {}),
      ...(this.customerId ? { customerId: this.customerId } : {}),
    });
  }

  /**
   * Post the submit queued before boot, now that the element can act on
   * it. Flushed on `loaded`, not after `init`: the element only starts
   * fetching the session on `init`, and a submit that lands while it is
   * still loading is dropped in silence, which is the very thing the
   * queue exists to prevent.
   */
  private flushPendingSubmit(): void {
    if (!this.pendingSubmit) return;
    this.pendingSubmit = false;
    this.logger.debug("BillKit flushing the submit queued before the element loaded", {
      element: this.kind,
    });
    this.post({ type: "billkit:submit" });
  }

  /** Report a change of `processing`, once per change. */
  private setProcessing(processing: boolean): void {
    if (processing === this.processing) return;
    this.processing = processing;
    this.options.onProcessing?.({ processing });
  }

  private handleRedirect(url: string): void {
    // The one guard on this navigation: `parseHostMessage` checks the
    // message's shape only, so a `javascript:` URL, or an https URL on a
    // host that is not Mollie's, arrives here and is refused here. This is
    // the line that would otherwise turn an element-scoped XSS into a
    // same-origin-policy escape onto the merchant's page, or a redirect of
    // the merchant's buyers to a page of the attacker's choosing.
    if (!isSafeRedirectUrl(url)) {
      // A security refusal, not a payment failure. Worth a warning even
      // though `onError` also fires, since the merchant's error handler
      // usually shows a toast and moves on.
      this.logger.warn("BillKit refused an unsafe redirect", { element: this.kind });
      this.options.onError?.({
        message: "Refused to follow an unsafe redirect target.",
        code: "unsafe_redirect",
      });
      // The element is still showing its hand-off pane and will not say the
      // attempt is over, because from where it sits the page is leaving.
      // Nothing is in flight that the host can wait for.
      this.setProcessing(false);
      return;
    }
    // Let the tenant intercept (return false) before we take over the top
    // window. 3DS/iDEAL pages set X-Frame-Options and can't render inside
    // our iframe, so the redirect must be top-level.
    const proceed = this.options.onRedirect?.(url);
    if (proceed === false) {
      this.logger.debug("BillKit redirect deferred to the host page", { element: this.kind });
      // The host owns the navigation now (a popup, its own state first, or
      // nothing at all), and the element waits on its hand-off pane with no
      // way of hearing how it went. Holding the host's modal shut on top of
      // that would leave it no way out.
      this.setProcessing(false);
      return;
    }
    // The origin only. The full URL carries provider-side payment
    // identifiers in its path and query.
    this.logger.debug("BillKit redirecting the top window", {
      element: this.kind,
      target: safeOriginOf(url),
    });
    // The `href` setter, not `assign()`. When the merchant's page is itself
    // framed by another origin, `window.top` is a cross-origin window, and
    // of its `Location` only the `href` setter and `replace()` may be
    // touched; `assign()` throws a SecurityError. `replace()` would also
    // drop the merchant's page from the buyer's history, so the back button
    // from the bank would skip it.
    try {
      (window.top ?? window).location.href = url;
    } catch {
      // Top navigation itself refused (a sandboxed frame without
      // `allow-top-navigation`), so navigate the frame we are in instead.
      window.location.assign(url);
    }
    // A navigation can be cancelled without a word: the buyer answers a
    // `beforeunload` prompt with "Stay". The page is still here, the element
    // still shows its hand-off pane, and nothing will ever end processing.
    // So if the page has not gone after a while, stop holding the host. A bank
    // page that is merely slow still loads, since the top window is already
    // on its way there.
    this.clearHandoffTimer();
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = null;
      if (!this.destroyed) this.setProcessing(false);
    }, HANDOFF_GRACE_MS);
  }

  private clearHandoffTimer(): void {
    if (this.handoffTimer !== null) {
      clearTimeout(this.handoffTimer);
      this.handoffTimer = null;
    }
  }

  /**
   * Submit the element's current form.
   *
   * Until the element has loaded its session (`billkit:loaded`, the moment
   * `onReady` fires) it has no form and ignores a submit, and before
   * `ready` the frame has no listener at all, so a submit made in either
   * window is queued (one at most) and flushed on `loaded`. An element
   * that errors before loading never sends `loaded`, so the queued submit
   * is dropped: `onError` has fired and there is nothing to submit.
   */
  submit(): void {
    if (!this.loaded) {
      this.pendingSubmit = true;
      this.logger.debug("BillKit queued a submit until the element has loaded", {
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
   * the *constructor's* theme over the top, so mounting in light mode
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
    this.clearHandoffTimer();
    window.removeEventListener("message", this.onMessage);
    this.iframe.remove();
    // Last, once nothing can be left behind if the host's handler throws:
    // a payment the host was told is in flight is over as far as the host
    // can tell. The frame that would have said so is gone, and its own
    // unmount notice has no listener left. Without this a modal holding
    // its close on `processing` stays shut.
    this.setProcessing(false);
  }
}
