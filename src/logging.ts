/**
 * Opt-in logging for the BillKit browser SDK.
 *
 * The loader is silent by default. It never reaches for `console` on its
 * own. A payment element that scribbles in the merchant's devtools
 * console, or into whatever front-end error reporter is wired to it, has
 * taken over output that isn't its to take. Pass a logger to opt in:
 *
 * ```ts
 * mountCheckoutElement("#checkout", { clientSecret, logger: console });
 * ```
 *
 * `console` satisfies {@link BillKitElementLogger} structurally, so that
 * works with no adapter.
 *
 * ## Why this exists
 *
 * Everything the *merchant's code* needs already arrives through the
 * `onReady` / `onChange` / `onSuccess` / `onError` callbacks. That is
 * the integration surface and it is not changing. The logger is for the
 * failures those callbacks structurally cannot describe:
 *
 * - The iframe never boots because a CSP `frame-src` or an ad blocker
 *   silently dropped it. `onError({ code: "load_timeout" })` fires 20s
 *   later and says nothing about *why*.
 * - A `postMessage` arrives and is dropped: wrong origin, wrong source
 *   window, or a payload that failed validation. Dropping it is correct
 *   (that check is a security boundary), but a dropped message is
 *   invisible, and "the element just doesn't respond" is the hardest
 *   class of integration bug to diagnose from the outside.
 * - A redirect target was refused as unsafe.
 *
 * ## Never logged
 *
 * The `clientSecret`, in any form. It authenticates the checkout session;
 * the whole reason it travels by `postMessage` rather than in the iframe
 * URL is to keep it out of `Referer` headers, browser history and server
 * logs. Writing it to a console or a front-end error reporter would give
 * that back. Message *payloads* are not logged either, only message types.
 */

/** Structured context attached to a log line. Never contains secrets. */
export type ElementLogContext = Record<string, unknown>;

/**
 * The minimum a logger must do for the loader to use it. Deliberately
 * two methods: it's the same shape `@billkit-eu/sdk` uses server-side, and
 * one almost every logger already satisfies without an adapter.
 */
export interface BillKitElementLogger {
  debug(message: string, context?: ElementLogContext): void;
  warn(message: string, context?: ElementLogContext): void;
}

/** The default. Discards everything, so the loader stays silent. */
export const NOOP_ELEMENT_LOGGER: BillKitElementLogger = {
  debug(): void {
    /* intentionally empty */
  },
  warn(): void {
    /* intentionally empty */
  },
};
