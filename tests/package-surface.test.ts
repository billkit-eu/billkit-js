import { describe, expect, it } from "vitest";

import * as pkg from "../src/index";

/**
 * What the package exports at runtime. 1.0 stopped exporting the
 * postMessage internals: the wire protocol is versioned between this loader
 * and the iframe, and a merchant importing a parser or a constant from it
 * would turn every protocol change into a breaking release.
 */
describe("the public runtime surface", () => {
  it("is exactly the mount functions, the logger default and the stable constants", () => {
    expect(Object.keys(pkg).sort()).toEqual([
      "DEFAULT_IFRAME_ORIGIN",
      "ELEMENT_ERROR_CODES",
      "NOOP_ELEMENT_LOGGER",
      "VERSION",
      "mountCheckoutElement",
      "mountOneShotPaymentElement",
      "mountPaymentMethodElement",
    ]);
  });

  it.each(["sessionIdFromClientSecret", "isSafeRedirectUrl", "DEFAULT_API_BASE", "parseHostMessage"])(
    "no longer exports %s",
    (name) => {
      expect(name in pkg).toBe(false);
    },
  );
});
