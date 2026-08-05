import { describe, expect, it } from 'vitest';
// The extension's redaction module is plain ESM with no chrome APIs, so it can be exercised
// directly. It decides what leaves the browser, which makes it the highest-value thing to pin.
import { redactUrl } from '../../extension/lib/redact.js';

describe('redactUrl', () => {
  // Positive control: ordinary pages must still be reportable, otherwise a redactor that drops
  // everything would satisfy the rest of this suite.
  it('reports an ordinary page', () => {
    expect(redactUrl('https://example.com/docs/intro')).toEqual({
      send: true,
      url: 'https://example.com/docs/intro',
      host: 'example.com',
    });
  });

  it('drops the query and fragment by default', () => {
    const out = redactUrl('https://example.com/search?q=secret+thing#section');
    expect(out).toMatchObject({ send: true, url: 'https://example.com/search' });
  });

  it('strips credentials embedded in the URL', () => {
    // These survive both toString() and query stripping, so they need removing explicitly.
    const out = redactUrl('https://alice:hunter2@example.com/account?x=1');
    expect(out.send).toBe(true);
    if (!out.send) return;
    expect(out.url).toBe('https://example.com/account');
    expect(out.url).not.toContain('alice');
    expect(out.url).not.toContain('hunter2');
  });

  it('keeps the query only for hosts the user allowlisted', () => {
    const out = redactUrl('https://example.com/search?q=kept', {
      fullUrlAllowlist: ['example.com'],
    });
    expect(out).toMatchObject({ send: true, url: 'https://example.com/search?q=kept' });
  });

  it('still strips credentials on an allowlisted host', () => {
    const out = redactUrl('https://alice:hunter2@example.com/x?q=1', {
      fullUrlAllowlist: ['example.com'],
    });
    expect(out.send).toBe(true);
    if (!out.send) return;
    expect(out.url).not.toContain('hunter2');
    expect(out.url).toContain('q=1');
  });

  it.each([
    ['file:///C:/Users/me/secret.txt'],
    ['chrome://version'],
    ['edge://settings'],
    ['brave://rewards'],
    ['chrome-extension://abcdef/options.html'],
    ['about:blank'],
  ])('refuses to report %s', (url) => {
    expect(redactUrl(url)).toMatchObject({ send: false });
  });

  it('refuses unparsable and empty input', () => {
    expect(redactUrl('not a url')).toMatchObject({ send: false, reason: 'unparsable' });
    expect(redactUrl('')).toMatchObject({ send: false, reason: 'no_url' });
  });
});
