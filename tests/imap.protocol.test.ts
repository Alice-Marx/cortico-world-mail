/**
 * IMAP 协议测试（PLAN.md §10，W1）。全部离线：只连 tests/fixtures/support/fake-imap-server.ts
 * 的 127.0.0.1 随机端口，用完关掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MailError } from '../src/mail/types.ts';
import { createImapClient } from '../src/mail/imap.ts';
import type { ImapClient, ImapOptions } from '../src/mail/types.ts';
import {
  startFakeImapServer,
  type FakeImapServer,
  type FakeImapServerOptions,
} from './fixtures/support/fake-imap-server.ts';

function makeClient(server: FakeImapServer, overrides: Partial<ImapOptions> = {}): ImapClient {
  return createImapClient({
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

async function withServer(
  options: FakeImapServerOptions,
  run: (server: FakeImapServer, client: ImapClient) => Promise<void>,
): Promise<void> {
  const server = await startFakeImapServer(options);
  const client = makeClient(server);
  try {
    await run(server, client);
  } finally {
    try {
      await client.logout();
    } catch {
      // 测试失败路径下 logout 失败可忽略
    }
    await server.close();
  }
}

// ───────────────────────── 连接 / 文件夹 / 选择 ─────────────────────────

test('IMAP：connect + CAPABILITY + LOGIN，folders 解码 UTF-7 并跳过 \\Noselect', async () => {
  await withServer({}, async (server, client) => {
    await client.connect();
    const folders = await client.folders();
    assert.deepEqual(folders, ['INBOX', '已发送', '垃圾邮件']); // Archive 是 \Noselect，被过滤
    assert.ok(server.requests.some((line) => /CAPABILITY/.test(line)));
    assert.ok(server.requests.some((line) => /^A\d+ LOGIN "/.test(line)));
  });
});

test('IMAP：未显式 connect 时公开方法也会自动建连', async () => {
  await withServer({}, async (_server, client) => {
    const folders = await client.folders();
    assert.ok(folders.includes('INBOX'));
  });
});

test('IMAP：select 返回 exists / uidValidity / uidNext', async () => {
  await withServer({}, async (_server, client) => {
    const info = await client.select('INBOX');
    assert.deepEqual(info, { exists: 3, uidValidity: 1, uidNext: 104 });
  });
});

test('IMAP：选择不存在的文件夹 → protocol，message 不含服务器原文', async () => {
  await withServer({}, async (_server, client) => {
    await client.connect();
    await assert.rejects(
      () => client.select('NoSuchFolder'),
      (error: unknown) => {
        assert.ok(error instanceof MailError);
        assert.equal(error.code, 'protocol');
        assert.ok(!error.message.includes('No such mailbox'));
        assert.ok((error.detail ?? '').includes('No such mailbox'));
        return true;
      },
    );
  });
});

// ───────────────────────── fetchHeaders ─────────────────────────

test('IMAP：fetchHeaders 默认最新 limit 封、按 UID 降序、头字段解析正确', async () => {
  await withServer({}, async (_server, client) => {
    await client.connect();
    const headers = await client.fetchHeaders('INBOX', { limit: 2 });
    assert.deepEqual(
      headers.map((header) => header.uid),
      [103, 102],
    );
    assert.equal(headers[0].subject, 'HTML newsletter');
    assert.equal(headers[0].flags.seen, true);
    assert.equal(headers[1].flags.seen, false);
    assert.ok(headers[1].size > 0);
    assert.equal(headers[0].folder, 'INBOX');
    assert.equal(headers[0].messageId, '<fake-103@example.org>');
    assert.equal(headers[1].from[0].address, 'bob@example.net');
    assert.equal(headers[1].date, '2026-11-11T10:30:00.000Z');
  });
});

test('IMAP：fetchHeaders unreadOnly 使用 UID SEARCH UNSEEN', async () => {
  await withServer({}, async (server, client) => {
    await client.connect();
    const headers = await client.fetchHeaders('INBOX', { unreadOnly: true });
    assert.deepEqual(
      headers.map((header) => header.uid),
      [102],
    );
    assert.ok(server.requests.some((line) => /UID SEARCH UNSEEN/i.test(line)));
  });
});

test('IMAP：fetchHeaders afterUid 只取更新的邮件（增量语义）', async () => {
  await withServer({}, async (server, client) => {
    await client.connect();
    const headers = await client.fetchHeaders('INBOX', { afterUid: 101 });
    assert.deepEqual(
      headers.map((header) => header.uid),
      [103, 102],
    );
    assert.ok(server.requests.some((line) => /UID FETCH 102:\*/i.test(line)));
  });
});

test('IMAP：空文件夹 fetchHeaders 返回空数组', async () => {
  await withServer({}, async (_server, client) => {
    await client.connect();
    assert.deepEqual(await client.fetchHeaders('垃圾邮件'), []);
  });
});

// ───────────────────────── literal 跨包 / 整封 ─────────────────────────

test('IMAP：literal 跨 TCP 包（splitLiterals）也能正确读完整封', async () => {
  await withServer({ splitLiterals: true }, async (_server, client) => {
    await client.connect();
    const message = await client.fetchMessage('INBOX', 101);
    assert.equal(message.subject, 'Welcome to the demo inbox');
    assert.ok(message.body.text.includes('first message in the fake mailbox'));
    assert.equal(message.flags.seen, true);
  });
});

test('IMAP：fetchMessage 解析正文/头/摘要，且不自动标记 \\Seen', async () => {
  await withServer({}, async (server, client) => {
    await client.connect();
    const message = await client.fetchMessage('INBOX', 102);
    assert.equal(message.uid, 102);
    assert.equal(message.folder, 'INBOX');
    assert.equal(message.subject, 'Unread notification');
    assert.equal(message.body.text, 'You have one unread notification.');
    assert.equal(message.body.html, '');
    assert.equal(message.snippet, 'You have one unread notification.');
    assert.equal(message.headers['message-id'], '<fake-102@example.net>');
    assert.equal(message.headers.date, 'Tue, 11 Nov 2026 10:30:00 +0000');
    assert.deepEqual(message.attachments, []);
    assert.equal(message.flags.seen, false);
    // 不需要已读时绝不发 STORE（PLAN：markSeen 只由上层按配置调用）
    assert.ok(!server.requests.some((line) => /STORE/i.test(line)));
    assert.deepEqual(
      server.findFolder('INBOX')?.messages.find((item) => item.uid === 102)?.flags,
      [],
    );
  });
});

test('IMAP：fetchMessage 的 HTML 邮件 body.html 是纯文本化结果', async () => {
  await withServer({}, async (_server, client) => {
    await client.connect();
    const message = await client.fetchMessage('INBOX', 103);
    assert.equal(message.body.html, 'Hello HTML world');
    assert.equal(message.body.text, 'Hello HTML world');
    assert.equal(message.hasAttachments, false);
  });
});

test('IMAP：markSeen 发送 UID STORE +FLAGS \\Seen 并更新服务器状态', async () => {
  await withServer({}, async (server, client) => {
    await client.connect();
    await client.markSeen('INBOX', 102);
    assert.ok(server.requests.some((line) => /UID STORE 102 \+FLAGS \(\\Seen\)/i.test(line)));
    assert.ok(
      server.findFolder('INBOX')?.messages.find((item) => item.uid === 102)?.flags.includes('\\Seen'),
    );
    const unread = await client.fetchHeaders('INBOX', { unreadOnly: true });
    assert.deepEqual(unread, []);
  });
});

test('IMAP：fetchMessage 不存在的 UID → protocol', async () => {
  await withServer({}, async (_server, client) => {
    await client.connect();
    await assert.rejects(
      () => client.fetchMessage('INBOX', 999),
      (error: unknown) => error instanceof MailError && error.code === 'protocol',
    );
  });
});

// ───────────────────────── search ─────────────────────────

test('IMAP：search 构造 UNSEEN/FROM/SUBJECT/SINCE 条件并返回 UID', async () => {
  await withServer({}, async (server, client) => {
    await client.connect();
    const uids = await client.search('INBOX', {
      unreadOnly: true,
      from: 'bob',
      subject: 'Unread',
      since: '2026-11-01',
    });
    assert.deepEqual(uids, [102]);
    const searchLine = server.requests.find((line) => /UID SEARCH/i.test(line));
    assert.ok(searchLine);
    assert.match(searchLine, /UNSEEN/);
    assert.match(searchLine, /FROM "bob"/);
    assert.match(searchLine, /SUBJECT "Unread"/);
    assert.match(searchLine, /SINCE 01-Nov-2026/);
  });
});

test('IMAP：search limit 只保留最新 N 个 UID（升序返回）', async () => {
  await withServer({}, async (_server, client) => {
    await client.connect();
    const uids = await client.search('INBOX', { text: 'example' }, 2);
    assert.deepEqual(uids, [102, 103]);
  });
});

test('IMAP：服务器不支持 SEARCH（BAD）→ protocol 且 message 不含原文', async () => {
  await withServer({ searchTaggedResponse: 'BAD' }, async (_server, client) => {
    await client.connect();
    await assert.rejects(
      () => client.search('INBOX', { text: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof MailError);
        assert.equal(error.code, 'protocol');
        assert.ok(!error.message.includes('not supported by fake server'));
        assert.ok((error.detail ?? '').includes('not supported by fake server'));
        return true;
      },
    );
  });
});

// ───────────────────────── 故障分类 ─────────────────────────

test('IMAP：LOGIN 被拒 → auth，hint 指向授权码，message 不含服务器原文', async () => {
  await withServer({ loginTaggedResponse: 'NO' }, async (_server, client) => {
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => {
        assert.ok(error instanceof MailError);
        assert.equal(error.code, 'auth');
        assert.match(error.hint ?? '', /授权码/);
        assert.ok(!error.message.includes('rejected by fake server'));
        assert.ok((error.detail ?? '').includes('rejected by fake server'));
        return true;
      },
    );
  });
});

test('IMAP：SELECT 被服务器 NO → protocol，message 不含服务器原文', async () => {
  await withServer({ selectTaggedResponse: 'NO' }, async (_server, client) => {
    await client.connect();
    await assert.rejects(
      () => client.select('INBOX'),
      (error: unknown) => {
        assert.ok(error instanceof MailError);
        assert.equal(error.code, 'protocol');
        assert.ok(!error.message.includes('SELECT rejected by fake server'));
        assert.ok((error.detail ?? '').includes('SELECT rejected by fake server'));
        return true;
      },
    );
  });
});

test('IMAP：命令超时 → timeout（timeoutMs 生效且快速返回）', async () => {
  await withServer({ hangOn: 'UID FETCH' }, async (_server, client) => {
    await client.connect();
    const startedAt = Date.now();
    await assert.rejects(
      () => client.fetchMessage('INBOX', 101),
      (error: unknown) => error instanceof MailError && error.code === 'timeout',
    );
    assert.ok(Date.now() - startedAt < 3000);
  });
});

test('IMAP：连接中途断开 → dropped', async () => {
  await withServer({ dropOn: 'UID FETCH' }, async (_server, client) => {
    await client.connect();
    await assert.rejects(
      () => client.fetchMessage('INBOX', 101),
      (error: unknown) => error instanceof MailError && error.code === 'dropped',
    );
  });
});

test('IMAP：断线后下一条命令会自动重连', async () => {
  await withServer({ dropOn: 'UID FETCH' }, async (_server, client) => {
    await client.connect();
    await assert.rejects(
      () => client.fetchMessage('INBOX', 101),
      (error: unknown) => error instanceof MailError && error.code === 'dropped',
    );
    const folders = await client.folders(); // 应重连 + 重新 LOGIN
    assert.ok(folders.includes('INBOX'));
  });
});

test('IMAP：连接被拒 → connect', async () => {
  const server = await startFakeImapServer();
  const port = server.port;
  await server.close();
  const client = createImapClient({
    host: '127.0.0.1',
    port,
    secure: false,
    allowPlaintext: true,
    user: 'tester@example.com',
    pass: 'demo-auth-code',
    timeoutMs: 500,
  });
  await assert.rejects(
    () => client.connect(),
    (error: unknown) => error instanceof MailError && error.code === 'connect',
  );
});

test('IMAP：secure:true 连明文服务器 → tls', async () => {
  const server = await startFakeImapServer();
  try {
    const client = createImapClient({
      host: server.host,
      port: server.port,
      secure: true,
      user: 'tester@example.com',
      pass: 'demo-auth-code',
      timeoutMs: 1200,
    });
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => error instanceof MailError && error.code === 'tls',
    );
  } finally {
    await server.close();
  }
});

test('IMAP：secure:false 但未允许明文 → tls（安全闸门）', async () => {
  const server = await startFakeImapServer();
  try {
    const client = createImapClient({
      host: server.host,
      port: server.port,
      secure: false,
      user: 'tester@example.com',
      pass: 'demo-auth-code',
      timeoutMs: 500,
    });
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => error instanceof MailError && error.code === 'tls',
    );
  } finally {
    await server.close();
  }
});

// ───────────────────────── continuation / logout ─────────────────────────

test('IMAP：服务器发 + continuation 时不挂死、命令继续完成', async () => {
  await withServer({ sendContinuationOn: 'UID FETCH' }, async (_server, client) => {
    await client.connect();
    const message = await client.fetchMessage('INBOX', 103);
    assert.equal(message.subject, 'HTML newsletter');
  });
});

test('IMAP：logout 幂等，重复调用不抛', async () => {
  await withServer({}, async (server, client) => {
    await client.connect();
    await client.logout();
    await assert.doesNotReject(() => client.logout());
    assert.ok(server.requests.some((line) => /LOGOUT/.test(line)));
  });
});
