import { type BaseElementOptions, type BillKitElementHandle, ElementController } from "./iframe";

export interface PaymentMethodElementOptions extends BaseElementOptions {
  /**
   * Optional, and ignored for authorisation. The `client_secret` already
   * names the customer, and the element shows that customer's methods
   * whatever is passed here. Kept so a 0.x mount still compiles.
   */
  customerId?: string;
}

/**
 * Mount the saved-payment-methods element into `target`: the customer's
 * "Visa •••• 4242 · Expires 06/26 · Update" rows, rendered inside the
 * same cross-origin js.billkit.eu iframe as the checkout element.
 *
 * ```ts
 * import { mountPaymentMethodElement } from "@billkit-eu/js";
 *
 * const element = mountPaymentMethodElement("#methods", {
 *   clientSecret,          // scoped ephemeral secret; it names the customer
 *   theme: { colorPrimary: "#6d28d9" },
 * });
 * ```
 */
export function mountPaymentMethodElement(
  target: HTMLElement | string,
  options: PaymentMethodElementOptions,
): BillKitElementHandle {
  const { customerId, ...base } = options;
  return new ElementController(target, "payment-method", base, { customerId });
}
