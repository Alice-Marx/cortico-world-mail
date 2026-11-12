/**
 * 假 SMTP 服务器（tests/fixtures/support，W1 交付，W2/W3 可复用）。
 *
 * 只监听 `127.0.0.1:0`（随机端口），测试用完必须 `await server.close()`；不连任何真实网络，
 * 不含真实凭据：默认账号 = tester@example.com / demo-auth-code。
 *
 * 用法：
 *   import { startFakeSmtpServer } from './fixtures/support/fake-smtp-server.ts';
 *
 *   const server = await startFakeSmtpServer();       // 默认支持 EHLO 多行 + AUTH LOGIN/PLAIN
 *   const client = createSmtpClient({
 *     host: '127.0.0.1', port: server.port, secure: false, allowPlaintext: true,
 *     user: server.user, pass: server.pass, timeoutMs: 1000,
 *   });
 *   const result = await client.send(message);
 *   console.log(server.messages);                    // [{ from, to, data, rawData }]
 *   console.log(server.requests);                    // 收到的命令行（不含 DATA 正文）
 *   await client.close();
 *   await server.close();
 *
 * 故障/行为模拟选项（全部可选）：
 *   authMechanisms: ['LOGIN','PLAIN']   只对 PLAIN 用 ['PLAIN']（测“服务器只给 PLAIN”）
 *   authFail: true                       认证回 535（测 auth 分类）
 *   rejectMailFrom: true                 MAIL FROM 回 550（测 protocol 分类）
 *   rejectRecipients: ['x@example.com']  指定 RCPT TO 回 550（其余 250）
 *   recipientAcceptedCode: 251           收件人成功码改成 251
 *   rejectData: true                     DATA 回 554（测 protocol 分类）
 *   greeting: '220 ...'                  自定义问候
 *   delayMs: 10                          每条响应前延迟
 *   hangOn: 'DATA'                       命中命令不响应（测 timeout）
 *   dropOn: 'DATA'                       命中命令直接断连（测 dropped）
 *
 * 限制：假服务器不实现真实 TLS（STARTTLS 需要证书）。W1 只测“服务器不支持 STARTTLS 时报 tls 错”
 * 与“对明文服务器用 implicit TLS 时报 tls 错”，不测成功升级。
 */

import { Buffer } from 'node:buffer';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

// ───────────────────────── 公共类型 ─────────────────────────

export interface FakeSmtpMessage {
  /** MAIL FROM 里的地址（不含尖括号） */
  from: string;
  /** RCPT TO 接受的地址（不含尖括号，按到达顺序） */
  to: string[];
  /** 去 dot-stuffing 后的 DATA 正文（CRLF） */
  data: string;
  /** 线上原始 DATA 正文（保留 dot-stuffing，不含结束行） */
  rawData: string;
}

export interface FakeSmtpServerOptions {
  user?: string;
  pass?: string;
  authMechanisms?: Array<'LOGIN' | 'PLAIN'>;
  authFail?: boolean;
  rejectMailFrom?: boolean;
  rejectRecipients?: string[];
  recipientAcceptedCode?: 250 | 251;
  rejectData?: boolean;
  greeting?: string;
  delayMs?: number;
  hangOn?: string;
  dropOn?: string;
}

export interface FakeSmtpServer {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** 收到的命令行（不含 DATA 正文；认证 base64 行也在内，均为假凭据） */
  requests: string[];
  /** 成功收下的邮件（DATA 结束并回 250 后入列） */
  messages: FakeSmtpMessage[];
  close(): Promise<void>;
}

// ───────────────────────── 默认值 ─────────────────────────

export const DEFAULT_FAKE_SMTP_HOST = '127.0.0.1';
export const DEFAULT_FAKE_SMTP_USER = 'tester@example.com';
export const DEFAULT_FAKE_SMTP_PASS = 'demo-auth-code';

// ───────────────────────── 工具 ─────────────────────────

function delay(ms: number): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parseMailbox(value: string): string {
  const match = /<([^>]*)>/.exec(value);
  if (match) return match[1].trim();
  return value.trim().split(/\s+/)[0] ?? '';
}

function decodeBase64(value: string): string {
  try {
    return Buffer.from(value.trim(), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

interface ConnectionState {
  socket: Socket;
  buffer: string;
  mode: 'command' | 'auth-user' | 'auth-pass' | 'auth-plain' | 'data';
  authUser: string;
  authenticated: boolean;
  mailFrom: string;
  recipients: string[];
  dataLines: string[];
  closed: boolean;
  processing: boolean;
}

// ───────────────────────── 服务器 ─────────────────────────

export async function startFakeSmtpServer(options: FakeSmtpServerOptions = {}): Promise<FakeSmtpServer> {
  const user = options.user ?? DEFAULT_FAKE_SMTP_USER;
  const pass = options.pass ?? DEFAULT_FAKE_SMTP_PASS;
  const mechanisms = options.authMechanisms ?? ['LOGIN', 'PLAIN'];
  const acceptedCode = options.recipientAcceptedCode ?? 250;
  const rejectRecipients = new Set((options.rejectRecipients ?? []).map((address) => address.toLowerCase()));
  const requests: string[] = [];
  const messages: FakeSmtpMessage[] = [];
  const sockets = new Set<Socket>();
  const delayMs = options.delayMs ?? 0;

  const write = (state: ConnectionState, text: string): void => {
    if (state.socket.destroyed) return;
    state.socket.write(text);
  };

  const matchesOption = (keyword: string, option: string | undefined): boolean => {
    if (!option) return false;
    return keyword.startsWith(option.trim().toUpperCase());
  };

  const ehloReply = (): string => {
    const lines: string[] = ['250-fake-smtp greets you'];
    if (mechanisms.length > 0) lines.push(`250-AUTH ${mechanisms.join(' ')}`);
    lines.push('250-8BITMIME');
    lines.push('250-SIZE 33554432');
    lines.push('250 HELP');
    return `${lines.join('\r\n')}\r\n`;
  };

  const finishAuth = (state: ConnectionState): void => {
    if (options.authFail) {
      write(state, '535 5.7.8 Authentication failed\r\n');
      return;
    }
    state.authenticated = true;
    write(state, '235 2.7.0 Authentication successful\r\n');
  };

  const checkCredentials = (state: ConnectionState, password: string): void => {
    const ok = state.authUser === user && password === pass;
    if (ok && !options.authFail) {
      finishAuth(state);
    } else if (options.authFail) {
      finishAuth(state);
    } else {
      write(state, '535 5.7.8 Authentication failed\r\n');
    }
  };

  const resetTransaction = (state: ConnectionState): void => {
    state.mailFrom = '';
    state.recipients = [];
    state.dataLines = [];
    state.mode = 'command';
  };

  const handleLine = async (state: ConnectionState, line: string): Promise<void> => {
    if (state.mode === 'data') {
      if (line === '.') {
        const rawData = state.dataLines.join('\r\n');
        const data = state.dataLines
          .map((dataLine) => (dataLine.startsWith('..') ? dataLine.slice(1) : dataLine))
          .join('\r\n');
        messages.push({
          from: state.mailFrom,
          to: [...state.recipients],
          data,
          rawData,
        });
        resetTransaction(state);
        write(state, '250 2.0.0 Ok: queued as fake-id\r\n');
        return;
      }
      state.dataLines.push(line);
      return;
    }

    if (state.mode === 'auth-user') {
      state.authUser = decodeBase64(line);
      state.mode = 'auth-pass';
      write(state, '334 UGFzc3dvcmQ6\r\n');
      return;
    }
    if (state.mode === 'auth-pass') {
      checkCredentials(state, decodeBase64(line));
      state.mode = 'command';
      return;
    }
    if (state.mode === 'auth-plain') {
      const decoded = decodeBase64(line);
      const parts = decoded.split('\u0000');
      state.authUser = parts.length >= 3 ? parts[1] : parts[0] ?? '';
      checkCredentials(state, parts.length >= 3 ? parts[2] : '');
      state.mode = 'command';
      return;
    }

    requests.push(line);
    if (requests.length > 1000) requests.splice(0, requests.length - 1000);

    const tokens = line.split(/\s+/);
    const command = (tokens[0] ?? '').toUpperCase();
    const keyword = line.toUpperCase();

    if (matchesOption(keyword, options.hangOn)) return;
    if (matchesOption(keyword, options.dropOn)) {
      state.closed = true;
      state.socket.destroy();
      return;
    }
    await delay(delayMs);

    switch (command) {
      case 'EHLO':
        write(state, ehloReply());
        return;
      case 'HELO':
        write(state, '250 fake-smtp\r\n');
        return;
      case 'AUTH': {
        const mechanism = (tokens[1] ?? '').toUpperCase();
        if (!mechanisms.includes(mechanism as 'LOGIN' | 'PLAIN')) {
          write(state, '504 5.5.4 Unrecognized authentication type\r\n');
          return;
        }
        if (mechanism === 'LOGIN') {
          const initial = tokens[2];
          if (initial) {
            state.authUser = decodeBase64(initial);
            state.mode = 'auth-pass';
            write(state, '334 UGFzc3dvcmQ6\r\n');
            return;
          }
          state.mode = 'auth-user';
          write(state, '334 VXNlcm5hbWU6\r\n');
          return;
        }
        // PLAIN
        const payload = tokens.slice(2).join(' ');
        if (!payload) {
          state.mode = 'auth-plain';
          write(state, '334 \r\n');
          return;
        }
        const decoded = decodeBase64(payload);
        const parts = decoded.split('\u0000');
        state.authUser = parts.length >= 3 ? parts[1] : parts[0] ?? '';
        checkCredentials(state, parts.length >= 3 ? parts[2] : '');
        return;
      }
      case 'MAIL': {
        if (!state.authenticated) {
          write(state, '530 5.7.0 Authentication required\r\n');
          return;
        }
        if (options.rejectMailFrom) {
          write(state, '550 5.1.8 Sender address rejected\r\n');
          return;
        }
        state.mailFrom = parseMailbox(line.slice(line.toUpperCase().indexOf('FROM') + 4));
        state.recipients = [];
        write(state, '250 2.1.0 Ok\r\n');
        return;
      }
      case 'RCPT': {
        if (!state.authenticated) {
          write(state, '530 5.7.0 Authentication required\r\n');
          return;
        }
        const recipient = parseMailbox(line.slice(line.toUpperCase().indexOf('TO') + 2));
        if (rejectRecipients.has(recipient.toLowerCase())) {
          write(state, `550 5.1.1 <${recipient}>: Recipient address rejected\r\n`);
          return;
        }
        state.recipients.push(recipient);
        write(state, `${acceptedCode} 2.1.5 Ok\r\n`);
        return;
      }
      case 'DATA': {
        if (!state.authenticated) {
          write(state, '530 5.7.0 Authentication required\r\n');
          return;
        }
        if (options.rejectData) {
          write(state, '554 5.6.0 Message content rejected\r\n');
          return;
        }
        if (!state.mailFrom || state.recipients.length === 0) {
          write(state, '503 5.5.1 Need MAIL/RCPT first\r\n');
          return;
        }
        state.mode = 'data';
        state.dataLines = [];
        write(state, '354 End data with <CR><LF>.<CR><LF>\r\n');
        return;
      }
      case 'RSET':
        resetTransaction(state);
        write(state, '250 2.1.5 Ok\r\n');
        return;
      case 'NOOP':
        write(state, '250 2.0.0 Ok\r\n');
        return;
      case 'VRFY':
        write(state, '252 2.0.0 Cannot VRFY\r\n');
        return;
      case 'QUIT':
        write(state, '221 2.0.0 Bye\r\n');
        state.closed = true;
        state.socket.end();
        return;
      default:
        write(state, '502 5.5.2 Command not recognized\r\n');
    }
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const state: ConnectionState = {
      socket,
      buffer: '',
      mode: 'command',
      authUser: '',
      authenticated: false,
      mailFrom: '',
      recipients: [],
      dataLines: [],
      closed: false,
      processing: false,
    };
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      if (state.closed) return;
      state.buffer += chunk;
      void processBuffer();
    });
    socket.on('error', () => {
      sockets.delete(socket);
    });
    socket.on('close', () => {
      sockets.delete(socket);
      state.closed = true;
    });

    const processBuffer = async (): Promise<void> => {
      if (state.processing) return;
      state.processing = true;
      try {
        for (;;) {
          const newline = state.buffer.indexOf('\n');
          if (newline < 0) break;
          let line = state.buffer.slice(0, newline);
          state.buffer = state.buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          await handleLine(state, line);
          if (state.closed || state.socket.destroyed) return;
        }
      } finally {
        state.processing = false;
      }
    };

    write(state, `${options.greeting ?? '220 fake-smtp ESMTP ready'}\r\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_FAKE_SMTP_HOST, () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    host: DEFAULT_FAKE_SMTP_HOST,
    port: address.port,
    user,
    pass,
    requests,
    messages,
    async close(): Promise<void> {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // 忽略
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
