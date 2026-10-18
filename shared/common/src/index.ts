// shared/common/src/index.ts

// ── UI 契约已迁移至 @itookit/ui-common（IEditor/ISessionUI/EditorFactory 及 UI 组件）──

// ── 日志 ──
export {
    getLogger,
    createModuleLogger
} from './utils/MemoryLogger';
export { LogLevel, LogLevelNames } from './interfaces/ILogger';
export type { LogEntry, LogFilter, LoggerStats, ModuleLog } from './interfaces/ILogger';

// ── 工具 ──
export { errorDetails } from './utils/error-details';
export { traceBoot } from './utils/boot-trace';
export {
    simpleHash, escapeHTML, escapeAttr,
    generateUUID, generateShortUUID, generateId,
    debounce, isClass,
    sleep, throttle, retry, withTimeout,
    safeJsonParse, deepClone, truncate,
    formatFileSize, formatDuration, timeAgo,
    isImageMimeType,
    blobToBase64, arrayBufferToBase64, base64ToArrayBuffer,
    calculateHash
} from './utils/utils';
export { buildRenamedFilename, formatDefaultFileTitle } from './utils/filename';
export { sha256Hex, sha256HexSync, sha256Bytes, type DigestInput } from './utils/digest';
export { randomUUID } from './utils/random';
export {
    type TaskCounts,
    type MarkdownMetadata,
    type MentionMap,
    type ParsedMarkdownContent,
    slugify, tryParseJson,
    parseMarkdownContent, extractHeadings, extractTaskCounts,
    extractSummary, extractSearchableText,
    parseMarkdown, formatJsonSummary
} from './utils/MarkdownUtils';

// ── 事件 ──
export { NAVIGATION_EVENTS } from './events/navigation-events';
export type { NavigationRequest } from './interfaces/INavigation';
export type { HoverPreviewData } from './interfaces/IHoverPreview';
export type { Heading } from './types/heading';

// ── i18n ──
export { t, setLocale, getLocale, translatedValues } from './i18n';
export type { Locale, LocaleKey, LocaleStrings } from './i18n';
export {
    SKILL_TYPE_META, MCP_TRANSPORT_ICONS,
    MODEL_CAPABILITY_META, MODEL_CATEGORY_META, STATUS_META,
    EXECUTOR_TYPE_ICONS, ACTION_ICONS, CHAT_ICONS, VFS_TOOLBAR_ICONS, TOOLBOX_ICONS, TOOLBOX_PROVIDER_ICONS, FEEDBACK_ICONS,
    ENTITY_ICONS, AGENT_ICON_PALETTE, SLASH_ICONS, getFileIcon, harnessPresentation,
} from './i18n/icons';

// ── EventBus: 已移入 @itookit/vfs-core；消费方从 vfs-core 导入 ──

export { FILE_ICONS, FILE_BROWSER_ICONS, fileTypeIcon } from './i18n/file-icons';
export { HARNESS_STATE_ICONS } from './i18n/icons';
