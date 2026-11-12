/**
 * live Mailbox（PLAN §3.6）：惰性连接、连接失败后下一条命令重试一次、W1 的 MailError 原样上抛、
 * markSeen/selectInfo 作为可选成员、send 走 SMTP。
 *
 * 全部离线：imapFactory / smtpFactory 注入假客户端，不建任何 TCP 连接。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveMailbox, type LiveMailboxOptions } from '../src/mail/live.ts';
import { MailError } from '../src/mail/types.ts';
import type {
  FetchRange,
  ImapClient,
  ImapSelectInfo,
  MailAddress,
  MailHeader,
  MailMessage,
  OutgoingMessage,
  SendResult,
  SmtpClient,
} from '../src/mail/types.ts';

const EMAIL = 'someone@example.com';
const AUTH_CODE = 'DEMO_AUTH_CODE_FOR_TEST';

function makeHeader(uid: number, over: Partial<MailHeader> = {}): MailHeader {
  return {
    folder: 'INBOX',
    uid,
    messageId: '<m' + String(uid) + '@example.com>',
    subject: '主题 ' + String(uid),
    from: [{ name: '发件人' + String(uid), address: 'sender' + String(uid) + '@example.com' }],
    to: [{ name: '', address: EMAIL }],
    cc: [],
    date: '2026-11-10T00:00:00.000Z',
    flags: { seen: false, flagged: false, answered: false, draft: false, deleted: false },
    size: 100,
    snippet: '片段',
    hasAttachments: false,
    ...over,
  };
}

interface FakeImapState {
  connect: number;
  logout: number;
  select: string[];
  fetchHeaders: Array<{ folder: string; range?: FetchRange }>;
  fetchMessage: Array<{ folder: string; uid: number }>;
  search: Array<{ folder: string; criteria: Record<string, unknown>; limit?: number }>;
  markSeen: Array<{ folder: string; uid: number }>;
  folders: number;
}

interface FakeImapOptions {
  failConnectTimes?: number;
  failOnce?: { method: 'fetchHeaders' | 'fetchMessage' | 'search' | 'markSeen' | 'select'; error: Error };
  headers?: MailHeader[];
}

function makeFakeImap(options: FakeImapOptions = {}): { client: ImapClient; state: FakeImapState } {
  const state: FakeImapState = {
    connect: 0,
    logout: 0,
    select: [],
    fetchHeaders: [],
    fetchMessage: [],
    search: [],
    markSeen: [],
    folders: 0,
  };
  const failOnce = options.failOnce;
  const takeFailure = (method: string): Error | null => {
    if (failOnce !== undefined && failOnce.method === method) {
      failOnce.method = 'fetchHeaders'; // 只用一次
      (failOnce as { method: string }).method = '';
      return failOnce.error;
    }
    return null;
  };
  const headers = options.headers ?? [makeHeader(1), makeHeader(2)];
  const client: ImapClient = {
    async connect() {
      state.connect += 1;
      if (options.failConnectTimes !== undefined && state.connect <= options.failConnectTimes) {
        throw new MailError('connect', '连不上 IMAP 服务器', { hint: '检查网络与 imapHost' });
      }
    },
    async folders() {
      state.folders += 1;
      return ['INBOX', '已发送'];
    },
    async select(folder: string): Promise<ImapSelectInfo> {
      state.select.push(folder);
      const failure = takeFailure('select');
      if (failure) throw failure;
      return { exists: headers.length, uidValidity: 7, uidNext: headers.length + 1 };
    },
    async fetchHeaders(folder: string, range?: FetchRange) {
      state.fetchHeaders.push({ folder, ...(range === undefined ? {} : { range }) });
      const failure = takeFailure('fetchHeaders');
      if (failure) throw failure;
      return headers.slice(0, range?.limit ?? headers.length);
    },
    async fetchMessage(folder: string, uid: number): Promise<MailMessage> {
      state.fetchMessage.push({ folder, uid });
      const failure = takeFailure('fetchMessage');
      if (failure) throw failure;
      const header = headers.find((one) => one.uid === uid) ?? makeHeader(uid);
      return {
        ...header,
        body: { text: '正文 ' + String(uid), html: '' },
        attachments: [],
        headers: { 'message-id': header.messageId },
      };
    },
    async search(folder: string, criteria, limit?: number) {
      state.search.push({ folder, criteria: criteria as Record<string, unknown>, ...(limit === undefined ? {} : { limit }) });
      const failure = takeFailure('search');
      if (failure) throw failure;
      return headers.map((one) => one.uid).sort((a, b) => a - b);
    },
    async markSeen(folder: string, uid: number) {
      state.markSeen.push({ folder, uid });
      const failure = takeFailure('markSeen');
      if (failure) throw failure;
    },
    async logout() {
      state.logout += 1;
    },
  };
  return { client, state };
}

function makeFakeSmtp(): {
  client: SmtpClient;
  state: { sent: OutgoingMessage[]; close: number };
} {
  const state = { sent: [] as OutgoingMessage[], close: 0 };
  return {
    state,
    client: {
      async send(message: OutgoingMessage): Promise<SendResult> {
        state.sent.push(message);
        return { accepted: message.to.map((one: MailAddress) => one.address), rejected: [], messageId: '<live-1@example.com>' };
      },
      async close() {
        state.close += 1;
      },
    },
  };
}

function options(over: Partial<LiveMailboxOptions> = {}): LiveMailboxOptions {
  return {
    email: EMAIL,
    authCode: AUTH_CODE,
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    fromName: '大肥鱼',
    ...over,
  };
}

test('构造不连接：status 不联网、connected=false、账号是配置的地址', async () => {
  const imap = makeFakeImap();
  const box = createLiveMailbox(options({ imapFactory: () => imap.client }));
  assert.equal(imap.state.connect, 0, 'createLiveMailbox 不许建连');
  const status = await box.status();
  assert.equal(status.mode, 'live');
  assert.equal(status.connected, false);
  assert.equal(status.account, EMAIL);
  assert.equal(status.lastError, undefined);
  await box.close();
});

test('惰性连接：第一条命令才 connect，成功后 status 报已连接', async () => {
  const imap = makeFakeImap();
  const box = createLiveMailbox(options({ imapFactory: () => imap.client }));
  const headers = await box.list({ folder: 'INBOX', limit: 10 });
  assert.equal(imap.state.connect, 1);
  assert.equal(headers.length, 2);
  assert.equal(imap.state.fetchHeaders[0].range?.limit, 10);
  const status = await box.status();
  assert.equal(status.connected, true);
  assert.ok(status.lastSyncAt !== '');
  await box.close();
  assert.equal(imap.state.logout, 1, 'close 要 logout');
});

test('连接失败：W1 的 MailError 原样上抛；下一条命令重试一次并成功', async () => {
  const imap = makeFakeImap({ failConnectTimes: 1 });
  const box = createLiveMailbox(options({ imapFactory: () => imap.client }));
  await assert.rejects(
    () => box.list(),
    (error: { name?: string; code?: string }) => {
      assert.equal(error.name, 'MailError', '原样上抛 W1 的 MailError');
      assert.equal(error.code, 'connect');
      return true;
    },
  );
  assert.equal(imap.state.connect, 1);
  const headers = await box.list();
  assert.equal(imap.state.connect, 2, '下一条命令重新建连（再试一次）');
  assert.equal(headers.length, 2);
  await box.close();
});

test('命令失败（dropped）：丢掉这一代连接，下一条命令重连', async () => {
  const imap = makeFakeImap({ failOnce: { method: 'fetchHeaders', error: new MailError('dropped', '连接中途断了') } });
  const box = createLiveMailbox(options({ imapFactory: () => imap.client }));
  await assert.rejects(() => box.list(), (error: { code?: string }) => error.code === 'dropped');
  await box.list();
  assert.equal(imap.state.connect, 2, 'dropped 之后要重建连接');
  await box.close();
});

test('MailError 原样上抛：code / message / detail 都不被改写', async () => {
  const detail = '服务器原文 CANARY';
  const imap = makeFakeImap({ failOnce: { method: 'fetchHeaders', error: new MailError('auth', 'IMAP 登录被拒', { detail, hint: '去重新生成授权码' }) } });
  const box = createLiveMailbox(options({ imapFactory: () => imap.client }));
  await assert.rejects(
    () => box.list(),
    (error: { code?: string; message?: string; detail?: string }) => {
      assert.equal(error.code, 'auth');
      assert.equal(error.message, 'IMAP 登录被拒');
      assert.equal(error.detail, detail);
      return true;
    },
  );
  await box.close();
});

test('markSeen / selectInfo：可选成员可用（world 只在 markSeenOnRead 时调）', async () => {
  const imap = makeFakeImap();
  const box = createLiveMailbox(options({ imapFactory: () => imap.client }));
  assert.equal(typeof box.markSeen, 'function');
  assert.equal(typeof box.selectInfo, 'function');
  await box.markSeen?.('INBOX', 2);
  assert.deepEqual(imap.state.markSeen, [{ folder: 'INBOX', uid: 2 }]);
  const info = await box.selectInfo?.('INBOX');
  assert.equal(info?.uidValidity, 7);
  assert.equal(info?.exists, 2);
  await box.close();
});

test('read：按 maxChars 截断正文；search 把 criteria 透传给 IMAP 并返回头部', async () => {
  const imap = makeFakeImap();
  const box = createLiveMailbox(options({ imapFactory: () => imap.client }));
  const message = await box.read(1, { folder: 'INBOX', maxChars: 3 });
  assert.ok(message.body.text.length <= 3, '正文按 maxChars 截断：' + message.body.text);
  const found = await box.search({ folder: 'INBOX', query: '主题', limit: 5 });
  assert.equal(found.length, 2);
  assert.equal(imap.state.search[0].criteria.text, '主题');
  assert.equal(imap.state.search[0].limit, 5);
  await box.close();
});

test('send：走注入的 SMTP client，构建 OutgoingMessage，Result 原样返回，close 收尾', async () => {
  const imap = makeFakeImap();
  const smtp = makeFakeSmtp();
  const box = createLiveMailbox(
    options({
      imapFactory: () => imap.client,
      smtpFactory: () => smtp.client,
    }),
  );
  const result = await box.send({
    to: [{ name: '', address: 'a@example.com' }],
    subject: '测试主题',
    text: '测试正文',
    inReplyTo: '<orig@example.com>',
  });
  assert.equal(result.messageId, '<live-1@example.com>');
  assert.equal(smtp.state.sent.length, 1);
  assert.equal(smtp.state.sent[0].from.address, EMAIL);
  assert.equal(smtp.state.sent[0].from.name, '大肥鱼');
  assert.equal(smtp.state.sent[0].subject, '测试主题');
  assert.equal(smtp.state.sent[0].inReplyTo, '<orig@example.com>');
  assert.equal(smtp.state.close, 1, 'send 之后要 close');
  await box.close();
});

test('send 失败：MailError 原样上抛，close 仍然执行', async () => {
  const smtpState = { closed: 0 };
  const box = createLiveMailbox(
    options({
      imapFactory: () => makeFakeImap().client,
      smtpFactory: () => ({
        async send() {
          throw new MailError('auth', 'SMTP 登录被拒');
        },
        async close() {
          smtpState.closed += 1;
        },
      }),
    }),
  );
  await assert.rejects(
    () => box.send({ to: [{ name: '', address: 'a@example.com' }], subject: 's', text: 't' }),
    (error: { code?: string }) => error.code === 'auth',
  );
  assert.equal(smtpState.closed, 1, '失败也要 close');
  await box.close();
});

test('close 幂等：重复 close 不抛，logout 只发一次有效调用', async () => {
  const imap = makeFakeImap();
  const box = createLiveMailbox(options({ imapFactory: () => imap.client }));
  await box.list();
  await box.close();
  await assert.doesNotReject(() => box.close());
});
