import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { fixture, capture, origin } from './helpers.js';
import { modelCaller } from '../src/server/model.js';
import { api } from '../src/web/api.js';
// @ts-expect-error Chrome extension uses native ES modules without a build step.
import { decide, parsePairing } from '../extension/core.js';

test('single model boundary uses configured models, validates output and records provenance and actual usage even on invalid output', async () => {
  const f = await fixture();
  try {
    const job = (
      await f.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { origin, cookie: f.cookie },
        payload: capture(),
      })
    ).json();
    const requests: any[] = [];
    let output = '{"passed":true}';
    const transport = (async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        'Bearer private-key',
      );
      return Response.json({
        status: 'completed',
        model: 'served-model',
        usage: { input_tokens: 123, output_tokens: 45 },
        output: [
          { type: 'message', content: [{ type: 'output_text', text: output }] },
        ],
      });
    }) as typeof fetch;
    const call = modelCaller(
      f.db,
      {
        apiKey: 'private-key',
        solModel: 'configured-sol',
        lunaModel: 'configured-luna',
      },
      transport,
    );
    const request = {
      applicantId: f.alice,
      jobId: job.id,
      purpose: 'eligibility' as const,
      promptVersion: 'eligibility-v1',
      instructions: 'Return JSON',
      input: 'Posting',
      output: z.object({ passed: z.boolean() }),
    };
    assert.deepEqual(await call(request), { passed: true });
    assert.equal(requests[0].model, 'configured-sol');
    assert.equal(requests[0].store, false);
    assert.equal(requests[0].reasoning.effort, 'low');
    output = '{"passed":"invalid"}';
    await assert.rejects(
      () => call({ ...request, purpose: 'answer_equivalence' }),
      /Model call failed/,
    );
    assert.equal(requests[1].model, 'configured-luna');
    const calls = (
      await f.db.query('SELECT * FROM model_calls ORDER BY created_at')
    ).rows;
    assert.equal(calls.length, 2);
    assert.equal(calls[0].provider, 'openai');
    assert.equal(calls[0].prompt_version, 'eligibility-v1');
    assert.equal(calls[0].model, 'served-model');
    assert.equal(calls[0].input_tokens, 123);
    assert.equal(calls[1].output_tokens, 45);
    assert.equal(calls[1].status, 'failed');
    const ledger = (
      await f.app.inject({ url: '/api/events', headers: { cookie: f.cookie } })
    ).body;
    assert.ok(!ledger.includes('private-key'));
    assert.ok(!ledger.includes('Return JSON'));
    await assert.rejects(
      () => call({ ...request, applicantId: f.bob }),
      /not found/,
    );
    assert.equal(requests.length, 2);
    const failed = modelCaller(
      f.db,
      { apiKey: 'private-key', solModel: 'sol', lunaModel: 'luna' },
      (async () =>
        new Response('secret provider error', { status: 429 })) as typeof fetch,
    );
    await assert.rejects(() => failed(request), /Model call failed/);
    const errorCall = (
      await f.db.query("SELECT * FROM model_calls WHERE model='sol'")
    ).rows[0];
    assert.equal(errorCall.input_tokens, null);
    assert.equal(errorCall.status, 'failed');
  } finally {
    await f.close();
  }
});

test('extension No sends nothing; Yes keeps both URLs and retry ID; pairing refuses insecure remote origins', async () => {
  const input = capture();
  let networkCalls = 0;
  const pairing = {
    serverUrl: origin,
    applicantId: '00000000-0000-4000-8000-000000000001',
    token: 'a'.repeat(43),
  };
  const transport = (async (url: string, init: RequestInit) => {
    networkCalls++;
    assert.equal(
      url,
      `${origin}/api/extension/${pairing.applicantId}/captures`,
    );
    assert.deepEqual(JSON.parse(init.body as string), input);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    return Response.json({ id: 'saved' });
  }) as typeof fetch;
  assert.deepEqual(await decide('no', input, pairing, transport), {
    dismissed: true,
  });
  assert.equal(networkCalls, 0);
  await decide('yes', input, pairing, transport);
  await decide('yes', input, pairing, transport);
  assert.equal(networkCalls, 2);
  assert.deepEqual(parsePairing(JSON.stringify(pairing)), pairing);
  assert.throws(
    () =>
      parsePairing(
        JSON.stringify({ ...pairing, serverUrl: 'http://remote.example' }),
      ),
    /HTTPS/,
  );
  assert.throws(
    () =>
      parsePairing(
        JSON.stringify({ ...pairing, serverUrl: 'https://example.com/path' }),
      ),
    /HTTPS/,
  );
});

test('dashboard revocation request has no empty JSON body and succeeds through the HTTP boundary', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    const pairing = (
      await f.app.inject({
        method: 'POST',
        url: '/api/pairings',
        headers: { origin, cookie: f.cookie },
        payload: { label: 'Browser request fixture' },
      })
    ).json();
    globalThis.fetch = (async (path: string, init: RequestInit) => {
      assert.equal(new Headers(init.headers).has('Content-Type'), false);
      const response = await f.app.inject({
        method: 'DELETE',
        url: path,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          origin,
          cookie: f.cookie,
        },
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    assert.deepEqual(
      await api(`/api/pairings/${pairing.id}`, { method: 'DELETE' }),
      { revoked: true },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await f.close();
  }
});
