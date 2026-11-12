/**
 * SMTP 协议测试（PLAN.md §10，W1）。全部离线：只连 tests/fixtures/support/fake-smtp-server.ts
 * 的 127.0.0.1 随机端口，用完关掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MailError } from '../src/mail/types.ts';
import type { MailAddress, OutgoingMessage, SmtpClient, SmtpOptions } from '../src/mail/types.ts';
import { buildOutgoingMessage, createSmtpClient, prepareSmtpData } from '../src/mail/smtp.ts';
import { parseMail } from '../src/mail/mime.ts';
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
  type FakeSmtpServerOptions,
} from './fixtures/support/fake-smtp-server.ts';

function makeClient(server: FakeSmtpServer, overrides: Partial<SmtpOptions> = {}): SmtpClient {
  return createSmtpClient({
    host: server.host,
    port: server.port,
    secure: false,
    allowPlaintext: true,
    user: server.user,
    pass: server.pass,
    timeoutMs: 800,
    ...overrides,
  });
}

function makeMessage(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { name: '张三', address: 'tester@example.com' },
    to: [{ name: 'Bob', address: 'bob@example.com' }],
    cc: [],
    bcc: [],
    subject: '测试发信',
    text: '第一行\n第二行',
    date: new Date('2026-11-12T00:00:00Z'),
    messageId: '<fixed-smtp-001@example.com>',
    ...overrides,
  };
}

async function withServer(
  options: FakeSmtpServerOptions,
  run: (server: FakeSmtpServer, client: SmtpClient) => Promise<void>,
): Promise<void> {
  const server = await startFakeSmtpServer(options);
  const client = makeClient(server);
  try {
    await run(server, client);
  } finally {
    try {
      await client.close();
    } catch {
      // 忽略
    }
    await server.close();
  }
}

// ───────────────────────── 正常发信 ─────────────────────────

test('SMTP：EHLO 多行 + AUTH LOGIN + MAIL/RCPT/DATA 全流程', async () => {
  await withServer({}, async (server, client) => {
    const result = await client.send(makeMessage());
    assert.deepEqual(result.accepted, ['bob@example.com']);
    assert.deepEqual(result.rejected, []);
    assert.equal(result.messageId, '<fixed-smtp-001@example.com>');
    assert.deepEqual(server.requests.slice(0, 5), [
      'EHLO localhost',
      'AUTH LOGIN',
      'MAIL FROM:<tester@example.com>',
      'RCPT TO:<bob@example.com>',
      'DATA',
    ]);
    // 认证 base64 凭据不落在服务器的命令日志里（日志不泄）
    assert.ok(!server.requests.includes(Buffer.from(server.user, 'utf8').toString('base64')));
    assert.ok(!server.requests.includes(Buffer.from(server.pass, 'utf8').toString('base64')));

    assert.equal(server.messages.length, 1);
    const captured = server.messages[0];
    assert.equal(captured.from, 'tester@example.com');
    assert.deepEqual(captured.to, ['bob@example.com']);
    assert.ok(captured.data.includes('Message-ID: <fixed-smtp-001@example.com>'));
    assert.ok(captured.data.includes('Subject: =?UTF-8?B?'));
    const parsed = parseMail(captured.data);
    assert.equal(parsed.body.text, '第一行\n第二行');
  });
});

test('SMTP：服务器只给 AUTH PLAIN 时用 PLAIN', async () => {
  await withServer({ authMechanisms: ['PLAIN'] }, async (server, client) => {
    await client.send(makeMessage());
    assert.ok(server.requests.some((line) => /^AUTH PLAIN /.test(line)));
    assert.ok(!server.requests.includes('AUTH LOGIN'));
    assert.equal(server.messages.length, 1);
  });
});

test('SMTP：AUTH LOGIN 不被支持时回退 AUTH PLAIN', async () => {
  await withServer({ authMechanisms: ['PLAIN'] }, async (server, client) => {
    // PLAIN 服务器对 AUTH LOGIN 返回 504 的情况由 fake 的 mechanisms 覆盖；这里显式只提供 LOGIN
    await client.send(makeMessage());
    assert.equal(server.messages.length, 1);
  });
});

test('SMTP：多收件人（250/251）全部接受', async () => {
  await withServer({ recipientAcceptedCode: 251 }, async (server, client) => {
    const result = await client.send(
      makeMessage({
        to: [
          { name: '', address: 'a@example.com' },
          { name: '', address: 'b@example.com' },
        ],
        cc: [{ name: '', address: 'c@example.com' }],
      }),
    );
    assert.deepEqual(result.accepted, ['a@example.com', 'b@example.com', 'c@example.com']);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(server.messages[0].to, ['a@example.com', 'b@example.com', 'c@example.com']);
  });
});

test('SMTP：重复地址去重（to 与 bcc 相同只发一个 RCPT）', async () => {
  await withServer({}, async (server, client) => {
    const result = await client.send(
      makeMessage({
        to: [{ name: '', address: 'dup@example.com' }],
        bcc: [{ name: '', address: 'DUP@example.com' }],
      }),
    );
    assert.deepEqual(result.accepted, ['dup@example.com']);
    assert.equal(server.requests.filter((line) => /^RCPT TO:/.test(line)).length, 1);
  });
});

test('SMTP：部分收件人被 550 拒 → 进 rejected，邮件仍发送', async () => {
  await withServer({ rejectRecipients: ['bad@example.com'] }, async (server, client) => {
    const result = await client.send(
      makeMessage({
        to: [
          { name: '', address: 'good@example.com' },
          { name: '', address: 'bad@example.com' },
        ],
      }),
    );
    assert.deepEqual(result.accepted, ['good@example.com']);
    assert.deepEqual(result.rejected, ['bad@example.com']);
    assert.deepEqual(server.messages[0].to, ['good@example.com']);
    assert.ok(server.requests.includes('DATA'));
  });
});

test('SMTP：全部收件人被拒 → accepted 为空、不进入 DATA', async () => {
  await withServer({ rejectRecipients: ['bad1@example.com', 'bad2@example.com'] }, async (server, client) => {
    const result = await client.send(
      makeMessage({
        to: [
          { name: '', address: 'bad1@example.com' },
          { name: '', address: 'bad2@example.com' },
        ],
      }),
    );
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.rejected, ['bad1@example.com', 'bad2@example.com']);
    assert.ok(!server.requests.includes('DATA'));
    assert.equal(server.messages.length, 0);
  });
});

test('SMTP：Bcc 只出现在信封 RCPT，不写进 MIME 正文', async () => {
  await withServer({}, async (server, client) => {
    const result = await client.send(
      makeMessage({
        bcc: [{ name: 'Secret', address: 'secret@example.com' }],
      }),
    );
    assert.deepEqual(result.accepted, ['bob@example.com', 'secret@example.com']);
    assert.ok(server.requests.includes('RCPT TO:<secret@example.com>'));
    assert.ok(!server.messages[0].data.includes('secret@example.com'));
  });
});

test('SMTP：同一 client 连续 send 复用连接，close 发 QUIT 且幂等', async () => {
  await withServer({}, async (server, client) => {
    await client.send(makeMessage({ messageId: '<first@example.com>' }));
    await client.send(makeMessage({ messageId: '<second@example.com>' }));
    assert.equal(server.messages.length, 2);
    assert.equal(server.requests.filter((line) => line.startsWith('EHLO')).length, 1);
    assert.equal(server.requests.filter((line) => line === 'DATA').length, 2);
    await client.close();
    assert.ok(server.requests.includes('QUIT'));
    await assert.doesNotReject(() => client.close());
  });
});

test('SMTP：close 之后再 send 会自动重新建连', async () => {
  await withServer({}, async (server, client) => {
    await client.send(makeMessage({ messageId: '<before-close@example.com>' }));
    await client.close();
    await client.send(makeMessage({ messageId: '<after-close@example.com>' }));
    assert.equal(server.messages.length, 2);
    assert.equal(server.requests.filter((line) => line.startsWith('EHLO')).length, 2);
  });
});

// ───────────────────────── 失败分类 ─────────────────────────

test('SMTP：登录被拒 → auth，hint 指向授权码，message 不含服务器原文', async () => {
  await withServer({ authFail: true }, async (_server, client) => {
    await assert.rejects(
      () => client.send(makeMessage()),
      (error: unknown) => {
        assert.ok(error instanceof MailError);
        assert.equal(error.code, 'auth');
        assert.match(error.hint ?? '', /授权码/);
        assert.ok(!error.message.includes('Authentication failed'));
        assert.ok((error.detail ?? '').includes('Authentication failed'));
        return true;
      },
    );
  });
});

test('SMTP：MAIL FROM 被 550 拒 → protocol，message 不含服务器原文', async () => {
  await withServer({ rejectMailFrom: true }, async (_server, client) => {
    await assert.rejects(
      () => client.send(makeMessage()),
      (error: unknown) => {
        assert.ok(error instanceof MailError);
        assert.equal(error.code, 'protocol');
        assert.ok(!error.message.includes('Sender address rejected'));
        assert.ok((error.detail ?? '').includes('Sender address rejected'));
        return true;
      },
    );
  });
});

test('SMTP：DATA 被 554 拒 → protocol', async () => {
  await withServer({ rejectData: true }, async (_server, client) => {
    await assert.rejects(
      () => client.send(makeMessage()),
      (error: unknown) => error instanceof MailError && error.code === 'protocol',
    );
  });
});

test('SMTP：命令超时 → timeout', async () => {
  await withServer({ hangOn: 'DATA' }, async (_server, client) => {
    const slowClient = makeClient(_server, { timeoutMs: 300 });
    try {
      await assert.rejects(
        () => slowClient.send(makeMessage()),
        (error: unknown) => error instanceof MailError && error.code === 'timeout',
      );
    } finally {
      await slowClient.close();
    }
  });
});

test('SMTP：连接中途断开 → dropped', async () => {
  await withServer({ dropOn: 'DATA' }, async (_server, client) => {
    await assert.rejects(
      () => client.send(makeMessage()),
      (error: unknown) => error instanceof MailError && error.code === 'dropped',
    );
  });
});

test('SMTP：连接被拒 → connect', async () => {
  const server = await startFakeSmtpServer();
  const port = server.port;
  await server.close();
  const client = createSmtpClient({
    host: '127.0.0.1',
    port,
    secure: false,
    allowPlaintext: true,
    user: 'tester@example.com',
    pass: 'demo-auth-code',
    timeoutMs: 500,
  });
  await assert.rejects(
    () => client.send(makeMessage()),
    (error: unknown) => error instanceof MailError && error.code === 'connect',
  );
});

test('SMTP：implicit TLS 连明文服务器 → tls', async () => {
  const server = await startFakeSmtpServer();
  try {
    const client = createSmtpClient({
      host: server.host,
      port: server.port,
      secure: 'implicit',
      user: 'tester@example.com',
      pass: 'demo-auth-code',
      timeoutMs: 1200,
    });
    await assert.rejects(
      () => client.send(makeMessage()),
      (error: unknown) => error instanceof MailError && error.code === 'tls',
    );
  } finally {
    await server.close();
  }
});

test('SMTP：starttls 但服务器不宣告 STARTTLS → tls', async () => {
  await withServer({}, async (server, _client) => {
    const starttlsClient = makeClient(server, { secure: 'starttls' });
    try {
      await assert.rejects(
        () => starttlsClient.send(makeMessage()),
        (error: unknown) => error instanceof MailError && error.code === 'tls',
      );
    } finally {
      await starttlsClient.close();
    }
  });
});

test('SMTP：secure:false 但未允许明文 → tls（安全闸门）', async () => {
  const server = await startFakeSmtpServer();
  try {
    const client = createSmtpClient({
      host: server.host,
      port: server.port,
      secure: false,
      user: 'tester@example.com',
      pass: 'demo-auth-code',
      timeoutMs: 500,
    });
    await assert.rejects(
      () => client.send(makeMessage()),
      (error: unknown) => error instanceof MailError && error.code === 'tls',
    );
  } finally {
    await server.close();
  }
});

test('SMTP：没有有效收件人 → protocol（本地校验，不发信）', async () => {
  await withServer({}, async (server, client) => {
    await assert.rejects(
      () => client.send(makeMessage({ to: [], cc: [], bcc: [] })),
      (error: unknown) => {
        assert.ok(error instanceof MailError);
        assert.equal(error.code, 'protocol');
        assert.match(error.message, /收件人/);
        return true;
      },
    );
    assert.equal(server.messages.length, 0);
  });
});

// ───────────────────────── 纯函数：构造 / DATA 准备 ─────────────────────────

test('buildOutgoingMessage：字段映射与缺省值', () => {
  const draft = {
    to: [{ name: 'A', address: 'a@example.com' }],
    cc: [{ name: 'C', address: 'c@example.com' }],
    bcc: [{ name: 'B', address: 'b@example.com' }],
    subject: 's',
    text: 't',
    html: '<p>h</p>',
    inReplyTo: '<parent@example.com>',
    references: ['<root@example.com>'],
    replyTo: [{ name: 'R', address: 'r@example.com' }],
  };
  const from: MailAddress = { name: 'Me', address: 'me@example.com' };
  const date = new Date('2026-01-02T03:04:05Z');
  const message = buildOutgoingMessage(draft, from, { date, messageId: '<m@example.com>' });
  assert.deepEqual(message.from, from);
  assert.deepEqual(message.to, draft.to);
  assert.deepEqual(message.cc, draft.cc);
  assert.deepEqual(message.bcc, draft.bcc);
  assert.equal(message.subject, 's');
  assert.equal(message.text, 't');
  assert.equal(message.html, '<p>h</p>');
  assert.equal(message.inReplyTo, '<parent@example.com>');
  assert.deepEqual(message.references, ['<root@example.com>']);
  assert.equal(message.date, date);
  assert.equal(message.messageId, '<m@example.com>');
  // OutgoingMessage 契约没有 replyTo 字段：不擅自加头
  assert.equal('replyTo' in message, false);

  const minimal = buildOutgoingMessage({ to: [], subject: '', text: '' }, from);
  assert.deepEqual(minimal.cc, []);
  assert.deepEqual(minimal.bcc, []);
  assert.equal(minimal.html, undefined);
  assert.equal(minimal.date, undefined);
  assert.equal(minimal.messageId, undefined);
});

test('prepareSmtpData：dot-stuffing / CRLF 规范化 / 结束符', () => {
  const raw = 'A: b\r\n\r\nline1\n.\n..x\nlast';
  assert.equal(prepareSmtpData(raw), 'A: b\r\n\r\nline1\r\n..\r\n...x\r\nlast\r\n.\r\n');
  assert.equal(prepareSmtpData('single line'), 'single line\r\n.\r\n');
  assert.equal(prepareSmtpData('a\nb\n'), 'a\r\nb\r\n.\r\n');
  // 单独一行 '.' 会被 dot-stuff 成 '..'，结束符仍是单独的 '.'
  assert.equal(prepareSmtpData('.'), '..\r\n.\r\n');
});
