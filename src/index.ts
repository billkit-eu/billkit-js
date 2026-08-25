/**
 * `@billkit-eu/js`: the browser SDK for BillKit's embedded checkout.
 *
 * The Stripe-Elements-shaped payment UI for BillKit on Mollie: a
 * `<CheckoutElement/>` that mounts a cross-origin iframe served from
 * js.billkit.eu, so card data never touches the tenant's page (PCI SAQ A)
 * while the element still honours the tenant's theme tokens.
 *
 * @packageDocumentation
 */

export { mountCheckoutElement, type CheckoutElementOptions } from "./checkout-element";
export {
  mountPaymentMethodElement,
  type PaymentMethodElementOptions,
} from "./payment-method-element";
export type {
  BaseElementOptions,
  BillKitElementError,
  BillKitElementHandle,
  ChangeEvent,
  SuccessEvent,
} from "./iframe";
export {
  NOOP_ELEMENT_LOGGER,
  type BillKitElementLogger,
  type ElementLogContext,
} from "./logging";
export type { BillKitThemeTokens } from "./theme";
export {
  DEFAULT_API_BASE,
  DEFAULT_IFRAME_ORIGIN,
  isSafeRedirectUrl,
  sessionIdFromClientSecret,
  type ClientMessage,
  type ElementKind,
  type HostMessage,
} from "./protocol";
export { VERSION } from "./version";
