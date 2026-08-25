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
element.updateTheme({ colorPrimary: "#0f766e" });  // restyle in place
element.destroy();                                 // remove the iframe, detach listeners
```

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

## Options

Both elements take the same base options.

| Option | Type | Notes |
|---|---|---|
| `clientSecret` | `string` | Required. The `<sessionId>_secret_...` value from `POST /v1/checkout/sessions` with `ui_mode: "embedded"`. |
| `theme` | `BillKitThemeTokens` | Colour, radius, font and spacing tokens. Forwarded over `postMessage`, never through the URL. |
| `locale` | `string` | BCP-47, for example `"nl"`. Defaults to the customer's browser. |
| `loadTimeoutMs` | `number` | How long to wait for the iframe to boot before firing `onError({ code: "load_timeout" })`. Default `20000`; `0` disables it. |
| `iframeOrigin` | `string` | Defaults to `https://js.billkit.eu`. The seam for a BillKit-operated vanity domain. |
| `apiBase` | `string` | API origin the iframe calls. Defaults to `https://api.billkit.eu`. |
| `logger` | `BillKitElementLogger` | Opt-in diagnostics. Off by default. |
| `onReady` | `() => void` | The iframe booted and loaded the session. |
| `onChange` | `(e: ChangeEvent) => void` | Fires as the customer edits. `e.complete` drives an external pay button. |
| `onSuccess` | `(e: SuccessEvent) => void` | Terminal success with no redirect. |
| `onError` | `(e: BillKitElementError) => void` | Any element or payment error. |
| `onRedirect` | `(url: string) => boolean \| void` | Called before the top window navigates for 3DS or iDEAL. Return `false` to navigate yourself. |

`mountPaymentMethodElement` additionally requires `customerId`.

### Redirect-based methods

Cards that clear without a challenge fire `onSuccess`. 3DS and iDEAL instead navigate the top window to the bank. If you need to persist state first, intercept it:

```ts
onRedirect: (url) => {
  sessionStorage.setItem("cart", JSON.stringify(cart));
  window.location.assign(url);
  return false; // you took over; the loader will not navigate
};
```

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
