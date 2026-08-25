import { type BaseElementOptions, type BillKitElementHandle, ElementController } from "./iframe";

export interface PaymentMethodElementOptions extends BaseElementOptions {
  /** The customer whose saved payment methods to render + manage. */
  customerId: string;
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
 *   clientSecret,          // scoped ephemeral secret
 *   customerId: "cus_123",
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
