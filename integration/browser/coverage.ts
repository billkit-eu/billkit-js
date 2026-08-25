/**
 * Parity gate for the **browser** SDK family (`js` + `react`).
 *
 * Lives here, next to the manifest, rather than inside either package:
 * both suites import this exact file, so the two can never drift into
 * checking different things.
 *
 * Identical mechanism to the server family's gate: adding a `browser`
 * scenario to `sdk/integration/scenarios.json` fails both browser suites
 * until each implements it, so a capability can't land in `@billkit-eu/js` and
 * quietly skip `@billkit-eu/react` (which wraps it and is the surface most
 * tenants actually use).
 *
 * Only same-family scenarios are required: a browser checkout SDK has no
 * `crud.product` to implement.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
  version: number;
  families: Record<string, string[]>;
  scenarios: Array<{ id: string; family: string; group: string; summary: string }>;
}

const FAMILY = "browser";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "..", "scenarios.json");

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/** Scenario ids this run exercised; populated by the suite's `scenario()`. */
export const COVERED = new Set<string>();

export function assertManifestCoverage(suiteName: string): void {
  const required = loadManifest()
    .scenarios.filter((s) => s.family === FAMILY)
    .map((s) => s.id);
  const missing = required.filter((id) => !COVERED.has(id));
  const unknown = [...COVERED].filter((id) => !required.includes(id));

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `Not implemented by the ${suiteName} suite (family "${FAMILY}"):\n  ${missing.join("\n  ")}\n` +
        "Implement them, or drop them from sdk/integration/scenarios.json if the " +
        "capability is genuinely gone from every browser SDK.",
    );
  }
  if (unknown.length > 0) {
    problems.push(
      `Tagged with ids that are not in the manifest:\n  ${unknown.join("\n  ")}\n` +
        "Add them to sdk/integration/scenarios.json so the sibling browser SDK is " +
        "held to the same bar (that is the whole point of the manifest).",
    );
  }
  if (problems.length > 0) {
    throw new Error(`SDK integration parity gate failed.\n\n${problems.join("\n\n")}`);
  }
}
