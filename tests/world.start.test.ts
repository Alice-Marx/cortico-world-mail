/**
 * World 生命周期：start 永不抛错、ready / down 各投一次、demo 3 秒 / live 60 秒首轮、
 * intervalMinutes=0 不挂定时器、stop 清定时器并关闭服务。
 *
 * 全部离线：demo 用真的演示邮箱（不联网），live 用注入的假 Mailbox（绝不连 imap.qq.com）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MailError, type MailboxStatus } from '../src/mail/types.ts';
import { EVENT_SPECS } from '../src/definition.ts';
import { DEMO_ACCOUNT } from '../src/mail/demo.ts';
import {
  LIVE_FIRST_SCAN_DELAY_MS,
  DEMO_FIRST_SCAN_DELAY_MS,
  type MailboxStatus,
} from '../src/world.ts';
import { makeFakeMailbox, makeTimers, makeWorld, settled } from './world.support.ts';

test('demo 启动：投一条 mail.ready（internal），3 秒后收第一轮，7 个工具都在', async () => {
  const built = await makeWorld({ cfg: { mode: 'demo' } });
  try {
    await assert.doesNotReject(() => built.world.start(built.host.host), 'start 绝不向外抛');
    assert.equal(built.world.mounted, true);

    const ready = built.host.of('mail.ready');
    assert.equal(ready.length, 1, 'demo 载入即就绪，只投一条 ready');
    assert.equal(ready[0].origin, 'internal', 'ready 是 internal 事件');
    assert.equal(ready[0].deliver, true, 'ready 要进对话');
    assert.match(ready[0].text, /demo/i);
    assert.match(ready[0].text, /演示邮箱/);
    assert.match(ready[0].text, new RegExp(DEMO_ACCOUNT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'demo 事件里写演示账号');
    assert.equal(built.host.of('mail.down').length, 0, 'demo 不许投 down');

    assert.equal(built.world.tools().length, 7, 'PLAN 第 5 节的 7 个工具');
    assert.equal(built.timers.created.length, 1);
    assert.equal(built.timers.created[0].ms, DEMO_FIRST_SCAN_DELAY_MS, 'demo 3 秒后收第一轮');
    assert.equal(built.timers.created[0].ms, 3_000);

    // 拨一跳：收信跑完，下一次回到 intervalMinutes（默认 30 分钟）。
    built.timers.fire();
    await settled(built.timers);
    assert.equal(built.host.of('mail.scanned').length, 1, '拨一跳就收一轮');
    assert.equal(built.timers.live()[0].ms, 30 * 60_000, '稳定之后按 intervalMinutes');
    // 事件契约：实例只许发 definition.ts 声明的那 4 类事件
    const declared = new Set(EVENT_SPECS.map((one) => one.type));
    for (const event of built.host.events) {
      assert.ok(declared.has(event.type), '未在 EVENT_SPECS 里声明的事件类型：' + event.type);
    }
    assert.deepEqual([...declared].sort(), ['mail.down', 'mail.new', 'mail.ready', 'mail.scanned']);
  } finally {
    await built.cleanup();
  }
});

test('live 缺配置：回退 demo、投 mail.down、不抛、工具仍可用', async () => {
  const built = await makeWorld({ cfg: { mode: 'live', email: '', authCode: '' } });
  try {
    await assert.doesNotReject(() => built.world.start(built.host.host), '没凭据也不许抛');

    const down = built.host.of('mail.down');
    assert.equal(down.length, 1, '配置不全只投一条 down');
    assert.equal(down[0].origin, 'internal', 'down 是 internal 事件');
    assert.equal(down[0].deliver, true);
    assert.match(down[0].text, /配置没填完/, '失败类别要说清');
    assert.equal(built.host.of('mail.ready').length, 0, '配置不全不许报 ready');

    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.mode, 'demo', 'live 缺配置回退 demo（工具仍可用）');
    assert.equal(snapshot.lastError?.code, 'no-config', '状态里记 no-config 供回执提示');
    assert.equal(snapshot.account, DEMO_ACCOUNT);
    assert.deepEqual(snapshot.configFolders, ['INBOX']);

    assert.equal(built.world.tools().length, 7, '工具照样在');
    assert.equal(built.timers.created.length, 1);
    assert.equal(built.timers.created[0].ms, LIVE_FIRST_SCAN_DELAY_MS, 'live 模式首轮等 60 秒');
    assert.equal(built.timers.created[0].ms, 60_000);
  } finally {
    await built.cleanup();
  }
});

test('live 只填了邮箱没填授权码：同样 down，建议里点名去填授权码', async () => {
  const built = await makeWorld({ cfg: { mode: 'live', email: 'someone@example.com', authCode: '' } });
  try {
    await built.world.start(built.host.host);
    const down = built.host.of('mail.down');
    assert.equal(down.length, 1);
    assert.match(down[0].text, /配置没填完/);
  } finally {
    await built.cleanup();
  }
});

test('live 配置齐全：启动时不打服务器、不投 ready；第一轮收信成功后才补投 ready，下一跳回到 intervalMinutes', async () => {
  const fake = makeFakeMailbox({
    mode: 'live',
    account: 'someone@example.com',
    folders: ['INBOX'],
    mails: [
      { folder: 'INBOX', uid: 1, subject: '来自服务器的第一封', fromName: '服务器', text: '你好' },
    ],
    withSelectInfo: true,
  });
  const built = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: 'DEMO_AUTH_CODE_FOR_TEST', intervalMinutes: 15 },
    service: fake,
  });
  try {
    await built.world.start(built.host.host);
    assert.equal(built.host.of('mail.ready').length, 0, 'live 连接是惰性的：start 不打服务器');
    assert.equal(built.host.of('mail.down').length, 0, '配置齐全不是失败');
    assert.equal(built.timers.created.length, 1);
    assert.equal(built.timers.created[0].ms, LIVE_FIRST_SCAN_DELAY_MS);

    built.timers.fire();
    await settled(built.timers);
    assert.equal(fake.state.list.length, 1, '第一轮真的去读了');
    const ready = built.host.of('mail.ready');
    assert.equal(ready.length, 1, 'IMAP 读成功后才报就绪');
    assert.equal(ready[0].origin, 'internal');
    assert.match(ready[0].text, /live/);
    assert.ok(!ready[0].text.includes('someone@example.com'), 'internal 事件不写 live 邮箱地址');
    assert.equal(built.timers.live()[0].ms, 15 * 60_000, '之后按 intervalMinutes');
  } finally {
    await built.cleanup();
  }
});

test('intervalMinutes=0：一只定时器都不挂，nextScanAt=null', async () => {
  const built = await makeWorld({ cfg: { mode: 'demo', intervalMinutes: 0 } });
  try {
    await built.world.start(built.host.host);
    assert.equal(built.timers.created.length, 0, 'intervalMinutes=0 不许有定时器');
    assert.equal((await built.world.statusSnapshot()).nextScanAt, null);
    assert.equal(built.host.of('mail.ready').length, 1, 'ready 与定时器无关');
  } finally {
    await built.cleanup();
  }
});

test('stop：清掉定时器、close 恰好一次、重复 stop 不抛', async () => {
  const fake = makeFakeMailbox({ mode: 'demo' });
  const built = await makeWorld({ cfg: { mode: 'demo' }, mailbox: fake.mailbox });
  await built.world.start(built.host.host);
  assert.equal(built.timers.live().length, 1);
  await built.world.stop();
  assert.equal(built.timers.live().length, 0, 'stop 之后不许有残留 timer');
  assert.equal(fake.state.closed, 1, '服务只关一次');
  assert.equal(built.world.mounted, false);
  await assert.doesNotReject(() => built.world.stop(), '重复 stop 也不许抛');
  assert.equal(fake.state.closed, 1, '已经交出去的服务不重复 close');
  await built.cleanup();
});

test('start 绝不抛：宿主 pushEvent 抛错、服务 status 抛错都只是安静失败', async () => {
  const brokenHost = {
    ...makeFakeMailbox({ mode: 'demo' }),
  };
  // 1) 宿主不收事件
  const first = await makeWorld({ cfg: { mode: 'demo' } });
  await first.world.stop();
  const throwingHost = {
    ...first.host.host,
    pushEvent: async () => {
      throw new Error('宿主不收事件');
    },
  } as unknown as typeof first.host.host;
  try {
    await assert.doesNotReject(() => first.world.start(throwingHost), '事件投不出去也不许抛');
    assert.equal(first.timers.created.length, 1, '照样挂定时器');
    assert.ok(first.host.logs.length > 0, '失败只记日志');
  } finally {
    await first.cleanup();
  }
  assert.ok(brokenHost.state.closed === 0);

  // 2) 服务 status 抛错
  const exploding = {
    ...makeFakeMailbox({ mode: 'live' }).mailbox,
    status: async (): Promise<MailboxStatus> => {
      throw new MailError('connect', '连不上服务器（测试注入）', { detail: '服务器原文不该出现在事件里' });
    },
  };
  const second = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: 'DEMO_AUTH_CODE_FOR_TEST' },
    mailbox: exploding,
  });
  try {
    await assert.doesNotReject(() => second.world.start(second.host.host), 'status 抛错也不许冒泡');
    const down = second.host.of('mail.down');
    assert.equal(down.length, 1);
    assert.equal(down[0].origin, 'internal');
    assert.match(down[0].text, /连不上服务器/);
    assert.ok(!down[0].text.includes('服务器原文不该出现在事件里'), 'down 不许带服务器原文');
  } finally {
    await second.cleanup();
  }
});

test('定时器注入：假定时器不留在进程里，stop 之后拨跳也不会再扫', async () => {
  const timers = makeTimers();
  const built = await makeWorld({ cfg: { mode: 'demo', intervalMinutes: 10 }, timers });
  try {
    await built.world.start(built.host.host);
    const handle = built.timers.created[0];
    await built.world.stop();
    assert.equal(handle.cleared, true, 'stop 清掉挂着的那一只');
    const scannedBefore = built.host.of('mail.scanned').length;
    built.timers.fire(0);
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(built.host.of('mail.scanned').length, scannedBefore, 'stop 之后拨跳（已清）不应再收信');
  } finally {
    await built.cleanup();
  }
});

test('live 配置齐全但第一轮自动收信失败：投 mail.down（internal、无服务器原文），World 不消失、下一跳照排', async () => {
  const CANARY = '服务器原文不该进事件';
  const service = makeFakeMailbox({ mode: 'live', account: 'someone@example.com', connected: false });
  service.setError('list', new MailError('connect', '连不上 IMAP 服务器', { detail: CANARY }));
  const built = await makeWorld({
    cfg: { mode: 'live', email: 'someone@example.com', authCode: 'DEMO_AUTH_CODE_FOR_TEST', intervalMinutes: 15 },
    service,
  });
  try {
    await built.world.start(built.host.host);
    assert.equal(built.host.of('mail.down').length, 0, 'start 不连接，所以启动瞬间不投 down');
    built.timers.fire();
    await settled(built.timers);

    const down = built.host.of('mail.down');
    assert.equal(down.length, 1, '第一次自动收信失败要投一条 down');
    assert.equal(down[0].origin, 'internal');
    assert.match(down[0].text, /连不上服务器/);
    assert.ok(!down[0].text.includes(CANARY), 'down 不许带服务器原文');
    assert.equal(built.host.of('mail.scanned').length, 0, '一轮没成就不投 scanned');
    assert.equal(built.world.tools().length, 7, 'World 不消失、工具仍在');
    assert.equal(built.timers.live()[0].ms, 15 * 60_000, '失败也照常排下一跳');

    // 下一次成功：补投 ready，down 状态复位
    service.setError('list', undefined);
    built.timers.fire();
    await settled(built.timers);
    assert.equal(built.host.of('mail.ready').length, 1, '恢复后补投 ready');
    assert.equal(built.host.of('mail.scanned').length, 1);
  } finally {
    await built.cleanup();
  }
});