# BillKit Browser SDK

Embedded checkout for [BillKit](https://billkit.eu), the Stripe-Billing-shape multi-tenant SaaS API on Mollie.

`@billkit-eu/js` mounts a payment UI into your page. The card fields live inside a cross-origin iframe served from `js.billkit.eu`, so card data never touches your origin and you stay on PCI SAQ A. Your theme tokens still apply, so the element looks like the rest of your checkout.

This is **not** an API client. No secret key ever reaches the browser. For server-side calls, use [`@billkit-eu/sdk`](https://www.npmjs.com/package/@billkit-eu/sdk).

Using React? [`@billkit-eu/react`](https://www.npmjs.com/package/@billkit-eu/react) wraps this package in `<BillKitProvider>` and `<CheckoutElement/>`.

## Install

```bash
npm install @billkit-eu/js
# or pnpm add @billkit-eu/js / yarn add @billkit-eu/js / bun add @billkit-eu/js
```

Ships ESM and CJS builds with bundled type declarations. No runtime dependencies.

## How it fits together

The element authenticates with an ephemeral `client_secret`, not an API key. Mint one on your server:

```ts
// Your server, using @billkit-eu/sdk
const session = await client.checkoutSessions.create<{ client_secret: string }>({
  price_id: "price_123",
  ui_mode: "embedded",
  success_url: "https://example.com/thanks",
  cancel_url: "https://example.com/pricing", // required, even when embedded
});
// hand session.client_secret to the browser
```

Then mount the element with it:

```ts
import { mountCheckoutElement } from "@billkit-eu/js";

const element = mountCheckoutElement("#checkout", {
  clientSecret,
  theme: { colorPrimary: "#6d28d9", borderRadius: "10px" },
  onSuccess: ({ sessionId }) => {
    location.href = `/thanks?cs=${sessionId}`;
  },
  onError: ({ message }) => showToast(message),
});
```

`mountCheckoutElement` takes an `HTMLElement` or a CSS selector, and returns a handle:

```ts
element.submit();                                  // submit from your own pay button
element.focus();                                   // move the keyboard into the element
element.updateTheme({ colorPrimary: "#0f766e" });  // restyle in place
element.destroy();                                 // remove the iframe, detach listeners
```

`submit()` is safe to call before the element has booted: one pending submit
is queued and flushed as soon as the handshake completes, so a pay button
that is clickable the moment your page renders no longer drops the click in
silence. (The element still decides whether it can act on it; a submit that
arrives before its session view has loaded is ignored there, and the buyer
presses again.)

`focus()` moves the keyboard into the element, onto the first control of
whatever it is showing, the first field on the form, the retry button on the
declined panel. Your page cannot reach inside a cross-origin frame to do that
itself, which is why it has to ask. Use it when the element is revealed by a
step or a drawer. A call made before the element has booted is dropped rather
than queued: by the time it boots the buyer has moved on, and yanking the
caret out of whatever they had started typing would be worse than doing
nothing.

Always call `destroy()` when you tear down the surrounding view. A live element holds a `message` listener on `window`.

## Saved payment methods

The same iframe renders a customer's stored methods, with update and remove built in:

```ts
import { mountPaymentMethodElement } from "@billkit-eu/js";

const wallet = mountPaymentMethodElement("#methods", {
  clientSecret,
  customerId: "cus_123",
  theme: { colorPrimary: "#6d28d9" },
});
```

## One-off payments

For a single charge with no subscription and no saved mandate (a top-up, a
setup fee, one order), create the one-shot on your server with
`ui_mode: "embedded"` and mount the one-shot element with its secret:

```ts
// server, with your secret key
const payment = await billkit.oneShotPayments.create({
  customer_id: customer.id,
  amount_cents: 2500,
  currency: "EUR",
  ui_mode: "embedded",          // no method: the buyer picks it in the element
  success_url: "https://app.example.com/thanks",
});
// hand payment.client_secret to the page
```

```ts
import { mountOneShotPaymentElement } from "@billkit-eu/js";

const element = mountOneShotPaymentElement("#pay", {
  clientSecret,
  onSuccess: ({ oneShotPaymentId }) => (location.href = `/thanks?p=${oneShotPaymentId}`),
  onError: ({ code, message }) => showToast(message),
});
```

The element shows the amount (with the VAT line the payment was created
with), lets the buyer pick a method your account has enabled for the currency
(card through Mollie Components, iDEAL with a bank picker, Bancontact, EPS,
PayPal, Apple Pay, bank transfer) and confirms it. Card payments that clear
without a challenge fire `onSuccess`; everything else navigates the top window
and the buyer comes back to your `success_url`. Either way, the
`one_shot_payment.succeeded` webhook is the record of the money.

Two differences from the checkout element:

- `onSuccess` receives `{ oneShotPaymentId, paymentStatus }`.
- A decline is final. A one-off payment makes at most one provider payment, so
  `onError({ code: "payment_declined" })` shows a panel with no retry. Create a
  new one-shot and mount a new element to let the buyer try again. Pressing pay
  twice never charges twice: the server answers every later confirm with the
  first one's result.

The secret expires (30 minutes by default; `expires_at` on the one-shot says
when). A one-shot whose secret lapsed unpaid is expired by BillKit and
announced with `one_shot_payment.failed`.

## Options

All three elements take the same base options.

| Option | Type | Notes |
|---|---|---|
| `clientSecret` | `string` | Required. The `<id>_secret_...` value from `POST /v1/checkout/sessions` (checkout and payment-method elements) or `POST /v1/checkout/one_shot` (one-shot element), each with `ui_mode: "embedded"`. |
| `theme` | `BillKitThemeTokens` | Colour, radius, font and spacing tokens. Forwarded over `postMessage`, never through the URL. |
| `locale` | `string` | BCP-47, for example `"nl"`. Defaults to the customer's browser. Sets the element's `<html lang>` and its document title too. |
| `title` | `string` | Accessible name for the `<iframe>`. Defaults to "BillKit secure checkout" / "BillKit saved payment methods" / "BillKit secure payment" per element kind. Those defaults are English, and this string lives on **your** page rather than inside the element, so `locale` cannot reach it. Set it when your page is not in English. |
| `loadTimeoutMs` | `number` | How long to wait for the iframe to boot before firing `onError({ code: "load_timeout" })`. Default `20000`; `0` disables it. |
| `iframeOrigin` | `string` | Defaults to `https://js.billkit.eu`. The seam for a BillKit-operated vanity domain. |
| `apiBase` | `string` | API origin the iframe calls. Defaults to `https://api.billkit.eu`. |
| `logger` | `BillKitElementLogger` | Opt-in diagnostics. Off by default. |
| `onReady` | `() => void` | The iframe booted and loaded the session. |
| `onChange` | `(e: ChangeEvent) => void` | Fires as the customer edits. `e.complete` drives an external pay button. |
| `onSuccess` | `(e: SuccessEvent) => void` | Terminal success with no redirect. |
| `onError` | `(e: BillKitElementError) => void` | Any element or payment error. See [Error codes](#error-codes). |
| `onRedirect` | `(url: string) => boolean \| void` | Called before the top window navigates for 3DS or iDEAL. Return `false` to navigate yourself. |

`mountPaymentMethodElement` additionally requires `customerId`.

### Error codes

`onError` receives `{ message, code? }`. `message` is human-readable and already localised; `code` is the stable tag to branch on.

| `code` | Raised by | What to do |
|---|---|---|
| `payment_declined` | The element, after a confirm that failed with no redirect. | Re-enable your pay button. The checkout element keeps its own retry panel on screen, so the buyer can pick another method without leaving the page. Do **not** navigate away. On the one-shot element the decline is final: create a new one-shot to retry. |
| `element_crashed` | The element, after an unrecoverable render error. It replaces itself with an error pane. | Nothing was charged. Re-enable your pay button and stop waiting; only a reload recovers the element, so offer the hosted checkout as a fallback. |
| `no_payment_methods` | The element, when nothing the tenant enabled is payable for the session's currency and the buyer's country. | Nothing was charged and a retry changes nothing: there is no form to fill in. Send the buyer somewhere that can take the payment, and check the price's method allowlist. |
| `missing_session_id` | The element, when the `client_secret` carried no parseable session id. | An integration fault. Pass the whole `<sessionId>_secret_…` value from `POST /v1/checkout/sessions`, unmodified. |
| `missing_client_secret` | The element, when the payment-method element was mounted without a secret. | Same class as above: nothing to retry, fix the mount. |
| `payment_not_open` | The one-shot element, mounted for a one-off payment that is no longer payable (expired, failed or already paid). | Nothing new was charged. Create a fresh one-shot if the buyer still needs to pay. |
| `load_timeout` | The loader, when the iframe never booted within `loadTimeoutMs`. | Check CSP `frame-src` and ad blockers; offer the hosted checkout as a fallback. |
| `unsafe_redirect` | The loader, refusing a redirect target that was not absolute `http(s)`. | Should never happen in production. Treat it as a security event. |

Unknown codes are always possible — a newer element can mint one — so branch on what you handle and fall through to `message` for the rest.

If you drive an external pay button, `payment_declined` is what re-enables it. Without handling it the button stays in its submitting state forever, because a decline fires neither `onSuccess` nor a redirect:

```ts
const element = mountCheckoutElement("#checkout", {
  clientSecret,
  onChange: ({ complete }) => (payButton.disabled = !complete),
  onError: ({ code, message }) => {
    payButton.disabled = false; // the attempt is over, whatever the cause
    if (code !== "payment_declined") showToast(message);
  },
});
payButton.onclick = () => element.submit();
```

### Redirect-based methods

Cards that clear without a challenge fire `onSuccess`. 3DS and iDEAL instead navigate the top window to the bank. If you need to persist state first, intercept it:

```ts
onRedirect: (url) => {
  sessionStorage.setItem("cart", JSON.stringify(cart));
  window.location.assign(url);
  return false; // you took over; the loader will not navigate
};
```

Returning `false` is not "cancel the payment": it means *you* will navigate.
The URL is handed to you for exactly that, so the resume is
`location.assign(url)` after your own work, including in an `await`, since
the loader has already stepped aside. Return `false` without ever navigating
and the buyer sits on a form whose payment has already been created at the
provider.

Terminal state for a redirect flow arrives on your server through the `checkout.session.completed` webhook, not in the browser. Treat the redirect back to `success_url` as a UI hint and the webhook as the source of truth.

## Content Security Policy

The element renders in an iframe, so your CSP has to allow it:

```
frame-src https://js.billkit.eu;
```

If the iframe never boots, `onError` fires with `load_timeout` after `loadTimeoutMs`. A missing `frame-src` and an ad blocker look identical from the page, so check both.

## Logging

The loader is silent by default. It never calls `console` on its own, because a payment element that writes into the merchant's devtools has taken over output that isn't its to take. Pass a logger to opt in:

```ts
mountCheckoutElement("#checkout", { clientSecret, logger: console });
```

`console` satisfies the interface as-is, and so does a pino or winston child logger. You get one `debug` line per lifecycle step and a `warn` whenever a message is dropped or a redirect is refused.

Never logged: the `clientSecret`, message payloads, or full redirect URLs. Redirect URLs carry provider payment identifiers, so only the origin is recorded.

## Security model

The fixed iframe origin is the whole design:

- **Card fields are cross-origin.** The page hosting the element cannot read what the customer types, which is what keeps you on PCI SAQ A.
- **The `client_secret` is never in the iframe URL**, in either the query or the fragment. It is delivered over a targeted `postMessage` only after the iframe announces `ready`, which keeps it out of `Referer` headers, browser history and server logs.
- **Every inbound message is checked** against the exact iframe origin *and* the specific frame that sent it, before the payload is parsed. Messages from another origin, or from a sibling element, are dropped.
- **Outbound messages always name a target origin.** Never `"*"`.
- **The iframe is sandboxed** and is not granted `allow-top-navigation`. Redirects are requested by message and performed by the loader only after the URL is validated as absolute `http(s)`, so a compromised element cannot navigate your page to a phishing clone.

## TypeScript

Types ship with the package. The exported helpers are useful if you are building your own integration on top:

```ts
import {
  sessionIdFromClientSecret,
  isSafeRedirectUrl,
  DEFAULT_IFRAME_ORIGIN,
  type BillKitThemeTokens,
  type SuccessEvent,
} from "@billkit-eu/js";
```

## Links

- Documentation: [docs.billkit.eu](https://docs.billkit.eu)
- Source: [github.com/billkit-eu/billkit-js](https://github.com/billkit-eu/billkit-js)
- Issues: [github.com/billkit-eu/billkit-js/issues](https://github.com/billkit-eu/billkit-js/issues)

## License

Apache-2.0
