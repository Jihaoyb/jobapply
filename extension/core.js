export function parsePairing(raw) {
  const input = JSON.parse(raw);
  const origin = new URL(input.serverUrl);
  if (
    origin.origin !== input.serverUrl ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(origin.hostname)
      ))
  )
    throw new Error(
      'Pair with an HTTPS dashboard (or localhost for development)',
    );
  if (
    !/^[a-f0-9-]{36}$/i.test(input.applicantId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.token)
  )
    throw new Error('Invalid pairing details');
  return {
    serverUrl: origin.origin,
    applicantId: input.applicantId,
    token: input.token,
  };
}
export async function extensionRequest(pairing, path, body, transport = fetch) {
  const response = await transport(
    `${pairing.serverUrl}/api/extension/${pairing.applicantId}/${path}`,
    {
      method: body ? 'POST' : 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${pairing.token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Pairing expired or revoked. Pair again from your dashboard.'
        : 'Capture failed. Check the fields and retry.',
    );
  return response.json();
}
export async function decide(decision, draft, pairing, transport = fetch) {
  if (decision === 'no') return { dismissed: true };
  if (decision !== 'yes') throw new Error('Choose Yes or No');
  return extensionRequest(pairing, 'captures', draft, transport);
}
