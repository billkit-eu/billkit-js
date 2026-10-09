import { type BaseElementOptions, type BillKitElementHandle, ElementController } from "./iframe";

/** What `onSuccess` receives from the one-shot element. */
export interface OneShotSuccessEvent {
  /** The one-off payment (`osp_…`) the element was mounted for. */
  oneShotPaymentId: string;
  /**
   * The payment's status when the element finished: usually `paid`, but
   * `authorized` or `pending` are possible. Treat the
   * `one_shot_payment.succeeded` webhook as the record of the money.
   */
  paymentStatus: string;
}

export interface OneShotPaymentElementOptions extends Omit<BaseElementOptions, "onSuccess"> {
  /**
   * Ephemeral `client_secret` (`osp_…_secret_…`) from
   * `POST /v1/checkout/one_shot` with `ui_mode: "embedded"`.
   */
  clientSecret: string;
  /**
   * Fired when the payment completes without leaving the page (in practice
   * a card that clears without a 3-D Secure challenge). Redirect methods
   * (3DS, iDEAL, Bancontact, bank transfer, PayPal) navigate the top window
   * instead and the buyer comes back to your `success_url`.
   */
  onSuccess?: (event: OneShotSuccessEvent) => void;
}

/**
 * Mount the one-off payment element into `target`.
 *
 * ```ts
 * import { mountOneShotPaymentElement } from "@billkit-eu/js";
 *
 * const element = mountOneShotPaymentElement("#pay", {
 *   clientSecret,   // from POST /v1/checkout/one_shot {ui_mode:"embedded"}
 *   onSuccess: ({ oneShotPaymentId }) => (location.href = `/thanks?p=${oneShotPaymentId}`),
 *   onError: ({ code, message }) => showToast(message),
 * });
 * ```
 *
 * Same iframe, origin lock and postMessage model as the checkout element:
 * card fields render cross-origin on js.billkit.eu (PCI SAQ A), and the
 * secret travels over a targeted `postMessage`, never in the URL. The form
 * is a single charge with no subscription and no saved mandate. A decline
 * is final for that one-shot (`onError({ code: "payment_declined" })`):
 * create a new one-shot to let the buyer try again.
 */
export function mountOneShotPaymentElement(
  target: HTMLElement | string,
  options: OneShotPaymentElementOptions,
): BillKitElementHandle {
  const { onSuccess, ...rest } = options;
  return new ElementController(target, "one-shot", {
    ...rest,
    // The wire message carries the mounted object's id as `sessionId`
    // (see `HostMessage` in protocol.ts); rename it here so a merchant
    // never has to know that.
    ...(onSuccess
      ? {
          onSuccess: (event) =>
            onSuccess({ oneShotPaymentId: event.sessionId, paymentStatus: event.paymentStatus }),
        }
      : {}),
  });
}
