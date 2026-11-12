/**
 * 按 mode 选 demo / live，暴露统一 Mailbox（PLAN §3.6）。
 *
 * 装配层无法拒绝构造（World 已挂载），所以这里绝不抛：
 * - mode==='demo'（默认）→ 内置演示邮箱，不联网、不需要凭据；
 * - mode==='live' 且配置齐全 → 真邮箱（IMAP 读 + SMTP 发，连接惰性建立）；
 * - mode==='live' 但缺邮箱地址/授权码 → **回退 demo**，并在 status().lastError 记一条 `no-config`：
 *   工具仍可用，回执会按「配置没填完」那一类提示去填。
 *
 * 凭据来源优先级（PLAN §3.6）：config.authCode > secret('QQ_MAIL_AUTH_CODE') > env QQ_MAIL_AUTH_CODE。
 * 凭据只进这里构造的 client，不写日志、不进回执、不回显。
 */
import type { MailConfigSection } from '../config.ts';
import { createDemoMailbox } from './demo.ts';
import { createLiveMailbox, type LiveMailboxExtras, type LiveMailboxOptions } from './live.ts';
import type { Mailbox, MailboxStatus, MailFailure } from './types.ts';

/** 授权码在宿主 secret 服务/环境变量里的名字（PLAN §3.6 / §4）。 */
export const AUTH_SECRET_NAME = 'QQ_MAIL_AUTH_CODE';
export const AUTH_ENV_NAME = 'QQ_MAIL_AUTH_CODE';

/** createMailbox 的选项。createDemo/createLive 是测试注入点，生产不传。 */
export interface CreateMailboxOptions {
  dataDir: string;
  secret?: (name: string) => string;
  clock?: () => Date;
  /** 测试注入：替换演示邮箱构造。 */
  createDemo?: (o: { dataDir: string; clock?: () => Date }) => Mailbox;
  /** 测试注入：替换真邮箱构造（要看解析出来的 authCode 时用）。 */
  createLive?: (o: LiveMailboxOptions) => Mailbox;
}

/** 与 definition.ts 的 looksLikeEmail 同义；不 import definition 以免 world→service→definition→world 循环。 */
function looksLikeMailAddress(value: unknown): boolean {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (text === '' || /\s/.test(text)) return false;
  const at = text.indexOf('@');
  if (at < 1 || at !== text.lastIndexOf('@')) return false;
  const domain = text.slice(at + 1);
  return domain !== '' && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/** 凭据优先级：配置 > ctx.secret > 环境变量。secret 抛错当作没有。 */
export function resolveAuthCode(
  authCode: unknown,
  secret?: (name: string) => string,
): string {
  const direct = String(authCode === null || authCode === undefined ? '' : authCode).trim();
  if (direct !== '') return direct;
  if (typeof secret === 'function') {
    try {
      const value = String(secret(AUTH_SECRET_NAME) ?? '').trim();
      if (value !== '') return value;
    } catch {
      // 宿主没配密钥服务：继续看环境变量
    }
  }
  const env = process.env[AUTH_ENV_NAME];
  return typeof env === 'string' ? env.trim() : '';
}

function portOf(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

/** 回退 demo 时把 no-config 挂在 status() 上；其余行为原样转发给 demo。 */
function demoWithFailure(demo: Mailbox, failure: MailFailure): Mailbox {
  const extras = demo as Mailbox & LiveMailboxExtras;
  const wrapped: Mailbox & LiveMailboxExtras = {
    mode: demo.mode,
    status: async (): Promise<MailboxStatus> => {
      const base = await demo.status();
      return { ...base, lastError: failure };
    },
    folders: () => demo.folders(),
    list: (options) => demo.list(options),
    read: (uid, options) => demo.read(uid, options),
    search: (options) => demo.search(options),
    send: (draft) => demo.send(draft),
    close: () => demo.close(),
  };
  // 可选能力原样透传：demo 现在没有，以后加也自动生效。
  if (typeof extras.markSeen === 'function') {
    wrapped.markSeen = (folder: string, uid: number) => extras.markSeen!(folder, uid);
  }
  if (typeof extras.selectInfo === 'function') {
    wrapped.selectInfo = (folder: string) => extras.selectInfo!(folder);
  }
  return wrapped;
}

/**
 * 按配置创建 Mailbox。永不抛：live 配置不全时回退 demo 并挂 no-config。
 */
export function createMailbox(config: MailConfigSection, options: CreateMailboxOptions): Mailbox {
  const cfg = (config ?? {}) as MailConfigSection;
  const dataDir = String(options.dataDir ?? '');
  const makeDemo = options.createDemo ?? createDemoMailbox;
  const makeLive = options.createLive ?? createLiveMailbox;
  const demo = (): Mailbox => makeDemo({ dataDir, clock: options.clock });

  if (cfg.mode !== 'live') return demo();

  const email = String(cfg.email ?? '').trim();
  const authCode = resolveAuthCode(cfg.authCode, options.secret);
  const missing: string[] = [];
  if (!looksLikeMailAddress(email)) missing.push('worlds.mail.email 不是有效邮箱地址');
  if (authCode === '') missing.push('worlds.mail.authCode 里没有 QQ 邮箱授权码（也没有 QQ_MAIL_AUTH_CODE）');
  if (missing.length > 0) {
    return demoWithFailure(demo(), {
      code: 'no-config',
      message: '实时邮箱模式（live）缺配置：' + missing.join('；') + '。',
      hint: '按配置项说明去填；只想先看看就把 worlds.mail.mode 改回 demo（demo 模式不需要凭据）。',
    });
  }

  return makeLive({
    email,
    authCode,
    imapHost: String(cfg.imapHost ?? '').trim() || 'imap.qq.com',
    imapPort: portOf(cfg.imapPort, 993),
    smtpHost: String(cfg.smtpHost ?? '').trim() || 'smtp.qq.com',
    smtpPort: portOf(cfg.smtpPort, 465),
    fromName: String(cfg.fromName ?? '').trim(),
  });
}
