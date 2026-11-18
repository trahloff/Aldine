import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A gateway's answer: an HTML page, no JSON `error` to quote. */
function htmlResponse(status: number): Response {
  return new Response('<html><body>Bad Gateway</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('req() when the server cannot be reached', () => {
  it('turns a rejected fetch into an ApiError that names the remedy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    let caught: unknown;
    try {
      await api.listProjects();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toBe('Could not reach the server. Check your connection and try again.');
    expect((caught as ApiError).status).toBe(0);
  });

  it('turns a 502, 503 or 504 without a JSON error into "The server is not responding."', async () => {
    for (const status of [502, 503, 504]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(status)));
      let caught: unknown;
      try {
        await api.listProjects();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).message).toBe('The server is not responding.');
      expect((caught as ApiError).status).toBe(status);
    }
  });

  it('keeps a JSON error from the server itself, even on a 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(502, { error: 'Upstream timed out' })));
    let caught: unknown;
    try {
      await api.listProjects();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toBe('Upstream timed out');
    expect((caught as ApiError).status).toBe(502);
  });

  it('still returns the parsed body on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, [])));
    await expect(api.listProjects()).resolves.toEqual([]);
  });
});
