import { QueryClient, useQuery } from '@tanstack/react-query';
import type { ApiError, AuthStatus } from '@marquee/shared';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the Marquee API. Writes are always JSON (the server requires it). */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: ['POST', 'PUT', 'PATCH'].includes(method) ? { 'Content-Type': 'application/json' } : undefined,
    body: ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify(init.body ?? {}) : undefined,
  });
  const data = (await res.json().catch(() => null)) as T | ApiError | null;
  if (!res.ok) {
    const err = data as ApiError | null;
    throw new ApiFailure(res.status, err?.error ?? 'http_error', err?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiFailure && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

export function useAuthStatus() {
  return useQuery({ queryKey: ['auth'], queryFn: () => api<AuthStatus>('/auth/status'), staleTime: 60_000 });
}

export function refreshAuth() {
  return queryClient.invalidateQueries({ queryKey: ['auth'] });
}
