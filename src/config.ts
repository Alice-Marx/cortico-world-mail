/**
 * worlds.mail 的默认值与设置界面声明。
 *
 * 契约（框架 extensions/dry-mount.ts:47-63）：ConfigGroup 的每个键必须落在 worlds.<id>.
 * 段内，且 defaults() 里有同名项——否则 WebUI 能改、能写进 config.json，代码却读自己那处兜底值。
 *
 * enabled 不在这里声明：它是装配层给所有 World 通用渲染的开关，重复声明等于多一个开关。
 * defaults() 里仍然必须有它，且必须是 false（dry-mount.ts:141-143）。
 *
 * 凭据只有一处：authCode 默认空串，文档与测试都不得出现任何真实授权码（PLAN 第 9 节）。
 * 本文件对框架只 import type，运行时零依赖。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { strings } from './i18n.ts';

/** World id。定义、实例、事件名与配置段前缀都从它派生。 */
export const WORLD_ID = 'mail';

/** 本 World 配置段的点分前缀。 */
export const CONFIG_PREFIX = 'worlds.' + WORLD_ID + '.';

/** 配置组 id 与 owner：框架要求 owner 恰好是 world:<id>（dry-mount.ts:216）。 */
export const CONFIG_ID = 'world:' + WORLD_ID;
export const CONFIG_OWNER = 'world:' + WORLD_ID;

/** 两种模式：demo＝内置演示邮箱（不联网、无凭据）；live＝连真实邮箱。 */
export const MAIL_MODES = ['demo', 'live'] as const;

/** config.json 里的 worlds.mail 段（PLAN 第 4 节的 17 项）。 */
export interface MailConfigSection {
  /** 装配层按它决定挂载；默认必须 false。 */
  enabled: boolean;
  /** demo＝内置演示邮箱；live＝连真实邮箱。MailMode 的权威定义在 src/mail/types.ts。 */
  mode: 'demo' | 'live';
  /** QQ 邮箱地址；demo 模式可空。 */
  email: string;
  /** QQ 邮箱授权码（不是登录密码）；也可放 .env 的 QQ_MAIL_AUTH_CODE。 */
  authCode: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** 发件显示名；空＝用邮箱地址。 */
  fromName: string;
  /** 多行文本，每行一个文件夹；# 开头是注释。 */
  folders: string;
  /** 自动收信间隔；0＝只由工具触发。 */
  intervalMinutes: number;
  /** 每轮每文件夹最多取几封。 */
  limitPerFetch: number;
  /** 知识库落在 dataDir 下的子目录名。 */
  vaultSubdir: string;
  /** 新邮件摘要是否投进对话（external 事件）。 */
  deliverDigest: boolean;
  /** 摘要字数上限。 */
  digestMaxChars: number;
  /** 读正文时是否把服务器上的邮件标记为已读。 */
  markSeenOnRead: boolean;
  /** 单封正文进入回执的字数上限。 */
  maxBodyChars: number;
}

/** 默认配置（PLAN 第 4 节，17 项逐字照抄）。defaults() 每次返回它的深拷贝。 */
export const MAIL_DEFAULTS: MailConfigSection = {
  enabled: false,
  mode: 'demo',
  email: '',
  authCode: '',
  imapHost: 'imap.qq.com',
  imapPort: 993,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  fromName: '',
  folders: 'INBOX',
  intervalMinutes: 30,
  limitPerFetch: 20,
  vaultSubdir: 'mail',
  deliverDigest: true,
  digestMaxChars: 800,
  markSeenOnRead: false,
  maxBodyChars: 20000,
};

/** 除 enabled 之外、由本 World 自己声明的 16 项；键集由 tests/manifest.test.ts 守住。 */
export const MAIL_DECLARED_KEYS: readonly string[] = [
  'mode',
  'email',
  'authCode',
  'imapHost',
  'imapPort',
  'smtpHost',
  'smtpPort',
  'fromName',
  'folders',
  'intervalMinutes',
  'limitPerFetch',
  'vaultSubdir',
  'deliverDigest',
  'digestMaxChars',
  'markSeenOnRead',
  'maxBodyChars',
];

/** 兼容叫法：与 folderLines 同义（任务书里 parseFolderLines / folderLines 两种写法都出现过）。 */
export const parseFolderLines = folderLines;

/** 这些键改动需要重连或重启（x-hot=false）；其余热改即生效（PLAN 第 4 节末段）。 */
const COLD_KEYS: readonly string[] = [
  'mode',
  'email',
  'authCode',
  'imapHost',
  'imapPort',
  'smtpHost',
  'smtpPort',
  'folders',
  'vaultSubdir',
];

/**
 * 多行文本拆成行：去空白、丢空行、丢注释行（以 # 开头）。
 *
 * folders 是唯一的多行文本键，preflight、world 与 service 共用这一处解析，别再各写一份。
 */
export function folderLines(raw: unknown): string[] {
  const text = String(raw === null || raw === undefined ? '' : raw);
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    out.push(trimmed);
  }
  return out;
}

/** 本 World 的设置界面声明。每个键都是 worlds.mail.*，与 defaults() 一一对应。 */
export function mailConfigGroups(language?: Language): ConfigGroup[] {
  const s = strings(language);
  const hot = (key: string): boolean => !COLD_KEYS.includes(key);
  const property = (key: string) => ({
    key: CONFIG_PREFIX + key,
    title: s.config[key as keyof typeof s.config].title,
    description: s.config[key as keyof typeof s.config].description,
  });
  return [
    {
      id: CONFIG_ID,
      owner: CONFIG_OWNER,
      schema: {
        type: 'object',
        title: s.label,
        description: s.env.description,
        properties: {
          [CONFIG_PREFIX + 'mode']: {
            type: 'string',
            ...pick(property('mode')),
            enum: [...MAIL_MODES],
            'x-hot': hot('mode'),
          },
          [CONFIG_PREFIX + 'email']: {
            type: 'string',
            ...pick(property('email')),
            'x-hot': hot('email'),
          },
          [CONFIG_PREFIX + 'authCode']: {
            type: 'string',
            ...pick(property('authCode')),
            'x-hot': hot('authCode'),
          },
          [CONFIG_PREFIX + 'imapHost']: {
            type: 'string',
            ...pick(property('imapHost')),
            'x-hot': hot('imapHost'),
          },
          [CONFIG_PREFIX + 'imapPort']: {
            type: 'integer',
            ...pick(property('imapPort')),
            minimum: 1,
            maximum: 65535,
            'x-hot': hot('imapPort'),
          },
          [CONFIG_PREFIX + 'smtpHost']: {
            type: 'string',
            ...pick(property('smtpHost')),
            'x-hot': hot('smtpHost'),
          },
          [CONFIG_PREFIX + 'smtpPort']: {
            type: 'integer',
            ...pick(property('smtpPort')),
            minimum: 1,
            maximum: 65535,
            'x-hot': hot('smtpPort'),
          },
          [CONFIG_PREFIX + 'fromName']: {
            type: 'string',
            ...pick(property('fromName')),
            'x-hot': hot('fromName'),
          },
          [CONFIG_PREFIX + 'folders']: {
            type: 'string',
            ...pick(property('folders')),
            'x-hot': hot('folders'),
          },
          [CONFIG_PREFIX + 'intervalMinutes']: {
            type: 'integer',
            ...pick(property('intervalMinutes')),
            minimum: 0,
            maximum: 1440,
            'x-hot': hot('intervalMinutes'),
          },
          [CONFIG_PREFIX + 'limitPerFetch']: {
            type: 'integer',
            ...pick(property('limitPerFetch')),
            minimum: 1,
            maximum: 100,
            'x-hot': hot('limitPerFetch'),
          },
          [CONFIG_PREFIX + 'vaultSubdir']: {
            type: 'string',
            ...pick(property('vaultSubdir')),
            'x-hot': hot('vaultSubdir'),
          },
          [CONFIG_PREFIX + 'deliverDigest']: {
            type: 'boolean',
            ...pick(property('deliverDigest')),
            'x-hot': hot('deliverDigest'),
          },
          [CONFIG_PREFIX + 'digestMaxChars']: {
            type: 'integer',
            ...pick(property('digestMaxChars')),
            minimum: 200,
            maximum: 8000,
            'x-hot': hot('digestMaxChars'),
          },
          [CONFIG_PREFIX + 'markSeenOnRead']: {
            type: 'boolean',
            ...pick(property('markSeenOnRead')),
            'x-hot': hot('markSeenOnRead'),
          },
          [CONFIG_PREFIX + 'maxBodyChars']: {
            type: 'integer',
            ...pick(property('maxBodyChars')),
            minimum: 1000,
            maximum: 200000,
            'x-hot': hot('maxBodyChars'),
          },
        },
      },
    },
  ];
}

/** 取 title/description 两个字段，别把 key 一起摊进 schema。 */
function pick<T extends { title: string; description: string }>(value: T): { title: string; description: string } {
  return { title: value.title, description: value.description };
}
