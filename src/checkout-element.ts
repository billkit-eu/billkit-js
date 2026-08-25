import { type BaseElementOptions, type BillKitElementHandle, ElementController } from "./iframe";

export type CheckoutElementOptions = BaseElementOptions;

/**
 * Mount the embedded checkout element into `target`.
 *
 * ```ts
 * import { mountCheckoutElement } from "@billkit-eu/js";
 *
 * const element = mountCheckoutElement("#checkout", {
 *   clientSecret,          // from POST /v1/checkout/sessions {ui_mode:"embedded"}
 *   theme: { colorPrimary: "#6d28d9", borderRadius: "10px" },
 *   onSuccess: ({ sessionId }) => (location.href = `/thanks?cs=${sessionId}`),
 *   onError: ({ message }) => showToast(message),
 * });
 * ```
 *
 * The card fields render inside a cross-origin iframe served from
 * js.billkit.eu, so card data never touches your page, so you stay on PCI
 * SAQ A. Redirect-based methods (3DS / iDEAL) navigate the top window; a
 * card that clears without a challenge fires `onSuccess`.
 */
export function mountCheckoutElement(
  target: HTMLElement | string,
  options: CheckoutElementOptions,
): BillKitElementHandle {
  return new ElementController(target, "checkout", options);
}
