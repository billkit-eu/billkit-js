/**
 * `@billkit-eu/js`: the browser SDK for BillKit's embedded checkout.
 *
 * The Stripe-Elements-shaped payment UI for BillKit on Mollie: a
 * `<CheckoutElement/>` (and a one-off `<OneShotPaymentElement/>`) that mounts a cross-origin iframe served from
 * js.billkit.eu, so card data never touches the tenant's page (PCI SAQ A)
 * while the element still honours the tenant's theme tokens.
 *
 * @packageDocumentation
 */

export { mountCheckoutElement, type CheckoutElementOptions } from "./checkout-element";
export {
  mountOneShotPaymentElement,
  type OneShotPaymentElementOptions,
  type OneShotSuccessEvent,
} from "./one-shot-element";
export {
  mountPaymentMethodElement,
  type PaymentMethodElementOptions,
} from "./payment-method-element";
export type {
  BaseElementOptions,
  BillKitElementError,
  BillKitElementHandle,
  ChangeEvent,
  ProcessingEvent,
  SuccessEvent,
} from "./iframe";
export {
  NOOP_ELEMENT_LOGGER,
  type BillKitElementLogger,
  type ElementLogContext,
} from "./logging";
export type { BillKitThemeTokens } from "./theme";
// The postMessage wire types (`ClientMessage`, `HostMessage`), the secret
// parser and the redirect guard are internal: the protocol is versioned
// between this loader and the iframe, and is not a merchant-facing API.
export {
  DEFAULT_IFRAME_ORIGIN,
  ELEMENT_ERROR_CODES,
  type ElementErrorCode,
} from "./protocol";
export { VERSION } from "./version";
