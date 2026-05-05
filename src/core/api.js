/**
 * Unified API Fetch Wrapper
 * Centralizes endpoint resolution, authentication headers, and standard error handling.
 */

export async function apiFetch(endpoint, options = {}) {
  const baseUrl = import.meta.env.BASE_URL || '/';
  // Strip leading slash from endpoint if baseUrl has trailing slash, or vice versa
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const url = `${baseUrl}${cleanEndpoint}`;

  const headers = {
    ...options.headers,
  };

  // Inject authentication header automatically if configured
  if (import.meta.env.VITE_APP_AUTH && !headers['Authorization']) {
    headers['Authorization'] = import.meta.env.VITE_APP_AUTH;
  }

  // Ensure JSON requests set content-type
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(url, { ...options, headers });
}
