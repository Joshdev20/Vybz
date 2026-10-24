/** API client: cookie sessions, structured errors, retry-safe. */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || 'Request failed.');
    this.status = status;
    this.code = code;
    this.details = details;
    this.isNetwork = false;
  }
}

export class NetworkError extends Error {
  constructor(message = 'You appear to be offline. Check your connection and try again.') {
    super(message);
    this.isNetwork = true;
    this.status = 0;
  }
}

async function request(method, path, body, { retries = 0, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = data?.error || {};
      // Retry only idempotent reads on transient server errors.
      if (retries > 0 && res.status >= 500 && method === 'GET') {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 400));
        return request(method, path, body, { retries: retries - 1, timeoutMs });
      }
      throw new ApiError(res.status, err.code || 'error', err.message, err.details);
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') {
      throw new NetworkError('That request took too long. Please try again.');
    }
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, { retries: 1, ...opts }),
  post: (path, body, opts) => request('POST', path, body ?? {}, opts),
  patch: (path, body, opts) => request('PATCH', path, body ?? {}, opts),
  put: (path, body, opts) => request('PUT', path, body ?? {}, opts),
  del: (path, body, opts) => request('DELETE', path, body, opts),
};

/** Upload an avatar from a File, with client-side validation. */
export function readImageAsDataUrl(file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      reject(new Error('Choose a PNG, JPEG or WebP image.'));
      return;
    }
    if (file.size > maxBytes) {
      reject(new Error('Images must be 2 MB or smaller.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}
