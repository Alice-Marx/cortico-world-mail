/**
 * 邮件知识库（PLAN 第 8 节）：落盘 / 去重 / 检索 / 最近 / 统计 / 人读镜像。
 *
 * 全部离线：只碰 mkdtemp 出来的临时目录，不联网、不依赖 W1/W2 的文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { INDEX_FILE, NOTES_FILE, createVault } from '../src/vault/vault.ts';
import { mailId, type StoredMail } from '../src/vault/types.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cortico-mail-vault-'));
}

function mail(over: Partial<StoredMail> = {}): StoredMail {
  const folder = over.folder ?? 'INBOX';
  const uid = over.uid ?? 1;
  return {
    id: over.id ?? mailId(folder, uid),
    folder,
    uid,
    subject: over.subject ?? '会议邀请',
    from: over.from ?? '王小明',
    date: over.date ?? '2026-11-01T08:00:00Z',
    snippet: over.snippet ?? '下周二下午三点开会',
    learnedAt: over.learnedAt ?? '2026-11-01T08:00:05.000Z',
    mode: over.mode ?? 'demo',
    ...(over.text === undefined ? {} : { text: over.text }),
  };
}

test('put / stats：三条落盘，文件夹计数、字节数、最后学习时间都对', async () => {
  const dir = await tempDir();
  try {
    const vault = createVault(dir);
    const result = await vault.put([
      mail({ uid: 1, learnedAt: '2026-11-01T08:00:00.000Z' }),
      mail({ uid: 2, folder: '已发送', learnedAt: '2026-11-02T08:00:00.000Z' }),
      mail({ uid: 3, learnedAt: '2026-11-03T08:00:00.000Z' }),
    ]);
    assert.deepEqual(result, { added: 3, skipped: 0 });

    const stats = await vault.stats();
    assert.equal(stats.items, 3);
    assert.deepEqual(stats.folders, { INBOX: 2, 已发送: 1 });
    assert.equal(stats.lastLearnedAt, '2026-11-03T08:00:00.000Z');
    assert.ok(stats.bytes > 0);

    const raw = await readFile(join(dir, INDEX_FILE), 'utf8');
    assert.equal(raw.trim().split(/\r?\n/).length, 3, 'mail.jsonl 一行一条');
    const notes = await readFile(join(dir, NOTES_FILE), 'utf8');
    assert.match(notes, /邮件知识库/);
    assert.match(notes, /会议邀请/, '人读镜像里要有主题');
    assert.match(notes, /INBOX/, '按文件夹分组');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('has / mailId：id 规则是 "<folder>#<uid>"，没有的 id 回 false', async () => {
  const dir = await tempDir();
  try {
    const vault = createVault(dir);
    await vault.put([mail({ folder: 'INBOX', uid: 7 })]);
    assert.equal(mailId('INBOX', 7), 'INBOX#7');
    assert.equal(await vault.has('INBOX#7'), true);
    assert.equal(await vault.has('INBOX#8'), false);
    assert.equal(await vault.has('已发送#7'), false);
    assert.equal(await vault.has(''), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('去重：同一封再 put 一次不入库，skipped 照实计数', async () => {
  const dir = await tempDir();
  try {
    const vault = createVault(dir);
    const items = [mail({ uid: 1 }), mail({ uid: 2 }), mail({ uid: 3 })];
    assert.deepEqual(await vault.put(items), { added: 3, skipped: 0 });
    assert.deepEqual(await vault.put(items), { added: 0, skipped: 3 });
    // 同一批里重复也只进一条
    assert.deepEqual(await vault.put([mail({ uid: 4 }), mail({ uid: 4 })]), { added: 1, skipped: 1 });
    assert.equal((await vault.stats()).items, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('持久化：换一个实例重新加载，条目、正文、统计都还在', async () => {
  const dir = await tempDir();
  try {
    const first = createVault(dir);
    await first.put([mail({ uid: 1, text: '正文在这里' })]);
    const again = createVault(dir);
    assert.equal(await again.has('INBOX#1'), true, '重启后仍认得这封');
    const stats = await again.stats();
    assert.equal(stats.items, 1);
    const recent = await again.recent();
    assert.equal(recent[0].text, '正文在这里', '正文也落了盘');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('检索：大小写不敏感的多关键词 AND，命中主题/发件人/正文；按 learnedAt 新→旧', async () => {
  const dir = await tempDir();
  try {
    const vault = createVault(dir);
    await vault.put([
      mail({ uid: 1, subject: 'Quarterly Report', from: 'Alice <alice@example.com>', learnedAt: '2026-11-01T00:00:00.000Z' }),
      mail({ uid: 2, subject: '会议纪要', from: '王小明', snippet: '讨论了 QUARTERLY 目标', learnedAt: '2026-11-03T00:00:00.000Z' }),
      mail({
        uid: 3,
        subject: '别的邮件',
        from: 'bob@example.net',
        snippet: '无关内容',
        text: '这里提到 quarterly 计划和预算',
        learnedAt: '2026-11-02T00:00:00.000Z',
      }),
    ]);
    const hits = await vault.search('quarterly');
    assert.deepEqual(hits.map((one) => one.uid), [2, 3, 1], '命中三封：按 learnedAt 新→旧，不看命中字段');

    const and = await vault.search('quarterly 预算');
    assert.deepEqual(and.map((one) => one.uid), [3], '多关键词是 AND');

    const bySender = await vault.search('王小明');
    assert.deepEqual(bySender.map((one) => one.uid), [2]);

    assert.deepEqual(await vault.search('不存在的词'), []);
    assert.equal((await vault.search('quarterly', { limit: 1 })).length, 1, 'limit 生效');
    assert.deepEqual((await vault.search('  ')).map((one) => one.uid), [2, 3, 1], '空查询按最近返回');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recent：按 learnedAt 从新到旧，带 limit', async () => {
  const dir = await tempDir();
  try {
    const vault = createVault(dir);
    await vault.put([
      mail({ uid: 1, learnedAt: '2026-11-01T00:00:00.000Z' }),
      mail({ uid: 2, learnedAt: '2026-11-03T00:00:00.000Z' }),
      mail({ uid: 3, learnedAt: '2026-11-02T00:00:00.000Z' }),
    ]);
    assert.deepEqual((await vault.recent()).map((one) => one.uid), [2, 3, 1]);
    assert.deepEqual((await vault.recent(2)).map((one) => one.uid), [2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('坏行不拖垮整个库：JSONL 里的半截行跳过，合法行照读', async () => {
  const dir = await tempDir();
  try {
    const vault = createVault(dir);
    await vault.put([mail({ uid: 1 })]);
    const good = await readFile(join(dir, INDEX_FILE), 'utf8');
    await writeFile(join(dir, INDEX_FILE), '{ 这不是 JSON\n' + good + '{"id":"","folder":""}\n');
    const again = createVault(dir);
    assert.equal((await again.stats()).items, 1);
    assert.equal(await again.has('INBOX#1'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('入库前清洗：控制字符/换行压成单行；folder 或 uid 不合法直接抛', async () => {
  const dir = await tempDir();
  try {
    const vault = createVault(dir);
    await vault.put([mail({ uid: 1, subject: '第一行\n第二行\u2028伪造', from: 'A\r\nB' })]);
    const [stored] = await vault.recent();
    assert.ok(!stored.subject.includes('\n') && !stored.subject.includes('\u2028'), '主题必须是一行');
    assert.match(stored.subject, /第一行 第二行 伪造/);
    assert.ok(!stored.from.includes('\r') && !stored.from.includes('\n'));

    await assert.rejects(() => vault.put([mail({ folder: '' })]), /folder/);
    await assert.rejects(() => vault.put([mail({ uid: -1 })]), /uid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('不留下 *.tmp：原子写收尾干净', async () => {
  const dir = await tempDir();
  try {
    const vault = createVault(dir);
    await vault.put([mail({ uid: 1 })]);
    const files = await readdir(dir);
    assert.ok(files.includes(INDEX_FILE));
    assert.ok(files.includes(NOTES_FILE));
    assert.deepEqual(files.filter((one) => one.endsWith('.tmp')), [], '临时文件必须清干净：' + files.join(','));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('目录不存在时照常工作（put 自己建目录）', async () => {
  const root = await tempDir();
  try {
    const dir = join(root, 'nested', 'mail');
    const vault = createVault(dir);
    assert.deepEqual(await vault.put([mail({ uid: 1 })]), { added: 1, skipped: 0 });
    assert.equal((await vault.stats()).items, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
