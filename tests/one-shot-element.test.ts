import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountOneShotPaymentElement } from "../src/one-shot-element";
import { DEFAULT_IFRAME_ORIGIN, type HostMessage } from "../src/protocol";

const OSP = "osp_test_abc123_secret_r4nd0m";
const OSP_ID = "osp_test_abc123";

function getIframe(host: HTMLElement): HTMLIFrameElement {
  const iframe = host.querySelector("iframe");
  if (!iframe) throw new Error("no iframe mounted");
  return iframe;
}

function fromIframe(iframe: HTMLIFrameElement, data: HostMessage): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: DEFAULT_IFRAME_ORIGIN,
      source: iframe.contentWindow,
    }),
  );
}

describe("mountOneShotPaymentElement", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    host.id = "pay";
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("mounts the element page with its own title and no secret in the URL", () => {
    mountOneShotPaymentElement("#pay", { clientSecret: OSP });
    const iframe = getIframe(host);
    expect(iframe.src).toBe("https://js.billkit.eu/embed");
    expect(iframe.title).toBe("BillKit secure payment");
    expect(iframe.getAttribute("data-billkit-element")).toBe("one-shot");
    expect(iframe.src).not.toContain(OSP);
    expect(iframe.getAttribute("sandbox") ?? "").not.toContain("allow-top-navigation");
  });

  it("tells the iframe it is a one-shot and forwards the parsed id", () => {
    mountOneShotPaymentElement("#pay", { clientSecret: OSP, locale: "nl" });
    const iframe = getIframe(host);
    const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    fromIframe(iframe, { type: "billkit:ready" });

    const [message, targetOrigin] = post.mock.calls[0]!;
    expect(targetOrigin).toBe(DEFAULT_IFRAME_ORIGIN);
    expect(message).toMatchObject({
      type: "billkit:init",
      element: "one-shot",
      clientSecret: OSP,
      sessionId: OSP_ID,
      locale: "nl",
    });
  });

  it("hands onSuccess the one-shot id under its own name", () => {
    const onSuccess = vi.fn();
    mountOneShotPaymentElement("#pay", { clientSecret: OSP, onSuccess });
    fromIframe(getIframe(host), {
      type: "billkit:success",
      sessionId: OSP_ID,
      paymentStatus: "paid",
    });
    expect(onSuccess).toHaveBeenCalledWith({ oneShotPaymentId: OSP_ID, paymentStatus: "paid" });
  });

  it("routes a terminal decline and a redirect like the checkout element", () => {
    const onError = vi.fn();
    const onRedirect = vi.fn().mockReturnValue(false);
    mountOneShotPaymentElement("#pay", { clientSecret: OSP, onError, onRedirect });
    const iframe = getIframe(host);

    fromIframe(iframe, { type: "billkit:redirect", url: "https://www.mollie.com/checkout/x" });
    fromIframe(iframe, {
      type: "billkit:error",
      message: "Payment not completed",
      code: "payment_declined",
    });

    expect(onRedirect).toHaveBeenCalledWith("https://www.mollie.com/checkout/x");
    expect(onError).toHaveBeenCalledWith({
      message: "Payment not completed",
      code: "payment_declined",
    });
  });

  it("accepts a title override", () => {
    mountOneShotPaymentElement("#pay", { clientSecret: OSP, title: "Sichere Zahlung" });
    expect(getIframe(host).title).toBe("Sichere Zahlung");
  });
});
