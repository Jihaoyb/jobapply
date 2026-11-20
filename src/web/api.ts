export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
