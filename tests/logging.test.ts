import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCheckoutElement } from "../src/checkout-element";
import { NOOP_ELEMENT_LOGGER, type BillKitElementLogger } from "../src/logging";
import { DEFAULT_IFRAME_ORIGIN, type HostMessage } from "../src/protocol";

/**
 * The loader's logging must be opt-in and leak-free.
 *
 * Two properties are load-bearing:
 *
 * 1. **Silent by default.** A payment element that writes to the
 *    merchant's devtools console (or into whatever front-end error
 *    reporter is wired to it) has taken over output that isn't its own.
 * 2. **Never the `clientSecret`.** It authenticates the session. The
 *    whole reason it travels by `postMessage` instead of in the iframe
 *    URL is to stay out of `Referer`, history and logs; writing it to a
 *    logger would hand that back.
 */

const CS = "cs_test_abc123_secret_r4nd0m";

interface Recorded {
  level: "debug" | "warn";
  message: string;
  context: Record<string, unknown> | undefined;
}

function recordingLogger(): { logger: BillKitElementLogger; lines: Recorded[] } {
  const lines: Recorded[] = [];
  return {
    lines,
    logger: {
      debug: (message, context) => void lines.push({ level: "debug", message, context }),
      warn: (message, context) => void lines.push({ level: "warn", message, context }),
    },
  };
}

function blob(lines: Recorded[]): string {
  return lines.map((l) => `${l.message} ${JSON.stringify(l.context ?? {})}`).join("\n");
}

function getIframe(host: HTMLElement): HTMLIFrameElement {
  const iframe = host.querySelector("iframe");
  if (!iframe) throw new Error("no iframe mounted");
  return iframe;
}

function fromIframe(
  iframe: HTMLIFrameElement,
  data: unknown,
  origin = DEFAULT_IFRAME_ORIGIN,
): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, source: iframe.contentWindow }),
  );
}

describe("element logging", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    host.id = "checkout";
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("never touches console when no logger is passed", () => {
    const spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };

    const el = mountCheckoutElement("#checkout", { clientSecret: CS, loadTimeoutMs: 0 });
    const iframe = getIframe(host);
    fromIframe(iframe, { type: "billkit:ready" } satisfies HostMessage);
    fromIframe(iframe, { type: "billkit:garbage" });
    fromIframe(iframe, { type: "billkit:redirect", url: "javascript:alert(1)" });
    el.destroy();

    for (const [name, spy] of Object.entries(spies)) {
      expect(spy, `loader wrote to console.${name} unasked`).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("NOOP_ELEMENT_LOGGER swallows everything", () => {
    expect(() => {
      NOOP_ELEMENT_LOGGER.debug("x", { a: 1 });
      NOOP_ELEMENT_LOGGER.warn("y");
    }).not.toThrow();
  });

  it("console satisfies BillKitElementLogger with no adapter", () => {
    // If this stops type-checking, the README's `logger: console` is a lie.
    const logger: BillKitElementLogger = console;
    expect(typeof logger.debug).toBe("function");
  });

  it("logs the mount and the ready→init handshake at debug", () => {
    const { logger, lines } = recordingLogger();
    mountCheckoutElement("#checkout", { clientSecret: CS, logger, loadTimeoutMs: 0 });

    expect(lines.find((l) => l.message === "BillKit element mounting")?.context).toMatchObject({
      element: "checkout",
      origin: DEFAULT_IFRAME_ORIGIN,
    });

    fromIframe(getIframe(host), { type: "billkit:ready" } satisfies HostMessage);
    expect(lines.some((l) => l.message === "BillKit element ready; sending init")).toBe(true);
  });

  it("warns when a message from our own frame fails validation", () => {
    const { logger, lines } = recordingLogger();
    mountCheckoutElement("#checkout", { clientSecret: CS, logger, loadTimeoutMs: 0 });

    // Right origin, right frame, malformed payload: a resize with no height.
    fromIframe(getIframe(host), { type: "billkit:resize" });

    const dropped = lines.find((l) => l.message === "BillKit dropped a malformed message");
    expect(dropped?.level).toBe("warn");
    expect(dropped?.context).toMatchObject({ type: "billkit:resize" });
  });

  it("stays quiet about messages from unrelated frames", () => {
    const { logger, lines } = recordingLogger();
    mountCheckoutElement("#checkout", { clientSecret: CS, logger, loadTimeoutMs: 0 });
    const before = lines.length;

    // A wrong-origin message is almost always another widget on the page.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "billkit:ready" },
        origin: "https://evil.example",
      }),
    );

    expect(lines.length).toBe(before);
  });

  it("warns on a refused redirect and on a load timeout", async () => {
    const { logger, lines } = recordingLogger();
    mountCheckoutElement("#checkout", { clientSecret: CS, logger, loadTimeoutMs: 5 });
    const iframe = getIframe(host);

    fromIframe(iframe, { type: "billkit:redirect", url: "javascript:alert(1)" });
    // Dropped by parseHostMessage before routing, the loader's first
    // line of defence, so it surfaces as a malformed message.
    expect(lines.some((l) => l.level === "warn")).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    const timeout = lines.find((l) => l.message === "BillKit element failed to load");
    expect(timeout?.level).toBe("warn");
    expect(timeout?.context).toMatchObject({ element: "checkout", timeoutMs: 5 });
  });

  it("logs only the origin of a redirect target, never the full url", () => {
    const { logger, lines } = recordingLogger();
    mountCheckoutElement("#checkout", {
      clientSecret: CS,
      logger,
      loadTimeoutMs: 0,
      // Keep jsdom from actually navigating.
      onRedirect: () => false,
    });

    fromIframe(getIframe(host), {
      type: "billkit:redirect",
      url: "https://www.mollie.com/checkout/3ds/tr_SECRETPAYMENTID?token=abc",
    } satisfies HostMessage);

    const text = blob(lines);
    expect(text).not.toContain("tr_SECRETPAYMENTID");
    expect(text).not.toContain("token=abc");
  });

  it("never logs the clientSecret", () => {
    const { logger, lines } = recordingLogger();
    const el = mountCheckoutElement("#checkout", {
      clientSecret: CS,
      logger,
      loadTimeoutMs: 1,
    });
    const iframe = getIframe(host);

    fromIframe(iframe, { type: "billkit:ready" } satisfies HostMessage);
    fromIframe(iframe, { type: "billkit:loaded", sessionId: "cs_test_abc123" } satisfies HostMessage);
    fromIframe(iframe, { type: "billkit:junk", clientSecret: CS });
    el.destroy();

    const text = blob(lines);
    expect(text.length, "expected log lines; the rest would pass vacuously").toBeGreaterThan(0);
    expect(text, "the clientSecret reached a log call").not.toContain(CS);
    expect(text, "the secret tail reached a log call").not.toContain("r4nd0m");
  });
});
