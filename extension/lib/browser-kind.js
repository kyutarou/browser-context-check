// Browser identification from UA Client Hints.
//
// Two traps this module exists to avoid:
//   1. brands[] contains GREASE entries (deliberately fake brands) and its order is not stable,
//      so the first element is NOT the browser name. Match against a known-brand allowlist.
//   2. Brave reports a UA-CH brand version that can be the Chromium major version rather than
//      Brave's own 1.x product version, so productVersion must stay nullable.

const KNOWN_BRANDS = [
  { match: 'Microsoft Edge', kind: 'edge' },
  { match: 'Brave', kind: 'brave' },
  { match: 'Google Chrome', kind: 'chrome' },
  { match: 'Chromium', kind: 'chromium' },
];

/** @returns {{brand: string, version: string} | null} */
function findKnownBrand(brands) {
  if (!Array.isArray(brands)) return null;
  for (const known of KNOWN_BRANDS) {
    const hit = brands.find((b) => b && b.brand === known.match);
    if (hit) return { kind: known.kind, brand: hit.brand, version: hit.version || null };
  }
  return null;
}

/**
 * Resolve browser kind and versions. Safe to call from the extension service worker:
 * `navigator.userAgentData` is exposed on WorkerNavigator and needs no manifest permission.
 */
export async function detectBrowser() {
  const uaData = globalThis.navigator && navigator.userAgentData;

  let engineVersion = null;
  let productVersion = null;
  let kind = 'unknown';
  let rawBrands = [];

  if (uaData) {
    rawBrands = (uaData.brands || []).map((b) => ({ brand: b.brand, version: b.version }));

    // Chromium's own entry carries the engine version. Chrome and Edge both ship it.
    const chromium = findKnownBrand(rawBrands.filter((b) => b.brand === 'Chromium'));
    if (chromium) engineVersion = chromium.version;

    const primary = findKnownBrand(rawBrands);
    if (primary) {
      kind = primary.kind;
      // Only trust this as a product version when the brand is not Brave (see trap 2).
      if (primary.kind !== 'brave') productVersion = primary.version;
    }

    try {
      const high = await uaData.getHighEntropyValues(['fullVersionList']);
      const list = high && high.fullVersionList;
      if (Array.isArray(list)) {
        const full = findKnownBrand(list);
        if (full && full.kind !== 'brave') productVersion = full.version || productVersion;
        const fullChromium = list.find((b) => b.brand === 'Chromium');
        if (fullChromium) engineVersion = fullChromium.version || engineVersion;
      }
    } catch {
      // getHighEntropyValues may be restricted; the low-entropy values above still stand.
    }
  }

  // Brave exposes navigator.brave on WorkerNavigator too, so this works in the service worker.
  try {
    if (globalThis.navigator && navigator.brave && (await navigator.brave.isBrave())) {
      kind = 'brave';
      productVersion = null;
    }
  } catch {
    // Not Brave, or the check is unavailable. Leave the UA-CH verdict in place.
  }

  return { browserKind: kind, engineVersion, productVersion, rawBrands };
}
