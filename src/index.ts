/**
 * 包入口。装配层只取默认导出（extensions.ts:393-398），再按 isWorldDefinition 校验形状
 * （extensions.ts:143-149）。这里除了 re-export 不做别的事：入门面越平越好。
 *
 * 对框架只 import type，运行时零依赖——裸 node 就能 import 这个文件（测试依赖这一点）。
 * 唯一的运行时依赖是本包自己的文件：definition.ts 会 new 的 MailWorld（W3 的 src/world.ts）。
 */
import { fileURLToPath } from 'node:url';
import type { WorldDefinition } from 'cortico/world.ts';
import { MAIL_DEFINITION } from './definition.ts';
import { WORLD_ID, type MailConfigSection } from './config.ts';

/** 定义本身。annotation 在 definition.ts 里，这里再钉一次同一个类型。 */
const definition: WorldDefinition<MailConfigSection> = MAIL_DEFINITION;

export default definition;
export { MAIL_DEFINITION };
export { MailWorld } from './world.ts';
export { TOOL_SPECS, EVENT_SPECS, looksLikeEmail } from './definition.ts';
export {
  WORLD_ID,
  CONFIG_PREFIX,
  CONFIG_ID,
  CONFIG_OWNER,
  MAIL_MODES,
  MAIL_DEFAULTS,
  MAIL_DECLARED_KEYS,
  folderLines,
  parseFolderLines,
  mailConfigGroups,
} from './config.ts';
export type { MailConfigSection } from './config.ts';
export type {
  ListOptions,
  MailAddress,
  MailAttachment,
  MailHeader,
  MailMessage,
  MailMode,
  Mailbox,
  MailboxStatus,
  SearchOptions,
  SendDraft,
  SendResult,
} from './mail/types.ts';
export { createDemoMailbox, DEMO_ACCOUNT, DEMO_CANARY, DEMO_FOLDERS, DEMO_MESSAGES } from './mail/demo.ts';
export type { DemoMailboxOptions, DemoSeedMessage } from './mail/demo.ts';
export {
  FAILURE_ADVICE,
  FAILURE_CLASSES,
  FAILURE_LABEL,
  MODEL,
  PREFLIGHT,
  TEXT,
  classifyFailure,
  failureAdvice,
  failureTitle,
  strings,
} from './i18n.ts';
export type { FailureClass, Strings } from './i18n.ts';

/** 环境提示词模板的绝对路径（框架按它读文件，core/prefix.ts:63-87）。 */
export const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** envPrompt 的 key 惯例：worlds.<id>.<名>（core/types.ts:799-801）。 */
export const ENV_PROMPT_KEY = 'worlds.' + WORLD_ID + '.envPrompt';
