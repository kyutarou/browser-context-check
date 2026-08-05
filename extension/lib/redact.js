// URL minimisation. Applied before anything leaves the browser.

const BLOCKED_SCHEMES = ['file:', 'chrome:', 'edge:', 'brave:', 'chrome-extension:', 'moz-extension:', 'about:'];

/**
 * @returns {{ send: false, reason: string } | { send: true, url: string, host: string }}
 */
export function redactUrl(rawUrl, { fullUrlAllowlist = [] } = {}) {
  if (!rawUrl) return { send: false, reason: 'no_url' };

  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { send: false, reason: 'unparsable' };
  }

  if (BLOCKED_SCHEMES.includes(u.protocol)) return { send: false, reason: 'blocked_scheme' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { send: false, reason: 'blocked_scheme' };

  // Credentials embedded in the URL survive both toString() and query stripping, so they have to
  // go explicitly — otherwise https://user:pw@host/ would be stored and displayed verbatim.
  u.username = '';
  u.password = '';

  // Full URL only for hosts the user explicitly allowlisted; otherwise drop query and fragment,
  // which are the usual carriers of tokens, session ids and personal data.
  //
  // Known residual risk: single-use tokens carried in the PATH (e.g. /reset/<token>) cannot be
  // detected generically and are still sent. Documented in docs/DESIGN.md §8.
  if (fullUrlAllowlist.includes(u.host)) {
    return { send: true, url: u.toString(), host: u.host };
  }

  u.search = '';
  u.hash = '';
  return { send: true, url: u.toString(), host: u.host };
}
