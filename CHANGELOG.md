# Changelog

All notable changes to the BillKit browser SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioned independently of the server SDKs. `@billkit-eu/react` tracks this
package through a peer dependency, so a breaking change here is a breaking
change there.

## [1.1.1] - 2026-10-18

### Fixed
- Live card payments that need 3-D Secure failed with `unsafe_redirect`
  ("Refused to follow an unsafe redirect target."). Mollie sends a live
  card's 3-D Secure step through `pay.mollie.nl`, and the loader only
  accepted `mollie.com`. Redirects to `mollie.nl` and its subdomains are
  now followed too; every other host is still refused. Test mode never
  showed it, because Mollie's simulated pages are on `www.mollie.com`.

## [1.1.0] - 2026-10-15

### Added
- `onProcessing({ processing })`: true from the press of Pay until the
  attempt ends, so a host can hold a modal's close while a payment is in
  flight. Every `true` is followed by a `false` unless the page leaves for
  the bank, including when the element crashes or reloads, when the loader
  refuses an unsafe redirect, when `onRedirect` returns `false`, and when
  the page is still here 15 seconds after a hand-off. Not raised for a payment left pending (a bank
  transfer), which can stay that way for days.
- `onEscape()`: Escape pressed inside the element, which the host page
  cannot hear across the frame.
- `ProcessingEvent`.

Both ride new `billkit:processing` and `billkit:escape` messages. Additive:
the protocol stays at 1, an older loader drops them, and an element deployed
before them never sends them, so neither callback fires there.

## [1.0.0] - 2026-10-14

The first stable release. From here on the package follows semantic
versioning, and the loader-to-element protocol is versioned separately so it
can evolve without breaking a loader already in a merchant's bundle. Getting
there took a deliberate break from 0.x, listed under **Upgrading from 0.x**.

### Added
- **A versioned loader-to-element protocol.** `billkit:init` carries
  `protocol: 1`, and the element announces its own protocol in
  `billkit:ready`. The element keeps serving every protocol a released loader
  sends; a loader in front of a newer element keeps speaking its own and logs
  the difference at `debug`. Requires an element at js.billkit.eu that
  announces a protocol, which ships first; in front of an older element the
  handshake completes exactly as before.
- `ElementErrorCode`, the union of `ELEMENT_ERROR_CODES`.
- A declared browser support matrix: the last two versions of Chrome, Edge
  and Firefox, Firefox ESR, and Safari 16.4+ (macOS and iOS), in
  `browserslist` and the README.
- `SECURITY.md` ships in the package, beside the README and licence.
- Three one-shot `ELEMENT_ERROR_CODES`. `client_secret_expired`: the
  one-shot's `client_secret` lapsed, so the element can no longer show the
  payment; its status is unknown there (it may be paid), so look it up with
  `GET /v1/checkout/one_shot/{id}` or wait for its webhook before creating
  another. `client_secret_invalid`: any other refusal of the secret, an
  integration fault. `payment_refunded`: the one-shot was paid and then
  refunded.
- Four checkout-element `ELEMENT_ERROR_CODES`. `session_expired` and
  `session_closed`: the checkout session is over (it expired, or was
  completed or overtaken elsewhere), where an element before this release
  sent only a localised message. `payment_in_progress`: the buyer came back
  to a checkout whose payment is still open at the provider; the element
  offers the way back to it, and a submit continues there (or, with no page
  to go back to, looks again and sends `payment_in_progress` again while the
  payment is still in flight). `request_timeout`: an API request got no
  answer in time; the element keeps its retry on offer.

### Changed
- **`billkit:redirect` is followed only to Mollie.** The loader navigates the
  top window only to an absolute `https` URL on `mollie.com` or a subdomain,
  the only place the element sends a buyer (3-D Secure, iDEAL, PayPal, bank
  transfer details); anything else is `onError({ code: "unsafe_redirect" })`
  before `onRedirect` is called. It accepted any `http(s)` URL, so the
  documented promise that a compromised element could not send the merchant's
  page to a phishing clone was not kept. `isSafeRedirectUrl` applies the same
  rule.
- `loadTimeoutMs: NaN` (or a non-number) counts as unset and gets the
  20 second default; it fired `load_timeout` at once. `Infinity`, or a delay
  past what `setTimeout` can hold, disables the watchdog instead of firing
  immediately.
- `ELEMENT_ERROR_CODES` includes the loader's own `load_timeout` and
  `unsafe_redirect`, which reached `onError` in 0.x without being listed.
- **`ChangeEvent.method` is `ChangeEvent.payment_method`**, the name the API
  uses for the same thing everywhere else. The loader also reads the old
  `method` from an element that predates the rename, so `onChange` carries
  `payment_method` whichever element answers.
- `BillKitElementError.code` is typed `ElementErrorCode | (string & {})`:
  the known codes autocomplete, and a newer one is still a string.
- `PaymentMethodElementOptions.customerId` is optional. The `client_secret`
  names the customer; the element never authorised on `customerId`.
- `engines.node` is `>=22`, for tooling only; nothing in the package runs
  on Node.
- `iframeOrigin` is reduced to `new URL(value).origin`, the exact string a
  browser reports as a message's origin. `https://Pay.Acme.com:443/` used to
  mount and then drop every message from the frame, because the comparison is
  exact. A value that is not an absolute https URL throws at mount; plain
  `http` is accepted only for a loopback host (`localhost`, `*.localhost`,
  `127.0.0.1`, `[::1]`), because the frame receives the `client_secret`.
- `payment_not_open` now means only "expired unpaid or failed, nothing was
  charged". An element at js.billkit.eu that predates this release reported
  an expired secret and a refunded one-shot as `payment_not_open` too, which
  told the merchant to charge again for a payment that may have gone through.

### Removed
- The `postMessage` internals from the package's exports: `ClientMessage`,
  `HostMessage`, `ElementKind`, `sessionIdFromClientSecret`,
  `isSafeRedirectUrl` and `DEFAULT_API_BASE`. The README used to advertise
  the first two helpers as building blocks; they are a protocol between the
  loader and the element, and exporting them made every protocol change a
  breaking release of this package.

### Fixed
- **CommonJS consumers get CommonJS types.** `exports` pointed every consumer
  at `dist/index.d.ts`, which TypeScript reads as ESM because the package is
  `"type": "module"`, so a CJS project on `module: node16` failed with TS1479
  on a plain import even though the runtime `require` worked. Each condition
  now names its own types: `import` gets `index.d.ts`, `require` gets
  `index.d.cts`. No runtime change.
- **The redirect to the bank works when your page is itself framed.** The
  loader navigated the top window with `location.assign()`, which a
  cross-origin `Location` refuses with a SecurityError, so a checkout page
  embedded by another origin fell back to navigating its own frame, where 3DS
  and iDEAL pages refuse to render. It now sets `location.href`, which a
  cross-origin top window allows. The https-on-Mollie guard is unchanged and
  still runs first.
- `package.json` is in the `exports` map, so tooling that reads
  `@billkit-eu/js/package.json` resolves it.

### Upgrading from 0.x

**Removed exports.** If you parsed a session id out of a `client_secret`,
read it from the server response instead, which carries it as `id`; the
secret's format is not a contract.

```ts
// 0.x
import { sessionIdFromClientSecret } from "@billkit-eu/js";
const sessionId = sessionIdFromClientSecret(clientSecret);
// 1.0: from your server, alongside the secret
const { id: sessionId, client_secret } = await client.checkoutSessions.create({ /* ... */ });
```

The wire types (`ClientMessage`, `HostMessage`, `ElementKind`) have no
replacement: post nothing to the element yourself. `isSafeRedirectUrl` was a
guard the loader already applies before every navigation.
`DEFAULT_API_BASE` was the default of the `apiBase` option, which still
exists.

**`onChange` names the method `payment_method`.**

```ts
// 0.x
onChange: ({ complete, method }) => track(method),
// 1.0
onChange: ({ complete, payment_method }) => track(payment_method),
```

**`customerId` is optional** on `mountPaymentMethodElement`; drop it.

```ts
// 0.x
mountPaymentMethodElement("#methods", { clientSecret, customerId: "cus_123" });
// 1.0
mountPaymentMethodElement("#methods", { clientSecret });
```

**Error codes.** Code that compared `ELEMENT_ERROR_CODES` against the codes
the element emits now finds the loader's two in the list as well. `code` is
typed as the union widened with `string`, so an exhaustive `switch` over it
needs a `default`, which it should always have had.

```ts
// 0.x: code was `string | undefined`
onError: ({ code }) => { if (code === "load_timeout") showFallback(); }
// 1.0: unchanged at runtime, and "load_timeout" now autocompletes
onError: ({ code }) => { if (code === "load_timeout") showFallback(); }
```

**Node 22+** for builds and tests.

## [0.4.0] - 2026-10-09

### Added
- `mountOneShotPaymentElement(target, options)`, the embedded form for a
  one-off payment created with `POST /v1/checkout/one_shot` and
  `ui_mode: "embedded"`. Same iframe, origin lock and `postMessage` model as
  the checkout element; a new element kind, `"one-shot"`, tells the iframe
  which form to draw. `onSuccess` receives `{ oneShotPaymentId, paymentStatus }`.
  **Requires the element deployed at js.billkit.eu to understand the
  `"one-shot"` kind.** An older element rejects the unknown kind and ignores
  the `init`, so the form stays on its loading skeleton and no callback fires;
  the element is deployed before this release for exactly that reason.
- `payment_not_open` in `ELEMENT_ERROR_CODES`: the one-shot element was
  mounted for a one-off payment that is no longer payable.

## [0.3.0]

### Fixed
- `onError({ code: "unsafe_redirect" })` is reachable. `parseHostMessage`
  checked the redirect's scheme and dropped the message, so the documented
  refusal never fired and the merchant saw nothing but a logger line, on the
  one event that is a security refusal rather than a version skew. The parser
  now validates the redirect's SHAPE only; the scheme guard is unchanged and
  still sits immediately before `location.assign`.
- The iframe is laid out as a `display: block` element. As an inline element it
  sat on the text baseline, leaving descender space under the form that no
  margin on the host container could remove.
- `submit()` called before the element has booted is queued and flushed with
  the `init` handshake instead of being posted into a frame with no listener
  and silently dropped. One pending call, not a queue: a second press before
  boot is the same intent, not a second payment.
- The `<iframe>` title is per element kind. A saved-methods wallet was
  announced as "BillKit secure checkout", describing a payment the customer was
  not making.

### Added
- `focus()` on `BillKitElementHandle`. Moves the keyboard into the element,
  onto the first control of whatever it is showing (the first field on the
  form, the retry button on the declined panel). A host page cannot reach into
  a cross-origin frame to do this itself. **Requires the element deployed at
  js.billkit.eu to understand `billkit:focus`**; against an older element the
  call is dropped there rather than failing.
- `title` element option, for the `<iframe>`'s accessible name. It lives on the
  merchant's page rather than inside the element, so `locale` cannot reach it.
- `colorScheme: "auto"` in `BillKitThemeTokens`. The element resolves it from
  the buyer's own `prefers-color-scheme` and keeps following it if they change
  it mid-checkout. An older element treats the value as unrecognised and keeps
  its light default.
- Three codes the element already emitted but `ELEMENT_ERROR_CODES` and the
  docs did not list: `no_payment_methods`, `missing_session_id` and
  `missing_client_secret`. No behaviour change; they were reaching merchants as
  codes documented nowhere.
- A warning when a second element is mounted into a target that already holds
  one. Warned rather than thrown: the second element works; it just stacks
  under the first with two `message` listeners racing for the same traffic, and
  throwing would take down a page that was about to take a payment.

### Changed
- Documented the `onRedirect` resume pattern. Returning `false` means you are
  navigating, not that the payment is cancelled: the `url` argument is what you
  resume with, and returning `false` without ever navigating leaves the buyer
  on a form for a charge that already exists at the provider.

No breaking change: every addition is a new option, a new handle method or a
new value in an existing union.

## [0.2.2]

### Added
- `element_crashed` in `ELEMENT_ERROR_CODES`. The element now reports an
  unrecoverable render error to the host instead of failing silently: it
  replaces itself with an error pane and posts
  `onError({ code: "element_crashed" })`. Nothing was charged, and a reload is
  the only recovery, so **re-enable your pay button and stop waiting**: the
  same handling `payment_declined` already needs.

  Previously a crashed element was a blank iframe and `onError` never fired,
  which left the merchant's own pay button spinning forever. That is the
  failure this closes.

  `ELEMENT_ERROR_CODES` is not exhaustive at runtime: `code` is passed through
  verbatim, so branch on the ones you handle and fall back to `message`.

No API change: this is a new value in an existing union, reported through the
`onError` callback you already have.

## [0.2.1]

### Changed
- Documentation only. API keys are now `bk_live_…` / `bk_test_…` and webhook
  signing secrets `bkwhsec_…`; every example here used the previous
  Stripe-shaped `sk_`/`whsec_` spelling. No code in this package changed: it
  never parsed the prefix, it forwards the key as a bearer token.

## [0.2.0]

## [0.1.0]

First public release.

### Added
- `mountCheckoutElement(options)`: the embedded checkout element. Mounts a
  cross-origin iframe served from js.billkit.eu, so card data is entered on
  BillKit's origin and never reaches the tenant's page or its scripts. That is
  what keeps an integration in PCI SAQ A scope.
- `mountPaymentMethodElement(options)`: the same element shape for collecting a
  payment method without taking a payment, for saved-method and update flows.
- `BillKitElementHandle` returned by both: `destroy()`, `update()` and the
  element lifecycle, so an element can be torn down without leaking listeners
  or leaving an orphaned iframe.
- `SuccessEvent` / `ChangeEvent` / `BillKitElementError` callbacks covering the
  full outcome surface, including redirect-based methods (iDEAL, Bancontact and
  the rest), which return through the same success path as card.
- Theming through `BillKitThemeTokens`: a fixed token set the iframe applies to
  itself. Tokens cross the origin boundary, arbitrary CSS does not, so the
  element can look like the surrounding page without the page being able to
  restyle a payment field into something it is not.
- Opt-in logging via `BillKitElementLogger` (`debug`/`warn`). Omitted, the SDK
  ships `NOOP_ELEMENT_LOGGER` and writes nowhere. Client secrets, card data and
  query strings are never passed to the logger.
- `isSafeRedirectUrl()` and `sessionIdFromClientSecret()` exported, so the host
  page can validate a redirect target and derive a session id without parsing
  the client secret by hand.
- `DEFAULT_API_BASE` / `DEFAULT_IFRAME_ORIGIN` exported for self-hosted
  deployments that serve the element from their own origin.
- Full TypeScript types, ESM + CJS dual package via `tsup`, no runtime
  dependencies.

### Security
- Every `postMessage` is checked against the expected iframe origin in both
  directions, and messages that fail the check are dropped rather than
  best-effort parsed.

[1.0.0]: https://github.com/billkit-eu/billkit-js/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/billkit-eu/billkit-js/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/billkit-eu/billkit-js/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/billkit-eu/billkit-js/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/billkit-eu/billkit-js/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/billkit-eu/billkit-js/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/billkit-eu/billkit-js/releases/tag/v0.1.0
