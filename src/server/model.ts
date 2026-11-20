import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { appendEvent, HttpError } from './ledger.js';

export interface ModelRequest<T> {
  applicantId: string;
  jobId: string;
  purpose:
    'eligibility' | 'answer_equivalence' | 'contact_ranking' | 'outreach_draft';
  promptVersion: string;
  instructions: string;
  input: string;
  output: z.ZodType<T>;
}
interface ModelConfig {
  apiKey?: string;
  solModel: string;
  lunaModel: string;
}
const responseSchema = z.object({
  status: z.literal('completed'),
  model: z.string().min(1),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  output: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    }),
  ),
});
/** The only provider boundary. No key, raw prompt, or provider error enters the ledger. */
export function modelCaller(
  db: Database,
  config: ModelConfig,
  transport: typeof fetch = fetch,
) {
  return async function callModel<T>(request: ModelRequest<T>): Promise<T> {
    z.string().trim().min(1).parse(request.promptVersion);
    const owner = await db.query(
      'SELECT id FROM jobs WHERE id=$1 AND applicant_id=$2',
      [request.jobId, request.applicantId],
    );
    if (!owner.rows.length) throw new HttpError(404, 'Job not found');
    if (!config.apiKey) throw new Error('OpenAI is not configured');
    const requestedModel =
      request.purpose === 'eligibility' ? config.solModel : config.lunaModel;
    let model = requestedModel,
      inputTokens: number | null = null,
      outputTokens: number | null = null;
    const callId = randomUUID();
    let result: T | undefined,
      completed = false;
    try {
      const response = await transport('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: requestedModel,
          instructions: request.instructions,
          input: request.input,
          reasoning: { effort: 'low' },
          store: false,
          max_output_tokens: 4000,
          text: { format: { type: 'json_object' } },
        }),
      });
      if (!response.ok) throw new Error('Provider request failed');
      const body: unknown = await response.json();
      // Usage still counts when a response is incomplete, refused, or fails validation.
      const accounting = z
        .object({
          model: z.string().min(1),
          usage: z.object({
            input_tokens: z.number().int().nonnegative(),
            output_tokens: z.number().int().nonnegative(),
          }),
        })
        .safeParse(body);
      if (accounting.success) {
        model = accounting.data.model;
        inputTokens = accounting.data.usage.input_tokens;
        outputTokens = accounting.data.usage.output_tokens;
      }
      const parsed = responseSchema.parse(body);
      const text = parsed.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text ?? '')
        .join('');
      result = request.output.parse(JSON.parse(text));
      completed = true;
    } catch {
      // Fail closed; caller decides whether to open a provider-limit/ambiguity ticket.
    }
    const status = completed ? ('completed' as const) : ('failed' as const);
    await db.transaction(async (sql) => {
      await sql.query(
        'INSERT INTO model_calls (id,applicant_id,job_id,provider,model,prompt_version,input_tokens,output_tokens,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          callId,
          request.applicantId,
          request.jobId,
          'openai',
          model,
          request.promptVersion,
          inputTokens,
          outputTokens,
          status,
        ],
      );
      await appendEvent(
        sql,
        request.applicantId,
        request.jobId,
        'model.called',
        {
          callId,
          provider: 'openai',
          model,
          promptVersion: request.promptVersion,
          inputTokens,
          outputTokens,
          status,
        },
      );
    });
    if (!completed)
      throw new Error('Model call failed; review or retry required');
    return result as T;
  };
}

export function configuredModelCaller(db: Database) {
  return modelCaller(db, {
    apiKey: process.env.OPENAI_API_KEY,
    solModel: process.env.OPENAI_SOL_MODEL ?? 'gpt-6.1-sol',
    lunaModel: process.env.OPENAI_LUNA_MODEL ?? 'gpt-6-luna',
  });
}
