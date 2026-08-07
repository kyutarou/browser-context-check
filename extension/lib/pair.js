// Pairing, shared by the options page and by messages the console sends directly.
//
// Copying a long base64 blob between two windows is the step people get wrong, so the console can
// hand it over instead. The logic lives here so both routes behave identically.

import { getInstallationId } from './ids.js';
import { accessHeaders } from './relay.js';

export const DEFAULT_ENDPOINT = 'https://dashboard.dxj.jp/browser-check/ingest/v1';

/** @returns {{ok: true, bundle: object} | {ok: false, reason: string}} */
export function decodeBundle(raw) {
  let json;
  try {
    json = JSON.parse(atob(String(raw).replace(/\s+/g, '')));
  } catch {
    return { ok: false, reason: 'バンドルを読み取れません。コンソールからコピーし直してください。' };
  }
  const missing = ['code', 'accessClientId', 'accessClientSecret'].filter((k) => !json[k]);
  if (missing.length) return { ok: false, reason: `バンドルに ${missing.join(', ')} がありません。` };
  return { ok: true, bundle: json };
}

/**
 * Redeems a bundle and stores the credentials it yields.
 *
 * @returns {{ok: true, deviceId: string} | {ok: false, reason: string}}
 */
export async function pairWithBundle(rawBundle, profileAlias) {
  const alias = String(profileAlias || '').trim();
  if (!alias) return { ok: false, reason: 'プロファイル名を入力してください。' };

  const decoded = decodeBundle(rawBundle);
  if (!decoded.ok) return decoded;

  const { code, accessClientId, accessClientSecret, endpoint: bundleEndpoint } = decoded.bundle;
  const endpoint =
    bundleEndpoint || (await chrome.storage.local.get('endpoint')).endpoint || DEFAULT_ENDPOINT;
  const installationId = await getInstallationId();
  const access = { clientId: accessClientId, clientSecret: accessClientSecret };

  let res;
  try {
    res = await fetch(endpoint + '/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...accessHeaders(access) },
      body: JSON.stringify({ code, installationId, profileAlias: alias }),
    });
  } catch (err) {
    return { ok: false, reason: `ペアリング失敗: ${String(err).slice(0, 120)}` };
  }

  if (!res.ok) {
    const detail = await res.text();
    return { ok: false, reason: `ペアリング失敗: ${res.status} ${detail.slice(0, 120)}` };
  }

  const { deviceId, relaySecret } = await res.json();
  // Only persisted once the credentials have actually authenticated a request.
  await chrome.storage.local.set({
    deviceId,
    relaySecret,
    profileAlias: alias,
    endpoint,
    accessClientId,
    accessClientSecret,
    sequence: 0,
  });
  return { ok: true, deviceId };
}
