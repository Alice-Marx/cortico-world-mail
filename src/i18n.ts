/**
 * 中英文案与中文固定文案。
 *
 * 框架的 Language 有 11 个取值，这里只维护 zh / en 两份：zh 与 zh-Hant 取中文，其余取英文，
 * 与框架 core/language.ts 的 baseLanguage() 同义。
 *
 * 三类文本不是一回事，别混着用：
 * 1. TEXT / strings()：给人看的界面文案（配置表单、事件说明、工具一句话摘要、失败分类），
 *    成对维护——中文面向人，英文也要完整。
 * 2. PREFLIGHT：没有语言通道的报错。框架把 preflight 抛出的 message 原样交给操作者，
 *    按 PLAN「中文优先」固定中文（文案本体仍成对放在 TEXT.preflight 里，便于日后换通道）。
 * 3. MODEL / FAILURE：进模型前缀与工具回执的固定文案，沿用 x-feed 的中文口径。
 *
 * 本文件对框架只 import type，运行时零依赖（包要能裸 node 加载与测试）。
 */
import type { Language } from 'cortico/core/language.ts';

/** 一对文案。zh 必填（简体中文是主语言），en 必填（市场要求双语）。 */
interface Pair {
  readonly zh: string;
  readonly en: string;
}

/** 把 TEXT 里的 Pair 摊平成当前语言下的普通字符串表；其余叶子原样保留。 */
type Deep<T> = T extends Pair ? string : T extends object ? { [K in keyof T]: Deep<T[K]> } : T;

/** 全部成对文案。{name} 形式的占位符由 PREFLIGHT 的渲染函数替换。 */
export const TEXT = {
  label: { zh: '邮箱', en: 'Mailbox' },

  lamp: {
    label: { zh: '邮箱', en: 'Mailbox' },
    hint: {
      offline: { zh: '未启用或还没启动', en: 'Off, or not started yet' },
      loading: { zh: '正在连接邮箱', en: 'Connecting to the mailbox' },
      online: { zh: '邮箱就绪', en: 'Mailbox ready' },
      error: { zh: '连不上邮箱或配置不全，详见日志', en: 'Cannot reach the mailbox, or the config is incomplete; see the log' },
    },
  },

  /** WebUI 面板标题。W3 若要声明 panels 才会用到；没声明面板就不需要浏览器端产物。 */
  panel: {
    title: { zh: '邮箱', en: 'Mailbox' },
  },

  config: {
    mode: {
      title: { zh: '邮箱模式', en: 'Mailbox mode' },
      description: {
        zh: 'demo＝内置演示邮箱，不联网、不需要任何凭据，发信只写进演示发件箱；live＝连真实邮箱（QQ 邮箱的 IMAP/SMTP），需要邮箱地址与授权码。改完要重启这个 World 才生效。',
        en: 'demo uses the built-in demo mailbox: no network, no credentials, and sending only writes to the demo outbox; live connects to the real mailbox (QQ Mail over IMAP/SMTP) and needs the address plus an authorization code. Restart this World after changing it.',
      },
    },
    email: {
      title: { zh: '邮箱地址', en: 'Mail address' },
      description: {
        zh: 'live 模式填你的 QQ 邮箱地址（例如 你的QQ号@qq.com，不用带名字）；demo 模式可以留空。改完要重启这个 World 才生效。',
        en: 'In live mode, your QQ Mail address (for example your-QQ-number@qq.com, without a display name); it may stay empty in demo mode. Restart this World after changing it.',
      },
    },
    authCode: {
      title: { zh: 'QQ 邮箱授权码', en: 'QQ Mail authorization code' },
      description: {
        zh: '这是 QQ 邮箱的「授权码」，不是 QQ 登录密码，也不是邮箱密码。申请：打开 QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP 服务 → 按提示生成授权码，把那一串填到这里。也可以把授权码写在部署目录 .env 的 QQ_MAIL_AUTH_CODE 里（两个都填时以这里为准）。它会保存在本机的部署配置里，只在你的机器上，不要发给任何人；换机器或怀疑泄露就去 QQ 邮箱重新生成。改完要重启这个 World 才生效。',
        en: 'This is the QQ Mail "authorization code", not your QQ login password and not the mailbox password. To get one: open QQ Mail on the web → Settings → Account → enable the IMAP/SMTP service → generate an authorization code, then paste it here. Alternatively put the code in QQ_MAIL_AUTH_CODE in the deployment .env file (this field wins when both are set). It is stored in the local deployment config on your machine only; never send it to anyone, and regenerate it in QQ Mail if it leaks or you change machines. Restart this World after changing it.',
      },
    },
    imapHost: {
      title: { zh: 'IMAP 主机', en: 'IMAP host' },
      description: {
        zh: '收信服务器，默认 imap.qq.com。只有换服务商才改；改完要重启这个 World 才生效。',
        en: 'The incoming-mail server; default imap.qq.com. Change it only when using another provider. Restart this World after changing it.',
      },
    },
    imapPort: {
      title: { zh: 'IMAP 端口', en: 'IMAP port' },
      description: {
        zh: '默认 993（隐式 TLS，连上就是加密的）。只有换服务商才改；改完要重启这个 World 才生效。',
        en: 'Default 993 (implicit TLS, encrypted as soon as it connects). Change it only when using another provider. Restart this World after changing it.',
      },
    },
    smtpHost: {
      title: { zh: 'SMTP 主机', en: 'SMTP host' },
      description: {
        zh: '发信服务器，默认 smtp.qq.com。只有换服务商才改；改完要重启这个 World 才生效。',
        en: 'The outgoing-mail server; default smtp.qq.com. Change it only when using another provider. Restart this World after changing it.',
      },
    },
    smtpPort: {
      title: { zh: 'SMTP 端口', en: 'SMTP port' },
      description: {
        zh: '默认 465（隐式 TLS）。只有换服务商才改；改完要重启这个 World 才生效。',
        en: 'Default 465 (implicit TLS). Change it only when using another provider. Restart this World after changing it.',
      },
    },
    fromName: {
      title: { zh: '发件显示名', en: 'Sender display name' },
      description: {
        zh: '发信时显示的名字，例如「大肥鱼」。留空＝用邮箱地址。不用重启。',
        en: 'The name shown on outgoing mail, for example "Coo". Empty means the mail address. No restart needed.',
      },
    },
    folders: {
      title: { zh: '要收的文件夹', en: 'Folders to read' },
      description: {
        zh: '每行一个文件夹名，大小写要和服务端一致，例如 INBOX、已发送、垃圾邮件；# 开头是注释，空行忽略。至少一行。默认只读 INBOX。改完要重启这个 World 才生效。',
        en: 'One folder name per line, matching the server spelling (for example INBOX, Sent, Junk); lines starting with # are comments and blank lines are ignored. At least one line. Default: INBOX only. Restart this World after changing it.',
      },
    },
    intervalMinutes: {
      title: { zh: '自动收信间隔（分钟）', en: 'Auto-fetch interval (minutes)' },
      description: {
        zh: '默认 30。0＝不自动收，只由工具手动触发。收信与有没有人在对话无关。不用重启。',
        en: 'Default 30. 0 means no automatic fetch; only the tools trigger one. Fetching does not depend on anyone being in a conversation. No restart needed.',
      },
    },
    limitPerFetch: {
      title: { zh: '每轮每文件夹取几封', en: 'Messages per folder per fetch' },
      description: {
        zh: '每轮自动收信时，每个文件夹最多看几封邮件头，默认 20。调大会更慢、更花 token。不用重启。',
        en: 'How many message headers to look at per folder in one automatic fetch; default 20. Raising it is slower and costs more tokens. No restart needed.',
      },
    },
    vaultSubdir: {
      title: { zh: '知识库子目录', en: 'Knowledge subdirectory' },
      description: {
        zh: '读到的邮件落在部署数据目录下的这个子目录里（mail.jsonl + mail.md，可直接读、可审计）。默认 mail。改完要重启这个 World 才生效。',
        en: 'Read mail lands in this subdirectory of the deployment data directory (mail.jsonl + mail.md, readable and auditable). Default mail. Restart this World after changing it.',
      },
    },
    deliverDigest: {
      title: { zh: '新邮件摘要进对话', en: 'Deliver new-mail digests into the conversation' },
      description: {
        zh: '开着时，一轮收信发现新邮件就投一条摘要事件（origin external，会花 token）。关掉则只落库，不打扰对话。不用重启。',
        en: 'When on, a fetch that finds new mail pushes one digest event (origin external; costs tokens). When off, mail is only stored and the conversation is left alone. No restart needed.',
      },
    },
    digestMaxChars: {
      title: { zh: '摘要上限（字）', en: 'Digest length cap (characters)' },
      description: {
        zh: '一条新邮件摘要最多多少字，默认 800。太长会挤占上下文，太短会丢掉来源。不用重启。',
        en: 'Maximum characters of one new-mail digest; default 800. Too long eats context, too short loses provenance. No restart needed.',
      },
    },
    markSeenOnRead: {
      title: { zh: '读正文时标为已读', en: 'Mark as read when the body is read' },
      description: {
        zh: '默认关。开着时，模型用 mail_read 读正文会把服务器上那封标记为已读（会改变你邮箱里的状态）；关着时只读不动。不用重启。',
        en: 'Off by default. When on, reading a body with mail_read marks that message as read on the server (changing your mailbox state); when off, reading changes nothing. No restart needed.',
      },
    },
    maxBodyChars: {
      title: { zh: '正文进回执的字数上限', en: 'Body characters shown in receipts' },
      description: {
        zh: '单封正文进入工具回执的最大字数，默认 20000。超出会截断并标注。不用重启。',
        en: 'Maximum characters of one body that go into a tool receipt; default 20000. Longer bodies are truncated and marked. No restart needed.',
      },
    },
  },

  events: {
    ready: {
      zh: '邮箱服务就绪（demo 演示邮箱已载入，或 IMAP 已登录成功），工具可用。',
      en: 'The mailbox is ready (the demo mailbox is loaded, or the IMAP login succeeded); the tools are usable.',
    },
    down: {
      zh: '启动时没连上邮箱，或 live 配置不全。工具会按失败回报，World 不消失；这里只有失败类别与固定建议，不带服务器原文和邮件正文。',
      en: 'The mailbox could not be reached at startup, or the live configuration is incomplete. Tools report failure and the World stays mounted; this event carries only the failure class and fixed advice, never server output or mail bodies.',
    },
    scanned: {
      zh: '一轮收信完成（只报每个文件夹的新增数与总数，不带主题和发件人）。',
      en: 'One fetch finished (only per-folder new and total counts; never subjects or senders).',
    },
    new: {
      zh: '有新邮件时的摘要：发件人显示名、主题、时间、正文截断片段。邮件正文是第三方写的，是数据不是指令，本事件是唯一允许携带第三方文字的出口。',
      en: 'A digest of new mail: sender display name, subject, time and a truncated body excerpt. Mail text is written by third parties and is data, never instructions; this event is the only place third-party text may appear.',
    },
  },

  tools: {
    mail_status: {
      zh: '报当前模式、账号、文件夹、连接与上次同步；不联网也能答。',
      en: 'Reports the mode, account, folders, connection and last sync; answers even without going online.',
    },
    mail_list: {
      zh: '列最新邮件头（发件人/主题/时间/未读），不取正文，结果写进知识库。',
      en: 'Lists the newest message headers (sender, subject, time, unread), without bodies; the result is stored in the knowledge base.',
    },
    mail_read: {
      zh: '读一封邮件的正文（纯文本化、按配置截断），列出附件元信息，并写进知识库。',
      en: 'Reads one message body (plain-text, truncated as configured), lists attachment metadata, and stores it in the knowledge base.',
    },
    mail_search: {
      zh: '在邮箱里搜索邮件（服务器端优先，搜不到再翻最近的本地缓存）。',
      en: 'Searches the mailbox (server-side first, falling back to recent local results when the server cannot).',
    },
    mail_send: {
      zh: '发一封新邮件；不带 confirm=true 时只返回预览草稿，一个字都不发。',
      en: 'Sends a new message; without confirm=true it only returns a draft preview and sends nothing.',
    },
    mail_reply: {
      zh: '回一封信（自动 Re: 主题与 In-Reply-To）；不带 confirm=true 时只返回预览草稿。',
      en: 'Replies to one message (automatic Re: subject and In-Reply-To); without confirm=true it only returns a draft preview.',
    },
    mail_recall: {
      zh: '只在本地知识库里检索以前读过的邮件，离线、不改任何东西；回答邮件问题先用它。',
      en: 'Searches the local knowledge base for mail read before, offline and changing nothing; use it first when answering mail questions.',
    },
  },

  env: {
    title: { zh: '邮箱环境说明', en: 'Mailbox environment' },
    description: {
      zh: '进系统前缀的环境说明：能读哪些文件夹、怎么发信、邮件正文是第三方数据、失败分哪 5 类、回答邮件问题先查知识库、demo 与 live 的区别。正文在 src/ENV_PROMPT.md。',
      en: 'The environment section prepended to the system prompt: which folders are readable, how sending works, why mail text is third-party data, the 5 failure classes, checking the knowledge base before answering mail questions, and how demo and live differ. The text lives in src/ENV_PROMPT.md.',
    },
    vars: {
      status: { zh: '邮箱模式、连接与扫描的当前状态（一句话，不含邮箱地址）。', en: 'The current mailbox mode, connection and scan state in one line (no mail address).' },
      mode: { zh: '当前模式：demo（内置演示邮箱，不联网）或 live（真实邮箱）。', en: 'The current mode: demo (built-in demo mailbox, no network) or live (the real mailbox).' },
      account: { zh: '当前账号：demo 显示演示账号，live 只说是真实邮箱账号。', en: 'The current account: the demo account in demo mode, and only "the real mailbox account" in live mode.' },
      folders: { zh: '当前要收的文件夹，按人能读的方式列出。', en: 'The folders configured right now, in a human-readable form.' },
      interval: { zh: '自动收信节奏，或「已关闭」。', en: 'The auto-fetch cadence, or a note that it is off.' },
      vault: { zh: '知识库落在哪里（相对部署数据目录）。', en: 'Where the knowledge base lives, relative to the deployment data directory.' },
    },
  },

  /** preflight 报错模板；{name} 是占位符。 */
  preflight: {
    mode: {
      zh: 'worlds.mail.mode 只能是 demo / live，现在是「{value}」。demo＝内置演示邮箱，不联网、不需要凭据；live＝连真实邮箱。',
      en: 'worlds.mail.mode must be demo or live, but it is "{value}". demo is the built-in demo mailbox with no network and no credentials; live connects to the real mailbox.',
    },
    port: {
      zh: 'worlds.mail.{key} 要不是 1–65535 的整数，现在是「{value}」。QQ 邮箱用 993（IMAP）和 465（SMTP）。',
      en: 'worlds.mail.{key} must be an integer from 1 to 65535, but it is "{value}". QQ Mail uses 993 (IMAP) and 465 (SMTP).',
    },
    email: {
      zh: 'worlds.mail.email 填的不是邮箱地址：「{value}」。live 模式要填你的 QQ 邮箱地址（形如 你的QQ号@qq.com）；demo 模式不需要。',
      en: 'worlds.mail.email is not a mail address: "{value}". Live mode needs your QQ Mail address (for example your-QQ-number@qq.com); demo mode needs none.',
    },
    authCode: {
      zh: 'worlds.mail.authCode 是空的。live 模式必须填 QQ 邮箱授权码（不是 QQ 登录密码）：QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP 服务 → 生成授权码。也可以写在部署目录 .env 的 QQ_MAIL_AUTH_CODE 里（两个都填时以配置为准）；只想先看看就把 worlds.mail.mode 改回 demo。',
      en: 'worlds.mail.authCode is empty. Live mode needs the QQ Mail authorization code (not the QQ login password): QQ Mail on the web → Settings → Account → enable the IMAP/SMTP service → generate an authorization code. It may also live in QQ_MAIL_AUTH_CODE in the deployment .env file (the config field wins when both are set); to just look around first, set worlds.mail.mode back to demo.',
    },
    folders: {
      zh: 'worlds.mail.folders 是空的。每行填一个文件夹名（大小写要和服务端一致），例如 INBOX；# 开头是注释、空行忽略，至少一行。',
      en: 'worlds.mail.folders is empty. Put one folder name per line, matching the server spelling, for example INBOX; lines starting with # are comments and blank lines are ignored. At least one line is required.',
    },
  },

  /** 工具失败回执的 5 类：标题与「该做什么」。回执按中文口径（同 x-feed）。 */
  failure: {
    noConfig: {
      title: { zh: '配置没填完', en: 'Configuration incomplete' },
      advice: {
        zh: '按 worlds.mail.email / authCode / folders 的说明去填；授权码不是 QQ 密码，要去 QQ 邮箱网页版 → 设置 → 账号 里开启 IMAP/SMTP 服务后生成。demo 模式不需要凭据——只想先看看就把 worlds.mail.mode 改回 demo。',
        en: 'Fill in worlds.mail.email / authCode / folders as their descriptions say; the authorization code is not the QQ password — enable the IMAP/SMTP service in QQ Mail on the web (Settings → Account) and generate one. Demo mode needs no credentials: set worlds.mail.mode back to demo to just look around.',
      },
    },
    connect: {
      title: { zh: '连不上服务器', en: 'Cannot reach the server' },
      advice: {
        zh: '检查网络、代理，以及 worlds.mail.imapHost/imapPort（或 smtpHost/smtpPort）填得对不对；不要立刻反复重试，过一会儿再试一次。',
        en: 'Check the network, any proxy, and worlds.mail.imapHost/imapPort (or smtpHost/smtpPort). Do not retry in a tight loop; try again a little later.',
      },
    },
    auth: {
      title: { zh: '登录被拒', en: 'Login rejected' },
      advice: {
        zh: '多半是授权码错，或者 QQ 邮箱的 IMAP/SMTP 服务没开：去 QQ 邮箱网页版 → 设置 → 账号 → POP3/IMAP/SMTP 服务 里开启，再重新生成一次授权码填进 worlds.mail.authCode。',
        en: 'Most likely the authorization code is wrong, or the QQ Mail IMAP/SMTP service is off: enable it in QQ Mail on the web (Settings → Account → POP3/IMAP/SMTP service) and generate a fresh authorization code into worlds.mail.authCode.',
      },
    },
    protocol: {
      title: { zh: '服务器回了错', en: 'The server returned an error' },
      advice: {
        zh: '服务器明确拒绝了这条命令。文件夹不存在就检查 worlds.mail.folders 的写法（大小写要与服务端一致）；其他按回执里的分类换个做法再试。',
        en: 'The server explicitly refused the command. If a folder is missing, check the spelling in worlds.mail.folders (it must match the server, including case); otherwise use the failure class in the receipt and try another way.',
      },
    },
    parse: {
      title: { zh: '内容解析失败', en: 'Cannot parse the message' },
      advice: {
        zh: '这封邮件的内容读不出来（编码不支持或报文损坏）。跳过它、换一封；回执里会点名是哪一封，不要整批重试。',
        en: 'This message cannot be read (unsupported encoding or a damaged message). Skip it and use another one; the receipt names the message, so do not retry the whole batch.',
      },
    },
  },
} as const;

/** TEXT 在当前语言下的普通字符串表。 */
export type Strings = Deep<typeof TEXT>;

/** 成对的失败分类（中文标题是回执锚点，英文供界面用）。 */
export type FailureClass = 'no-config' | 'connect' | 'auth' | 'protocol' | 'parse';

/** 5 类失败的固定顺序，与 PLAN 第 6 节一致。 */
export const FAILURE_CLASSES: readonly FailureClass[] = ['no-config', 'connect', 'auth', 'protocol', 'parse'];

export function strings(language?: Language): Strings {
  return resolve(TEXT, isChinese(language)) as Strings;
}

/** zh 与 zh-Hant 用中文；没给语言时按框架缺省取中文；其余语言取英文。 */
export function isChinese(language?: Language): boolean {
  if (typeof language !== 'string' || language === '') return true;
  const tag = language.toLowerCase();
  return tag === 'zh' || tag.startsWith('zh-');
}

function isPair(value: object): value is Pair {
  const v = value as Record<string, unknown>;
  return typeof v.zh === 'string' && typeof v.en === 'string';
}

function resolve(node: unknown, zh: boolean): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (isPair(node)) return zh ? node.zh : node.en;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = resolve(value, zh);
  return out;
}

/** 先取中文模板（preflight 没有语言通道），再把 {name} 占位符换成实际值。 */
function zhTemplate(node: Pair, vars: Record<string, string>): string {
  let out: string = node.zh;
  for (const [name, value] of Object.entries(vars)) out = out.split('{' + name + '}').join(value);
  return out;
}

/**
 * preflight 的报错：框架把 message 原样交给操作者，没有语言通道，按 A6 固定中文。
 * 每条都说清「现在是什么」与「该填什么」，不等到运行起来才静默失败。
 */
export const PREFLIGHT = {
  modeUnknown(value: string): string {
    return zhTemplate(TEXT.preflight.mode, { value });
  },
  portInvalid(key: string, value: string): string {
    return zhTemplate(TEXT.preflight.port, { key, value });
  },
  emailInvalid(value: string): string {
    return zhTemplate(TEXT.preflight.email, { value: value === '' ? '（空）' : value });
  },
  authCodeMissing(): string {
    return zhTemplate(TEXT.preflight.authCode, {});
  },
  foldersEmpty(): string {
    return zhTemplate(TEXT.preflight.folders, {});
  },
};

/** MailErrorCode（PLAN 3.1）→ 5 类失败的映射：同类不互相冒充。 */
const CODE_CLASS: Readonly<Record<string, FailureClass>> = {
  'no-config': 'no-config',
  connect: 'connect',
  tls: 'connect',
  timeout: 'connect',
  dropped: 'connect',
  auth: 'auth',
  protocol: 'protocol',
  parse: 'parse',
};

/** 只按 code 分类，不匹配 message。未知 code 归「服务器回了错」，绝不冒充连接失败。 */
export function classifyFailure(code: string): FailureClass {
  return CODE_CLASS[code] ?? 'protocol';
}

/** 回执里方括号中的分类锚点（固定中文）。测试按它断言，绝不互相冒充。 */
export const FAILURE_LABEL: Readonly<Record<FailureClass, string>> = {
  'no-config': TEXT.failure.noConfig.title.zh,
  connect: TEXT.failure.connect.title.zh,
  auth: TEXT.failure.auth.title.zh,
  protocol: TEXT.failure.protocol.title.zh,
  parse: TEXT.failure.parse.title.zh,
};

/** 「该做什么」，固定中文（回执同 x-feed 口径）。 */
export const FAILURE_ADVICE: Readonly<Record<FailureClass, string>> = {
  'no-config': TEXT.failure.noConfig.advice.zh,
  connect: TEXT.failure.connect.advice.zh,
  auth: TEXT.failure.auth.advice.zh,
  protocol: TEXT.failure.protocol.advice.zh,
  parse: TEXT.failure.parse.advice.zh,
};

/** 给人看的分类标题与建议，按请求语言取。 */
export function failureTitle(kind: FailureClass, language?: Language): string {
  return strings(language).failure[failureKey(kind)].title;
}

export function failureAdvice(kind: FailureClass, language?: Language): string {
  return strings(language).failure[failureKey(kind)].advice;
}

function failureKey(kind: FailureClass): 'noConfig' | 'connect' | 'auth' | 'protocol' | 'parse' {
  switch (kind) {
    case 'no-config':
      return 'noConfig';
    default:
      return kind;
  }
}

/**
 * 进模型前缀的固定文案：环境提示词变量与状态一句话用，永远中文（A6）。
 * 不放邮箱地址，避免把 Master 的邮箱写进模型上下文。
 */
export const MODEL = {
  status: {
    idle: '还没启动。',
    starting: '正在连接邮箱。',
    ready: '邮箱已就绪，工具可用。',
    failed: '邮箱没连上：工具会按失败回报，具体原因看工具回执。',
    demo: '当前是 demo 模式：内置演示邮箱，不联网、不需要凭据，发信只写进演示发件箱。',
    live: '当前是 live 模式：连的是真实邮箱，收发都走网络。',
  },
  intervalOff: '自动收信已关闭（intervalMinutes=0），只能由工具手动触发。',
  intervalOn(minutes: number): string {
    return '每 ' + String(minutes) + ' 分钟自动收一次，与有没有在对话无关。';
  },
  vault(subdir: string): string {
    return '本地知识库在部署数据目录下的 ' + subdir + '/ 里（mail.jsonl + mail.md，可直接读，可审计）。';
  },
  foldersNone: '一个文件夹都没配——任何收信都会直接失败。',
  foldersSome(lines: readonly string[]): string {
    return '当前要收 ' + String(lines.length) + ' 个文件夹：' + lines.join('、') + '。';
  },
  confirmGate: '发信是危险动作：mail_send / mail_reply 不带 confirm=true 时只给预览草稿，不会真的发送。',
} as const;
