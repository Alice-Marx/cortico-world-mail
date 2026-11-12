/**
 * 假 IMAP 服务器（tests/fixtures/support，W1 交付，W2/W3 可复用）。
 *
 * 只监听 `127.0.0.1:0`（随机端口），测试用完必须 `await server.close()`；不连任何真实网络，
 * 不含真实凭据：默认账号 = tester@example.com / demo-auth-code，地址全用 example.com。
 *
 * 用法：
 *   import { startFakeImapServer } from './fixtures/support/fake-imap-server.ts';
 *
 *   const server = await startFakeImapServer();   // 默认数据集：INBOX 3 封 + 已发送 1 封 + 垃圾邮件 0 封
 *   const client = createImapClient({
 *     host: '127.0.0.1', port: server.port, secure: false, allowPlaintext: true,
 *     user: server.user, pass: server.pass, timeoutMs: 1000,
 *   });
 *   await client.connect();
 *   console.log(await client.folders());               // ['INBOX', '已发送', '垃圾邮件']
 *   console.log(server.requests);                      // 收到的命令（不含 literal 内容）
 *   await client.logout();
 *   await server.close();
 *
 * 自定义数据集：folders: [{ name: 'INBOX', messages: [{ uid: 7, flags: ['\\Seen'], raw: '...' }] }]
 *
 * 故障模拟选项（全部可选，W1 测试用，W3 一般不需要）：
 *   loginTaggedResponse: 'NO' | 'BAD'   LOGIN 直接回错（测 auth 分类）
 *   selectTaggedResponse: 'NO'          SELECT 回错（测 protocol 分类）
 *   searchTaggedResponse: 'BAD'         UID SEARCH 不被支持（测 protocol 分类）
 *   splitLiterals: true                 FETCH 的 literal 拆成两个 TCP 包（测跨包 literal）
 *   hangOn: 'UID FETCH'                 命中前缀的命令不响应（测 timeout）
 *   dropOn: 'UID FETCH'                 命中前缀的命令直接断连（测 dropped）
 *   sendContinuationOn: 'UID FETCH'     命中前缀的命令先发一行 '+ go ahead'（测 continuation）
 *   delayMs: 10                         每条响应前延迟（毫秒）
 *   greeting: '* OK ...'                自定义问候行
 *
 * 注意：只实现 W1/W3 用到的子集（CAPABILITY / LOGIN / LIST / SELECT / EXAMINE / UID SEARCH /
 * UID FETCH（含 BODY.PEEK[HEADER.FIELDS (...)] 与 BODY.PEEK[]）/ UID STORE / LOGOUT / NOOP）。
 */

import { Buffer } from 'node:buffer';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { decodeImapUtf7, encodeImapUtf7 } from '../../../src/mail/imap-utf7.ts';

// ───────────────────────── 公共类型 ─────────────────────────

export interface FakeImapMessage {
  uid: number;
  flags: string[];
  /** 完整 RFC822 报文（建议 CRLF） */
  raw: string;
}

export interface FakeImapFolder {
  name: string;
  messages: FakeImapMessage[];
  uidValidity?: number;
  uidNext?: number;
  /** false 时 LIST 返回 \Noselect（文件夹存在但不可选） */
  selectable?: boolean;
}

export interface FakeImapServerOptions {
  user?: string;
  pass?: string;
  folders?: FakeImapFolder[];
  greeting?: string;
  loginTaggedResponse?: 'NO' | 'BAD';
  selectTaggedResponse?: 'NO' | 'BAD';
  searchTaggedResponse?: 'NO' | 'BAD';
  splitLiterals?: boolean;
  hangOn?: string;
  dropOn?: string;
  sendContinuationOn?: string;
  delayMs?: number;
}

export interface FakeImapServer {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** 收到的命令行（按到达顺序；不含 literal 正文） */
  requests: string[];
  /** 数据集引用：测试可直接读/改（markSeen 会改 flags） */
  folders: FakeImapFolder[];
  findFolder(name: string): FakeImapFolder | undefined;
  close(): Promise<void>;
}

// ───────────────────────── 默认数据 ─────────────────────────

export const DEFAULT_FAKE_IMAP_HOST = '127.0.0.1';
export const DEFAULT_FAKE_IMAP_USER = 'tester@example.com';
export const DEFAULT_FAKE_IMAP_PASS = 'demo-auth-code';

/** 拼一封最简单的纯文本报文（CRLF）。 */
export function makeRawMessage(options: {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  date?: string;
  messageId?: string;
  contentType?: string;
  extraHeaders?: string[];
}): string {
  const from = options.from ?? 'sender@example.com';
  const to = options.to ?? 'tester@example.com';
  const subject = options.subject ?? 'Fake message';
  const date = options.date ?? 'Wed, 05 Nov 2026 08:00:00 +0000';
  const messageId = options.messageId ?? `<${subject.length}-${from.replace(/[^a-z0-9]/gi, '')}@example.com>`;
  const body = options.body ?? 'Hello from the fake IMAP server.';
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: ${options.contentType ?? 'text/plain; charset=UTF-8'}`,
    'Content-Transfer-Encoding: 8bit',
    ...(options.extraHeaders ?? []),
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** 默认数据集：INBOX 3 封（1 未读 / 1 已标记）、已发送 1 封、垃圾邮件 0 封、Archive 不可选。 */
export function makeDefaultFolders(): FakeImapFolder[] {
  return [
    {
      name: 'INBOX',
      uidValidity: 1,
      uidNext: 104,
      messages: [
        {
          uid: 101,
          flags: ['\\Seen'],
          raw: makeRawMessage({
            from: 'alice@example.com',
            subject: 'Welcome to the demo inbox',
            body: 'This is the first message in the fake mailbox.',
            date: 'Mon, 10 Nov 2026 09:00:00 +0000',
            messageId: '<fake-101@example.com>',
          }),
        },
        {
          uid: 102,
          flags: [],
          raw: makeRawMessage({
            from: 'bob@example.net',
            subject: 'Unread notification',
            body: 'You have one unread notification.',
            date: 'Tue, 11 Nov 2026 10:30:00 +0000',
            messageId: '<fake-102@example.net>',
          }),
        },
        {
          uid: 103,
          flags: ['\\Seen', '\\Flagged'],
          raw: makeRawMessage({
            from: 'carol@example.org',
            subject: 'HTML newsletter',
            body: '<html><body><p>Hello <b>HTML</b> world</p></body></html>',
            date: 'Wed, 12 Nov 2026 08:15:00 +0000',
            messageId: '<fake-103@example.org>',
            contentType: 'text/html; charset=UTF-8',
            extraHeaders: ['Content-Disposition: inline'],
          }),
        },
      ],
    },
    {
      name: '已发送',
      uidValidity: 2,
      uidNext: 202,
      messages: [
        {
          uid: 201,
          flags: ['\\Seen'],
          raw: makeRawMessage({
            from: 'tester@example.com',
            to: 'dave@example.com',
            subject: 'Sent from demo',
            body: 'A message that was already sent.',
            date: 'Sun, 09 Nov 2026 12:00:00 +0000',
            messageId: '<fake-201@example.com>',
          }),
        },
      ],
    },
    { name: '垃圾邮件', uidValidity: 3, uidNext: 1, messages: [] },
    { name: 'Archive', uidValidity: 4, uidNext: 1, messages: [], selectable: false },
  ];
}

// ───────────────────────── 工具函数 ─────────────────────────

function delay(ms: number): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function quoteImapName(name: string): string {
  const encoded = encodeImapUtf7(name);
  return `"${encoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquoteImapToken(token: string): string {
  const value = token.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return decodeImapUtf7(value.slice(1, -1).replace(/\\(.)/g, '$1'));
  }
  return decodeImapUtf7(value);
}

function splitRaw(raw: string): { headerText: string; bodyText: string } {
  const crlf = raw.indexOf('\r\n\r\n');
  if (crlf >= 0) return { headerText: raw.slice(0, crlf), bodyText: raw.slice(crlf + 4) };
  const lf = raw.indexOf('\n\n');
  if (lf >= 0) return { headerText: raw.slice(0, lf).replace(/\r/g, ''), bodyText: raw.slice(lf + 2) };
  return { headerText: raw, bodyText: '' };
}

function parseRawHeaderLines(headerText: string): Array<{ name: string; value: string }> {
  const unfolded = headerText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]+/g, ' ');
  const headers: Array<{ name: string; value: string }> = [];
  for (const line of unfolded.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

function parseQuotedWords(text: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2];
    words.push(value);
  }
  return words;
}

interface SearchCriteria {
  unseen: boolean;
  text: string[];
  from: string[];
  subject: string[];
  since: Date | null;
}

function parseSearchCriteria(text: string): SearchCriteria {
  const criteria: SearchCriteria = { unseen: false, text: [], from: [], subject: [], since: null };
  // UNSEEN 这类 flag 没有参数，先整体识别
  if (/\bUNSEEN\b/i.test(text)) criteria.unseen = true;
  const re = /(TEXT|FROM|SUBJECT|SINCE)\s+("(?:[^"\\]|\\.)*"|\S+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const keyword = match[1].toUpperCase();
    const value = match[2].replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
    if (keyword === 'TEXT') criteria.text.push(value.toLowerCase());
    else if (keyword === 'FROM') criteria.from.push(value.toLowerCase());
    else if (keyword === 'SUBJECT') criteria.subject.push(value.toLowerCase());
    else if (keyword === 'SINCE') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) criteria.since = date;
    }
  }
  return criteria;
}

function messageMatchesSearch(message: FakeImapMessage, criteria: SearchCriteria): boolean {
  if (criteria.unseen && message.flags.some((flag) => /^\\Seen$/i.test(flag))) return false;
  const { headerText } = splitRaw(message.raw);
  const headers = parseRawHeaderLines(headerText);
  const rawLower = message.raw.toLowerCase();
  for (const term of criteria.text) if (!rawLower.includes(term)) return false;
  for (const term of criteria.from) {
    const value = (headers.find((header) => header.name.toLowerCase() === 'from')?.value ?? '').toLowerCase();
    if (!value.includes(term)) return false;
  }
  for (const term of criteria.subject) {
    const value = (headers.find((header) => header.name.toLowerCase() === 'subject')?.value ?? '').toLowerCase();
    if (!value.includes(term)) return false;
  }
  if (criteria.since) {
    const value = headers.find((header) => header.name.toLowerCase() === 'date')?.value ?? '';
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime()) || date.getTime() < criteria.since.getTime()) return false;
  }
  return true;
}

// ───────────────────────── 服务器 ─────────────────────────

interface ConnectionState {
  socket: Socket;
  authenticated: boolean;
  selected: FakeImapFolder | null;
  buffer: string;
  dataMode: boolean;
  dataLines: string[];
  processing: boolean;
  closed: boolean;
}

export async function startFakeImapServer(options: FakeImapServerOptions = {}): Promise<FakeImapServer> {
  const user = options.user ?? DEFAULT_FAKE_IMAP_USER;
  const pass = options.pass ?? DEFAULT_FAKE_IMAP_PASS;
  const folders = (options.folders ?? makeDefaultFolders()).map((folder) => ({
    ...folder,
    messages: folder.messages.map((message) => ({
      ...message,
      flags: [...message.flags],
      raw: message.raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n'),
    })),
  }));
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const delayMs = options.delayMs ?? 0;

  const write = (state: ConnectionState, text: string): void => {
    if (state.socket.destroyed) return;
    state.socket.write(text);
  };

  const writeBuffer = (state: ConnectionState, buffer: Buffer): void => {
    if (state.socket.destroyed) return;
    state.socket.write(buffer);
  };

  const commandKeyword = (line: string): string => {
    const tokens = line.trim().split(/\s+/);
    const withoutTag = tokens.slice(1);
    return withoutTag.join(' ').toUpperCase();
  };

  const matchesOption = (keyword: string, option: string | undefined): boolean => {
    if (!option) return false;
    return keyword.startsWith(option.trim().toUpperCase());
  };

  const sendList = (state: ConnectionState, tag: string): void => {
    for (const folder of folders) {
      const flags = folder.selectable === false ? '\\HasNoChildren \\Noselect' : '\\HasNoChildren';
      write(state, `* LIST (${flags}) "/" ${quoteImapName(folder.name)}\r\n`);
    }
    write(state, `${tag} OK LIST completed\r\n`);
  };

  const folderSeq = (folder: FakeImapFolder, index: number): number => index + 1;

  const sendFetchLiteral = async (
    state: ConnectionState,
    head: string,
    literal: Buffer,
    tail: string,
  ): Promise<void> => {
    if (!options.splitLiterals) {
      writeBuffer(state, Buffer.concat([Buffer.from(head, 'latin1'), literal, Buffer.from(tail, 'latin1')]));
      return;
    }
    // 故意把 literal 拆成两个 TCP 包（跨包 literal 测试）
    const half = Math.max(1, Math.floor(literal.length / 2));
    writeBuffer(state, Buffer.concat([Buffer.from(head, 'latin1'), literal.subarray(0, half)]));
    await delay(10);
    writeBuffer(state, Buffer.concat([literal.subarray(half), Buffer.from(tail, 'latin1')]));
  };

  const handleFetch = async (state: ConnectionState, tag: string, line: string): Promise<void> => {
    if (!state.selected) {
      write(state, `${tag} BAD No mailbox selected\r\n`);
      return;
    }
    const keyword = /^(UID\s+)?FETCH\s+([^\s]+)\s+\((.*)\)\s*$/is.exec(line.trim());
    if (!keyword) {
      write(state, `${tag} BAD Could not parse FETCH\r\n`);
      return;
    }
    const isUid = Boolean(keyword[1]);
    const spec = keyword[2];
    const items = keyword[3];
    const folder = state.selected;
    const messages = folder.messages;
    const maxSeq = messages.length;
    const maxUid = messages.reduce((max, message) => Math.max(max, message.uid), 0);

    const wanted = new Set<number>();
    for (const part of spec.split(',')) {
      const range = part.trim();
      if (!range) continue;
      const [rawStart, rawEnd] = range.split(':');
      const normalize = (token: string, isMax: boolean): number => {
        if (token === '*') return isMax ? (isUid ? maxUid : maxSeq) : 0;
        const value = Number(token);
        return Number.isFinite(value) ? value : 0;
      };
      const start = normalize(rawStart ?? '*', false);
      const end = rawEnd === undefined ? start : normalize(rawEnd, true);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let i = 0; i < messages.length; i += 1) {
        const key = isUid ? messages[i].uid : folderSeq(folder, i);
        if (key >= lo && key <= hi) wanted.add(i);
      }
    }

    const wantsHeaders = /BODY(?:\.PEEK)?\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items);
    const wantsFull = /BODY(?:\.PEEK)?\[\]/i.exec(items);

    const sortedIndexes = [...wanted].sort((a, b) => a - b);
    for (const index of sortedIndexes) {
      const message = messages[index];
      const seq = folderSeq(folder, index);
      const rawSize = Buffer.byteLength(message.raw, 'utf8');
      let head = `* ${seq} FETCH (UID ${message.uid} FLAGS (${message.flags.join(' ')}) RFC822.SIZE ${rawSize}`;
      const literals: Array<{ itemName: string; payload: Buffer }> = [];

      if (wantsHeaders) {
        const fields = wantsHeaders[1]
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const { headerText } = splitRaw(message.raw);
        const headers = parseRawHeaderLines(headerText);
        const lines: string[] = [];
        for (const field of fields) {
          const found = headers.find((header) => header.name.toLowerCase() === field.toLowerCase());
          if (found) lines.push(`${found.name}: ${found.value}`);
        }
        lines.push('', '');
        const payload = Buffer.from(lines.join('\r\n'), 'utf8');
        literals.push({ itemName: `BODY[HEADER.FIELDS (${fields.join(' ')})]`, payload });
      }
      if (wantsFull) {
        literals.push({ itemName: 'BODY[]', payload: Buffer.from(message.raw, 'utf8') });
      }

      for (const literal of literals) {
        head += ` ${literal.itemName} {${literal.payload.length}}\r\n`;
        await sendFetchLiteral(state, head, literal.payload, ')\r\n');
        head = '';
      }
      if (literals.length === 0) write(state, `${head} )\r\n`);
    }
    write(state, `${tag} OK UID FETCH completed\r\n`);
  };

  const handleLine = async (state: ConnectionState, line: string): Promise<void> => {
    if (!line.trim()) return; // 空行（例如 + continuation 后的空响应）直接忽略
    requests.push(line);
    if (requests.length > 1000) requests.splice(0, requests.length - 1000);

    if (state.dataMode) {
      if (line === '.') {
        state.dataMode = false;
        write(state, '250 2.0.0 Ok: queued\r\n');
        state.dataLines = [];
        return;
      }
      state.dataLines.push(line.startsWith('..') ? line.slice(1) : line);
      return;
    }

    const match = /^(\S+)\s+([\s\S]*)$/.exec(line.trim());
    if (!match) {
      write(state, 'BADD no tag\r\n');
      return;
    }
    const tag = match[1];
    const rest = match[2].trim();
    const keyword = commandKeyword(line);

    if (matchesOption(keyword, options.hangOn)) {
      // 不回应：等客户端超时
      return;
    }
    if (matchesOption(keyword, options.dropOn)) {
      state.closed = true;
      state.socket.destroy();
      return;
    }
    if (matchesOption(keyword, options.sendContinuationOn)) {
      write(state, '+ go ahead\r\n');
    }

    await delay(delayMs);

    const tokens = rest.split(/\s+/);
    let command = tokens[0]?.toUpperCase() ?? '';
    if (command === 'UID') command = tokens[1]?.toUpperCase() ?? '';
    switch (command) {
      case 'CAPABILITY':
        write(state, '* CAPABILITY IMAP4rev1 AUTH=PLAIN LITERAL+\r\n');
        write(state, `${tag} OK CAPABILITY completed\r\n`);
        return;
      case 'NOOP':
        write(state, `${tag} OK NOOP completed\r\n`);
        return;
      case 'LOGIN': {
        const args = parseQuotedWords(rest.slice(rest.indexOf(' ') + 1));
        if (options.loginTaggedResponse) {
          write(state, `${tag} ${options.loginTaggedResponse} LOGIN rejected by fake server\r\n`);
          return;
        }
        const ok = args[0] === user && args[1] === pass;
        if (ok) {
          state.authenticated = true;
          write(state, `${tag} OK LOGIN completed\r\n`);
        } else {
          write(state, `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        }
        return;
      }
      case 'LIST': {
        if (!state.authenticated) {
          write(state, `${tag} BAD Not authenticated\r\n`);
          return;
        }
        sendList(state, tag);
        return;
      }
      case 'SELECT':
      case 'EXAMINE': {
        if (!state.authenticated) {
          write(state, `${tag} BAD Not authenticated\r\n`);
          return;
        }
        const nameArg = rest.slice(rest.indexOf(' ') + 1).trim();
        const name = unquoteImapToken(nameArg);
        const folder = folders.find((candidate) => candidate.name === name);
        if (!folder || folder.selectable === false) {
          write(state, `${tag} NO [NONEXISTENT] No such mailbox\r\n`);
          return;
        }
        if (options.selectTaggedResponse) {
          write(state, `${tag} ${options.selectTaggedResponse} SELECT rejected by fake server\r\n`);
          return;
        }
        state.selected = folder;
        const uidValidity = folder.uidValidity ?? 1;
        const uidNext = folder.uidNext ?? folder.messages.reduce((max, message) => Math.max(max, message.uid), 0) + 1;
        write(state, `* ${folder.messages.length} EXISTS\r\n`);
        write(state, '* 0 RECENT\r\n');
        write(state, `* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n`);
        write(state, `* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n`);
        write(state, '* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
        write(state, `${tag} OK [READ-WRITE] ${tokens[0].toUpperCase()} completed\r\n`);
        return;
      }
      case 'SEARCH': {
        if (!state.authenticated || !state.selected) {
          write(state, `${tag} BAD Not selected\r\n`);
          return;
        }
        if (options.searchTaggedResponse) {
          write(state, `${tag} ${options.searchTaggedResponse} SEARCH not supported by fake server\r\n`);
          return;
        }
        const isUid = /^UID\s+SEARCH/i.test(rest);
        const criteriaText = rest.replace(/^UID\s+SEARCH\s*/i, '');
        const criteria = parseSearchCriteria(criteriaText);
        const uidList = state.selected.messages
          .filter((message) => messageMatchesSearch(message, criteria))
          .map((message) => message.uid);
        write(state, `* SEARCH${uidList.length ? ` ${uidList.join(' ')}` : ''}\r\n`);
        write(state, `${tag} OK ${isUid ? 'UID SEARCH' : 'SEARCH'} completed\r\n`);
        return;
      }
      case 'FETCH': {
        if (!state.authenticated) {
          write(state, `${tag} BAD Not authenticated\r\n`);
          return;
        }
        // UID FETCH ... 与 FETCH ... 都支持
        await handleFetch(state, tag, rest);
        return;
      }
      case 'STORE': {
        if (!state.authenticated || !state.selected) {
          write(state, `${tag} BAD Not selected\r\n`);
          return;
        }
        const storeMatch = /^(UID\s+STORE\s+)(\d+)\s+\+FLAGS\s+\(([^)]*)\)/i.exec(rest);
        if (!storeMatch) {
          write(state, `${tag} BAD Could not parse STORE\r\n`);
          return;
        }
        const uid = Number(storeMatch[2]);
        const extra = storeMatch[3].split(/\s+/).filter(Boolean);
        const folder = state.selected;
        const index = folder.messages.findIndex((message) => message.uid === uid);
        if (index < 0) {
          write(state, `${tag} NO [NONEXISTENT] No such message\r\n`);
          return;
        }
        for (const flag of extra) {
          if (!folder.messages[index].flags.some((existing) => existing.toLowerCase() === flag.toLowerCase())) {
            folder.messages[index].flags.push(flag);
          }
        }
        write(
          state,
          `* ${index + 1} FETCH (UID ${uid} FLAGS (${folder.messages[index].flags.join(' ')}))\r\n`,
        );
        write(state, `${tag} OK UID STORE completed\r\n`);
        return;
      }
      case 'LOGOUT':
        write(state, '* BYE fake IMAP server logging out\r\n');
        write(state, `${tag} OK LOGOUT completed\r\n`);
        state.closed = true;
        state.socket.end();
        return;
      default:
        write(state, `${tag} BAD Unknown command\r\n`);
    }
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const state: ConnectionState = {
      socket,
      authenticated: false,
      selected: null,
      buffer: '',
      dataMode: false,
      dataLines: [],
      processing: false,
      closed: false,
    };
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      if (state.closed) return;
      state.buffer += chunk;
      void processBuffer();
    });
    socket.on('error', () => {
      sockets.delete(socket);
    });
    socket.on('close', () => {
      sockets.delete(socket);
      state.closed = true;
    });

    const processBuffer = async (): Promise<void> => {
      if (state.processing) return;
      state.processing = true;
      try {
        for (;;) {
          const newline = state.buffer.indexOf('\n');
          if (newline < 0) break;
          let line = state.buffer.slice(0, newline);
          state.buffer = state.buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          await handleLine(state, line);
          if (state.closed || state.socket.destroyed) return;
        }
      } finally {
        state.processing = false;
      }
    };

    write(state, `${options.greeting ?? '* OK fake IMAP server ready'}\r\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_FAKE_IMAP_HOST, () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    host: DEFAULT_FAKE_IMAP_HOST,
    port: address.port,
    user,
    pass,
    requests,
    folders,
    findFolder(name: string): FakeImapFolder | undefined {
      return folders.find((folder) => folder.name === name);
    },
    async close(): Promise<void> {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // 忽略
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
