import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { SetupReport } from './apollo.js';

/**
 * Gmail SMTP over implicit TLS (smtp.gmail.com:465) with an app password,
 * written on node built-ins. The socket factory is injectable so the protocol
 * is tested against a scripted in-memory server.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
}
export interface SmtpSender {
  readonly configured: boolean;
  readonly from: string | null;
  verify(): Promise<SetupReport>;
  send(
    message: OutgoingEmail,
  ): Promise<{ messageId: string; response: string }>;
}
export class SmtpNotConfiguredError extends Error {
  constructor() {
    super('Gmail SMTP is not configured on the server');
  }
}
/** The outcome is unknown: the message may or may not have been accepted. */
export class SmtpTimeoutError extends Error {}
/** The server refused before accepting the message; nothing was sent. */
export class SmtpRejectedError extends Error {
  constructor(
    message: string,
    public code: number,
  ) {
    super(message);
  }
}
/** Account sending limit reached (Gmail 4.7.0 / 5.4.5 quota replies). */
export class SmtpLimitError extends SmtpRejectedError {}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  appPassword?: string;
  timeoutMs: number;
  connect?: (host: string, port: number) => Duplex;
}
const defaultConnect = (host: string, port: number): Duplex =>
  tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' });

const clean = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
function encodeHeader(value: string) {
  const text = clean(value);
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}
export function formatMessage(
  from: string,
  message: OutgoingEmail,
  messageId: string,
  date = new Date(),
) {
  const body = Buffer.from(message.body.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${clean(from)}`,
    `To: ${clean(message.to)}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

class Session {
  private buffer = '';
  private waiting: ((line: string) => void) | null = null;
  private lines: string[] = [];
  private failure: Error | null = null;
  private timer: NodeJS.Timeout;
  constructor(
    private socket: Duplex,
    timeoutMs: number,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.buffer = this.buffer.slice(index + 1);
        this.push(line);
      }
    });
    const fail = (error: Error) => {
      this.failure ??= error;
      this.push(null);
    };
    socket.on('error', () => fail(new Error('SMTP connection failed')));
    socket.on('close', () => fail(new Error('SMTP connection closed')));
    this.timer = setTimeout(() => {
      fail(new SmtpTimeoutError('SMTP timed out'));
      socket.destroy();
    }, timeoutMs);
  }
  private push(line: string | null) {
    if (line !== null) this.lines.push(line);
    const waiter = this.waiting;
    if (waiter && (this.lines.length || this.failure)) {
      this.waiting = null;
      waiter(this.lines.shift() ?? '');
    }
  }
  private nextLine(): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = (line) =>
        this.failure && !line ? reject(this.failure) : resolve(line);
    });
  }
  async reply(): Promise<{ code: number; text: string }> {
    const parts: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      parts.push(line.slice(4));
      if (line[3] !== '-')
        return { code: Number(line.slice(0, 3)), text: parts.join('\n') };
    }
  }
  write(data: string) {
    this.socket.write(data);
  }
  close() {
    clearTimeout(this.timer);
    this.socket.destroy();
  }
}

export function gmailSmtp(config: SmtpConfig): SmtpSender {
  const configured = Boolean(config.user && config.appPassword);
  async function session<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    if (!configured) throw new SmtpNotConfiguredError();
    const s = new Session(
      (config.connect ?? defaultConnect)(config.host, config.port),
      config.timeoutMs,
    );
    try {
      return await fn(s);
    } finally {
      s.close();
    }
  }
  async function expect(
    s: Session,
    command: string | null,
    accepted: number[],
  ) {
    if (command !== null) s.write(command + '\r\n');
    const reply = await s.reply();
    if (!accepted.includes(reply.code)) {
      const text = `SMTP ${reply.code}: ${reply.text.slice(0, 200)}`;
      if (/4\.7\.0|5\.4\.5|limit|quota/i.test(reply.text))
        throw new SmtpLimitError(text, reply.code);
      throw new SmtpRejectedError(text, reply.code);
    }
    return reply;
  }
  async function login(s: Session) {
    await expect(s, null, [220]);
    await expect(s, 'EHLO jobapply.local', [250]);
    const token = Buffer.from(
      `\0${config.user}\0${config.appPassword}`,
      'utf8',
    ).toString('base64');
    await expect(s, `AUTH PLAIN ${token}`, [235]);
  }
  return {
    configured,
    from: config.user ?? null,
    async verify() {
      try {
        await session(async (s) => {
          await login(s);
          await expect(s, 'QUIT', [221]);
        });
        return {
          ok: true,
          checks: [
            {
              name: 'smtp_auth',
              ok: true,
              detail: `TLS + app-password login accepted at ${config.host}:${config.port}`,
            },
          ],
        };
      } catch (error) {
        return {
          ok: false,
          checks: [
            { name: 'smtp_auth', ok: false, detail: (error as Error).message },
          ],
        };
      }
    },
    async send(message) {
      const from = config.user!;
      const domain = from.split('@')[1] ?? 'jobapply.local';
      const messageId = `<${randomUUID()}@${domain}>`;
      return session(async (s) => {
        await login(s);
        await expect(s, `MAIL FROM:<${clean(from)}>`, [250]);
        await expect(s, `RCPT TO:<${clean(message.to)}>`, [250, 251]);
        await expect(s, 'DATA', [354]);
        // From here on a failure leaves the outcome unknown.
        s.write(formatMessage(from, message, messageId) + '\r\n.\r\n');
        let reply;
        try {
          reply = await expect(s, null, [250]);
        } catch (error) {
          if (error instanceof SmtpRejectedError) throw error;
          throw new SmtpTimeoutError('No SMTP reply after message data');
        }
        s.write('QUIT\r\n');
        return { messageId, response: reply.text.slice(0, 200) };
      });
    },
  };
}
