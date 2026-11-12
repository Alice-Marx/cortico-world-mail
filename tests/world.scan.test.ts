/**
 * 收信串起来的那条线：逐文件夹 list（增量游标）→ 新邮件写 vault → mail.scanned（internal）→
 * 有新邮件且 deliverDigest 时 mail.new（external，只含摘要）。
 *
 * 钉死两件安全事（PLAN 第 7、9 节）：
 * ① internal 事件里不许出现主题/发件人/正文；
 * ② mail.new 是 external，正文只来自 digest（发件人显示名/时间/主题/截断片段）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { MailError } from '../src/mail/types.ts';
import { CURSOR_FILE, MailWorld, type MailCursor } from '../src/world.ts';
import { createVault } from '../src/vault/vault.ts';
import { makeFakeMailbox, makeWorld, type SeedMail } from './world.support.ts';

const SUBJECT_A = '会议邀请-XYZ';
const SUBJECT_B = '账单通知-XYZ';
const SENDER_A = '王小明-XYZ';
const SENDER_B = '支付宝-XYZ';

function seeds(): SeedMail[] {
  return [
    {
      folder: 'INBOX',
      uid: 10,
      subject: SUBJECT_A,
      fromName: SENDER_A,
      date: '2026-11-08T02:00:00.000Z',
      snippet: '下周二下午三点开会',
      text: '下周二下午三点开会，地点在会议室 A。',
      seen: false,
    },
    {
      folder: 'INBOX',
      uid: 12,
      subject: SUBJECT_B,
      fromName: SENDER_B,
      date: '2026-11-09T06:30:00.000Z',
      snippet: '本月账单已出',
      text: '本月账单已出，请查看。',
      seen: true,
    },
    {
      folder: '已发送',
      uid: 3,
      subject: 'Re: 会议邀请-XYZ',
      fromName: '我',
      date: '2026-11-08T03:00:00.000Z',
      snippet: '收到，我会准时到',
      text: '收到，我会准时到。',
      seen: true,
    },
  ];
}

function fake(options: { mails?: SeedMail[]; uidValidity?: number; failFolder?: Record<string, Error> } = {}) {
  return makeFakeMailbox({
    mode: 'demo',
    folders: ['INBOX', '已发送'],
    mails: options.mails ?? seeds(),
    uidValidity: options.uidValidity ?? 7,
    withSelectInfo: true,
    ...(options.failFolder === undefined ? {} : { failFolder: options.failFolder }),
  });
}

async function readCursor(dir: string): Promise<MailCursor> {
  return JSON.parse(await readFile(join(dir, 'mail', CURSOR_FILE), 'utf8')) as MailCursor;
}

test('一轮收信：新邮件落库、事件各投一条、游标写 cursor.json', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX\n已发送', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan();

    assert.equal(outcome.perFolder.length, 2, '两个文件夹各读一轮');
    assert.equal(outcome.added.length, 3, '三封都是新的');
    assert.equal(outcome.perFolder[0].folder, 'INBOX');
    assert.equal(outcome.perFolder[0].fresh, 2);
    assert.equal(outcome.perFolder[0].total, 2, '总数来自 SELECT exists');
    assert.equal(outcome.perFolder[1].folder, '已发送');

    const vault = createVault(join(built.dir, 'mail'));
    const stats = await vault.stats();
    assert.equal(stats.items, 3, '三封真的落进了知识库');
    assert.deepEqual(stats.folders, { INBOX: 2, 已发送: 1 });

    const cursor = await readCursor(built.dir);
    assert.equal(cursor.folders.INBOX.uidValidity, 7, 'UIDVALIDITY 记下来');
    assert.equal(cursor.folders.INBOX.lastUid, 12, 'lastUid 取本轮最大 uid');
    assert.equal(cursor.folders['已发送'].lastUid, 3);
    assert.equal(cursor.folders.INBOX.lastSyncAt, outcome.at);

    const scanned = built.host.of('mail.scanned');
    assert.equal(scanned.length, 1, '一轮扫描记一条 scanned');
    assert.equal(scanned[0].origin, 'internal');
    assert.equal(scanned[0].deliver, false, 'scanned 只落库，不许吵醒对话');
    assert.match(scanned[0].text, /INBOX 新增 2 封/);
    assert.match(scanned[0].text, /已发送 新增 1 封/);

    const news = built.host.of('mail.new');
    assert.equal(news.length, 1, '有新增才投摘要，且只投一条');
    assert.equal(news[0].origin, 'external', '正文来自邮件：origin 必须是 external');
    assert.equal(news[0].deliver, true);
    assert.equal(news[0].trigger, 'debounce');
    assert.match(news[0].text, new RegExp(SENDER_A), '摘要带发件人显示名');
    assert.match(news[0].text, new RegExp(SUBJECT_A), '摘要带主题');
    assert.match(news[0].text, /下周二下午三点开会/, '摘要带正文片段');
    assert.ok(outcome.delivered);
  } finally {
    await built.cleanup();
  }
});

test('internal 事件是第三方内容的禁地：主题/发件人/正文一个字都不许出现', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX\n已发送', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    await built.world.scan();
    const forbidden = [SUBJECT_A, SUBJECT_B, SENDER_A, SENDER_B, '下周二下午三点', '本月账单已出'];
    for (const type of ['mail.ready', 'mail.scanned', 'mail.down']) {
      for (const text of built.host.texts(type)) {
        for (const needle of forbidden) {
          assert.ok(!text.includes(needle), type + ' 里混进了第三方内容「' + needle + '」：' + text);
        }
      }
    }
  } finally {
    await built.cleanup();
  }
});

test('再扫一轮：added=0、不投摘要、scanned 多一条、不重复入库', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX\n已发送', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    assert.equal((await built.world.scan()).added.length, 3);
    const second = await built.world.scan();
    assert.equal(second.added.length, 0, '同样的 uid 不该再进一次库');
    assert.equal(second.perFolder[0].fresh, 0, '增量：uid 不大于游标');
    assert.equal(built.host.of('mail.new').length, 1, '没新增就没有摘要事件');
    assert.equal(built.host.of('mail.scanned').length, 2);
    assert.equal((await createVault(join(built.dir, 'mail')).stats()).items, 3, '库没被撑大');
  } finally {
    await built.cleanup();
  }
});

test('新邮件：只增量读 uid 更大的，摘要只含新那一封', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX\n已发送', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    await built.world.scan();
    service.addMail({
      folder: 'INBOX',
      uid: 13,
      subject: '快递到了-XYZ',
      fromName: '京东物流-XYZ',
      date: '2026-11-10T01:00:00.000Z',
      snippet: '您的包裹已放至门卫处',
      text: '您的包裹已放至门卫处。',
    });
    const outcome = await built.world.scan();
    assert.equal(outcome.added.length, 1, '只认 uid 13 是新的');
    const news = built.host.of('mail.new');
    assert.equal(news.length, 2);
    assert.match(news[1].text, /快递到了-XYZ/);
    assert.ok(!news[1].text.includes(SUBJECT_A), '旧邮件不该出现在这一轮摘要里');
    const cursor = await readCursor(built.dir);
    assert.equal(cursor.folders.INBOX.lastUid, 13, '游标推进到最新 uid');
  } finally {
    await built.cleanup();
  }
});

test('deliverDigest=false：mail.new 照样落库留档但 deliver=false', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', deliverDigest: false }, service });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan();
    assert.equal(outcome.added.length, 2);
    const news = built.host.of('mail.new');
    assert.equal(news.length, 1);
    assert.equal(news[0].deliver, false, 'deliverDigest=off 时摘要不投递');
    assert.equal(outcome.delivered, false);
    assert.equal((await createVault(join(built.dir, 'mail')).stats()).items, 2, '内容照样落库');
  } finally {
    await built.cleanup();
  }
});

test('digestMaxChars 生效：摘要长度不超过配置值', async () => {
  const many: SeedMail[] = Array.from({ length: 30 }, (_, index) => ({
    folder: 'INBOX',
    uid: index + 1,
    subject: '第 ' + String(index + 1) + ' 封邮件，主题稍长一点点',
    fromName: '发件人' + String(index),
    date: '2026-11-0' + String((index % 9) + 1) + 'T00:00:00.000Z',
    snippet: '正文片段'.repeat(30),
  }));
  const service = makeFakeMailbox({ mode: 'demo', folders: ['INBOX'], mails: many, withSelectInfo: true });
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', digestMaxChars: 400 }, service });
  try {
    await built.world.start(built.host.host);
    await built.world.scan();
    const news = built.host.of('mail.new');
    assert.equal(news.length, 1);
    assert.ok(news[0].text.length <= 400, '摘要不得超过 digestMaxChars：' + String(news[0].text.length));
  } finally {
    await built.cleanup();
  }
});

test('UIDVALIDITY 变了：全量重扫（不拿旧 lastUid 去增量），已有邮件不重复入库', async () => {
  const dir = join(await makeFakeMailboxDir(), 'cursor-reset');
  const first = await makeWorld({
    cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 },
    service: fake(),
    dataDir: dir,
  });
  try {
    await first.world.start(first.host.host);
    assert.equal((await first.world.scan()).added.length, 2);
  } finally {
    await first.world.stop();
  }

  const second = await makeWorld({
    cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 },
    service: fake({ uidValidity: 99 }),
    dataDir: dir,
  });
  try {
    await second.world.start(second.host.host);
    const outcome = await second.world.scan();
    assert.equal(outcome.perFolder[0].fresh, 2, 'UIDVALIDITY 变了就全量重扫');
    assert.equal(outcome.added.length, 0, '但库里已有的不重复入库');
    const cursor = await readCursor(dir);
    assert.equal(cursor.folders.INBOX.uidValidity, 99, '游标换成新的 UIDVALIDITY');
  } finally {
    await second.world.stop();
    await first.cleanup();
  }
});

test('一个文件夹失败不拖垮另一个；全失败时才把错误抛给工具分类', async () => {
  const service = fake({ failFolder: { 已发送: new MailError('auth', 'IMAP 登录被拒', { detail: '服务器原文' }) } });
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX\n已发送', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan();
    assert.equal(outcome.perFolder.length, 1, '读得成的文件夹照读');
    assert.equal(outcome.failures.length, 1, '失败的文件夹单独记一条');
    assert.equal(outcome.failures[0].folder, '已发送');
    const scanned = built.host.of('mail.scanned');
    assert.match(scanned[0].text, /失败 1 个文件夹/);
    assert.ok(!scanned[0].text.includes('服务器原文'), 'internal 事件不许带服务器原文');
    assert.equal(built.host.of('mail.new').length, 1, '读成的那个文件夹还是照常投摘要');
  } finally {
    await built.cleanup();
  }
});

test('全部文件夹都失败：scan 抛 W1 的 MailError（原样），不投 scanned', async () => {
  const service = fake({ failFolder: { INBOX: new MailError('connect', '连不上 IMAP 服务器') } });
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    await assert.rejects(
      () => built.world.scan(),
      (error: { name?: string; code?: string }) => {
        assert.equal(error.name, 'MailError', 'W1 的 MailError 原样上抛');
        assert.equal(error.code, 'connect');
        return true;
      },
    );
    assert.equal(built.host.of('mail.scanned').length, 0, '一轮都没成就不投 scanned');
    assert.equal((await createVault(join(built.dir, 'mail')).stats()).items, 0);
  } finally {
    await built.cleanup();
  }
});

test('folders 配置为空：回落到 INBOX，不静默什么都不读', async () => {
  const service = fake();
  const built = await makeWorld({ cfg: { mode: 'demo', folders: '', intervalMinutes: 0 }, service });
  try {
    await built.world.start(built.host.host);
    assert.deepEqual(built.world.configuredFolders, ['INBOX']);
    const outcome = await built.world.scan();
    assert.equal(outcome.perFolder.length, 1);
    assert.equal(service.state.list[0].folder, 'INBOX');
  } finally {
    await built.cleanup();
  }
});

test('游标坏文件：另存为 .bad-*，不静默清零也不炸', async () => {
  const dir = join(await makeFakeMailboxDir(), 'bad-cursor');
  const built = await makeWorld({ cfg: { mode: 'demo', folders: 'INBOX', intervalMinutes: 0 }, service: fake(), dataDir: dir });
  try {
    const { mkdir, writeFile, readdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'mail'), { recursive: true });
    await writeFile(join(dir, 'mail', CURSOR_FILE), '{ 这不是 JSON', 'utf8');
    await built.world.start(built.host.host);
    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.lastScanAt, null);
    const files = await readdir(join(dir, 'mail'));
    assert.ok(files.some((one) => one.startsWith(CURSOR_FILE + '.bad-')), '坏游标要留底：' + files.join(','));
    const outcome = await built.world.scan();
    assert.ok(outcome.perFolder.length === 1, '坏游标当作第一次，照常收信');
  } finally {
    await built.world.stop();
    await built.cleanup();
  }
});

/** 在系统临时目录下造一个父目录（dataDir 复用场景）。 */
async function makeFakeMailboxDir(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  return mkdtemp(join(tmpdir(), 'cortico-mail-scan-'));
}

// 让测试显式引用 MailWorld 类型（避免只 import type 被擦掉后 lint 抱怨）。
export type { MailWorld };
