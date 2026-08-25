/**
 * Theme tokens the tenant passes at mount time. Forwarded verbatim to the
 * js.billkit.eu iframe over `postMessage` (never baked into the URL), so
 * the BillKit-styled element honours the tenant's brand (colour, radius,
 * and font) without the tenant hosting any payment UI themselves.
 *
 * All fields optional: omitted tokens fall back to BillKit defaults inside
 * the iframe. Values are raw CSS strings (`"#6d28d9"`, `"8px"`,
 * `"'Inter', sans-serif"`); the iframe validates + clamps them.
 */
export interface BillKitThemeTokens {
  /** Primary / accent colour: buttons, focus rings, selected tiles. */
  colorPrimary?: string;
  /** Element surface background. */
  colorBackground?: string;
  /** Default body text colour. */
  colorText?: string;
  /** Muted/caption text colour. */
  colorTextSecondary?: string;
  /** Error text + invalid-field border colour. */
  colorDanger?: string;
  /** Font stack for all element text. */
  fontFamily?: string;
  /** Corner radius for inputs, tiles, and the pay button. */
  borderRadius?: string;
  /** Base spacing unit the element scales its paddings from. */
  spacingUnit?: string;
  /** `"light"` | `"dark"`; seeds the iframe's default palette. */
  colorScheme?: "light" | "dark";
}
