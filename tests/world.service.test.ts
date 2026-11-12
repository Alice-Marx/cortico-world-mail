/**
 * service 选型与凭据来源（PLAN §3.6）：mode 决定 demo/live、live 缺配置回退 demo 并记 no-config、
 * 授权码优先级 config.authCode > secret('QQ_MAIL_AUTH_CODE') > env QQ_MAIL_AUTH_CODE。
 *
 * 全部离线：live 的构造用注入的 createLive 观察参数，绝不真的连 imap.qq.com。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MAIL_DEFAULTS, type MailConfigSection } from '../src/config.ts';
import { DEMO_ACCOUNT } from '../src/mail/demo.ts';
import { createMailbox, resolveAuthCode, AUTH_ENV_NAME, AUTH_SECRET_NAME } from '../src/mail/service.ts';
import type { LiveMailboxOptions } from '../src/mail/live.ts';
import type { Mailbox } from '../src/mail/types.ts';
import { makeFakeMailbox } from './world.support.ts';

function cfg(over: Partial<MailConfigSection> = {}): MailConfigSection {
  return { ...MAIL_DEFAULTS, ...over };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cortico-mail-service-'));
}

test('demo 模式：返回演示邮箱，账号是 demo@coopanion.local', async () => {
  const dir = await tempDir();
  try {
    const box = createMailbox(cfg({ mode: 'demo' }), { dataDir: dir });
    assert.equal(box.mode, 'demo');
    const status = await box.status();
    assert.equal(status.mode, 'demo');
    assert.equal(status.account, DEMO_ACCOUNT);
    assert.equal(status.lastError, undefined);
    await box.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('live 缺配置：回退 demo，并在 status().lastError 记 no-config', async () => {
  const dir = await tempDir();
  try {
    for (const broken of [
      cfg({ mode: 'live', email: '', authCode: '' }),
      cfg({ mode: 'live', email: '不是邮箱', authCode: '' }),
      cfg({ mode: 'live', email: 'someone@example.com', authCode: '' }),
    ]) {
      const box = createMailbox(broken, { dataDir: dir });
      assert.equal(box.mode, 'demo', 'live 配置不全要回退 demo：' + JSON.stringify(broken.email));
      const status = await box.status();
      assert.equal(status.lastError?.code, 'no-config');
      assert.ok(String(status.lastError?.message).length > 0);
      // 回退之后工具仍可用：list 能读到演示邮件
      const headers = await box.list({ folder: 'INBOX', limit: 5 });
      assert.ok(headers.length > 0, '回退 demo 后 list 仍然可用');
      await box.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('live 配置齐全：走 createLive，主机/端口/显示名按配置传下去', async () => {
  const dir = await tempDir();
  const seen: LiveMailboxOptions[] = [];
  try {
    const box = createMailbox(
      cfg({
        mode: 'live',
        email: 'someone@example.com',
        authCode: 'DEMO_AUTH_CODE_CFG',
        fromName: '大肥鱼',
        imapHost: 'imap.example.com',
        imapPort: 1993,
        smtpHost: 'smtp.example.com',
        smtpPort: 1465,
      }),
      {
        dataDir: dir,
        createLive: (options) => {
          seen.push(options);
          return makeFakeMailbox({ mode: 'live', account: options.email }).mailbox;
        },
      },
    );
    assert.equal(box.mode, 'live');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].email, 'someone@example.com');
    assert.equal(seen[0].authCode, 'DEMO_AUTH_CODE_CFG');
    assert.equal(seen[0].fromName, '大肥鱼');
    assert.equal(seen[0].imapHost, 'imap.example.com');
    assert.equal(seen[0].imapPort, 1993);
    assert.equal(seen[0].smtpHost, 'smtp.example.com');
    assert.equal(seen[0].smtpPort, 1465);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('授权码优先级：config.authCode > secret > 环境变量', async () => {
  const dir = await tempDir();
  const previous = process.env[AUTH_ENV_NAME];
  process.env[AUTH_ENV_NAME] = 'DEMO_AUTH_CODE_ENV';
  const captured: string[] = [];
  const build = (over: Partial<MailConfigSection>, secret?: (name: string) => string): Mailbox => {
    const box = createMailbox(cfg({ mode: 'live', email: 'someone@example.com', ...over }), {
      dataDir: dir,
      ...(secret === undefined ? {} : { secret }),
      createLive: (options) => {
        captured.push(options.authCode);
        return makeFakeMailbox({ mode: 'live', account: options.email }).mailbox;
      },
    });
    void box.close();
    return box;
  };
  try {
    build({ authCode: 'DEMO_AUTH_CODE_CFG' }, (name) => (name === AUTH_SECRET_NAME ? 'DEMO_AUTH_CODE_SECRET' : ''));
    build({ authCode: '' }, (name) => (name === AUTH_SECRET_NAME ? 'DEMO_AUTH_CODE_SECRET' : ''));
    build({ authCode: '' }, () => '');
    build({ authCode: '' });
    assert.deepEqual(captured, [
      'DEMO_AUTH_CODE_CFG',
      'DEMO_AUTH_CODE_SECRET',
      'DEMO_AUTH_CODE_ENV',
      'DEMO_AUTH_CODE_ENV',
    ]);

    // secret 抛错当作没有：不能把整个构造炸掉
    assert.equal(resolveAuthCode('', () => {
      throw new Error('宿主没有密钥服务');
    }), 'DEMO_AUTH_CODE_ENV');
    assert.equal(resolveAuthCode('  ', undefined), 'DEMO_AUTH_CODE_ENV');
  } finally {
    if (previous === undefined) delete process.env[AUTH_ENV_NAME];
    else process.env[AUTH_ENV_NAME] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('live 配置齐全时不再看环境变量：secret 优先于 env', () => {
  const previous = process.env[AUTH_ENV_NAME];
  process.env[AUTH_ENV_NAME] = 'DEMO_AUTH_CODE_ENV';
  try {
    assert.equal(resolveAuthCode('', () => 'DEMO_AUTH_CODE_SECRET'), 'DEMO_AUTH_CODE_SECRET');
    assert.equal(resolveAuthCode('DEMO_AUTH_CODE_CFG', () => 'DEMO_AUTH_CODE_SECRET'), 'DEMO_AUTH_CODE_CFG');
  } finally {
    if (previous === undefined) delete process.env[AUTH_ENV_NAME];
    else process.env[AUTH_ENV_NAME] = previous;
  }
});
