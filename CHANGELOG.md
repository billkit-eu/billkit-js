# Changelog

All notable changes to the BillKit browser SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioned independently of the server SDKs. `@billkit-eu/react` tracks this
package through a peer dependency, so a breaking change here is a breaking
change there.

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
  the only recovery, so **re-enable your pay button and stop waiting** — the
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

[Unreleased]: https://github.com/billkit-eu/billkit-js/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/billkit-eu/billkit-js/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/billkit-eu/billkit-js/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/billkit-eu/billkit-js/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/billkit-eu/billkit-js/releases/tag/v0.1.0
