# Changelog

All notable changes to the BillKit browser SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioned independently of the server SDKs. `@billkit-eu/react` tracks this
package through a peer dependency, so a breaking change here is a breaking
change there.

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

[Unreleased]: https://github.com/billkit-eu/billkit-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/billkit-eu/billkit-js/releases/tag/v0.1.0
