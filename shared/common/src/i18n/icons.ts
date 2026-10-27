// @file: common/i18n/icons.ts
// Single source of truth for all emoji icons and brand colors used across the UI.
//
// Rules:
//   - One concept = one emoji. Never hardcode emoji outside this file.
//   - Colors follow Tailwind 500/600 range for consistency.
//   - Add a new entry here before using an icon in any component.

// ── Skill types ───────────────────────────────────────────────────────────────

export interface SkillTypeMeta {
    icon:  string;
    color: string;
}

export const SKILL_TYPE_META = {
    prompt:  { icon: '📝', color: '#10b981' }, // emerald-500
    shell:   { icon: '🖥️', color: '#8b5cf6' }, // violet-500
    mcp:     { icon: '🔌', color: '#f97316' }, // orange-500
    http:    { icon: '🌐', color: '#0ea5e9' }, // sky-500
    builtin: { icon: '⚙️', color: '#6366f1' }, // indigo-500
    custom:  { icon: '🔧', color: '#f59e0b' }, // amber-500
} as const satisfies Record<string, SkillTypeMeta>;

// ── MCP transport ─────────────────────────────────────────────────────────────

export type MCPTransport = 'stdio' | 'http';

export const MCP_TRANSPORT_ICONS: Record<MCPTransport, string> = {
    stdio: '🖥️',
    http:  '🌐',
} as const;

// ── Model capabilities & category ─────────────────────────────────────────────

export interface ModelMeta {
    icon:  string;
    color: string;
}

/** 模型能力标志元数据（对应 LLMModel.supportsXXX 字段，用于能力 badge） */
export const MODEL_CAPABILITY_META: Record<string, ModelMeta> = {
    vision:           { icon: '👁️', color: '#0ea5e9' }, // sky-500
    thinking:         { icon: '🔮', color: '#8b5cf6' }, // violet-500
    tools:            { icon: '🔧', color: '#f97316' }, // orange-500
    audio:            { icon: '🎵', color: '#10b981' }, // emerald-500
    video:            { icon: '🎬', color: '#ef4444' }, // red-500
    structuredOutput: { icon: '📋', color: '#6366f1' }, // indigo-500
} as const;

/** 模型用途分类元数据（对应 LLMModel.category 字段，用于分类 badge） */
export const MODEL_CATEGORY_META: Record<string, ModelMeta> = {
    chat:      { icon: '💬', color: '#10b981' }, // emerald-500
    image:     { icon: '🖼️', color: '#f59e0b' }, // amber-500
    video:     { icon: '🎬', color: '#ef4444' }, // red-500
    audio:     { icon: '🎵', color: '#0ea5e9' }, // sky-500
    embedding: { icon: '🔢', color: '#6366f1' }, // indigo-500
} as const;

// ── MCP / connection status ───────────────────────────────────────────────────

export interface StatusMeta {
    dot:   string;   // ● or ○
    color: string;
}

export const STATUS_META: Record<'connected' | 'connecting' | 'error' | 'idle', StatusMeta> = {
    connected: { dot: '●', color: '#10b981' }, // emerald-500
    connecting: { dot: '●', color: '#f59e0b' }, // amber-500
    error:     { dot: '●', color: '#ef4444' }, // red-500
    idle:      { dot: '○', color: '#9ca3af' }, // gray-400
} as const;
export const HARNESS_STATE_ICONS = {
    unknown: '?', idle: '○', running: '▶', 'waiting-approval': '◇', 'waiting-input': '◇', offline: '⊘', stale: '◌',
    completed: '✓', failed: '!', cancelled: '■', error: '!',
} as const;

// ── Executor / node types ─────────────────────

export const EXECUTOR_TYPE_ICONS: Record<string, string> = {
    agent:     '🤖',
    tool:      '🔧',
    composite: '🔀',
    http:      '🌐',
    script:    '📜',
} as const;

// ── File MIME type icons (MentionPlugin, attachments) ────────────────────────

export function getFileIcon(mimeType: string | undefined, filename?: string): string {
    if (!mimeType && filename) {
        if (filename.endsWith('.md') || filename.endsWith('.mdx')) return '📝';
        return '📄';
    }
    if (!mimeType) return '📎';
    if (mimeType.startsWith('image/'))    return '🖼️';
    if (mimeType === 'text/markdown')     return '📝';
    if (mimeType.startsWith('text/'))     return '📄';
    if (mimeType.startsWith('audio/'))    return '🎵';
    if (mimeType.startsWith('video/'))    return '🎬';
    if (mimeType.includes('pdf'))         return '📋';
    return '📎';
}

// ── Common UI actions ─────────────────────────────────────────────────────────

export const ACTION_ICONS = {
    attachment: '📎',
    chat: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8"/></svg>',
    run: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="currentColor"><path d="M8 5.5a1 1 0 0 1 1.5-.86l10 6a1 1 0 0 1 0 1.72l-10 6A1 1 0 0 1 8 17.5Z"/></svg>',
    branch: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6v12M18 9a9 9 0 0 1-9 9"/><circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="6" r="3"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg>',
    sidebar: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
    opened: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M7 12h.01M10 12h7M7 16h.01M10 16h7"/></svg>',
    promptList: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/></svg>',
    refreshView: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/></svg>',
    rerun: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4m0 5h5M4 9a8 8 0 1 1 0 7"/><path d="m10 8 6 4-6 4Z"/></svg>',
    favorite: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" fill="#eab308" stroke="#ca8a04" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    ai: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    wordWrap: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M3 5h18M3 10h14a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M3 15h4M3 20h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    add:      '➕',
    delete:   '🗑️',
    save:     '💾',
    import:   '📥',
    export:   '📤',
    test:     '🔬',
    copy:     '📋',
    edit:     '✏️',
    search:   '🔍',
    settings: '⚙️',
    refresh:  '🔄',
    close:    '✕',
    help:     '❓',
    ocr:      '🔤',
} as const;

// ── Status / feedback ─────────────────────────────────────────────────────────

export const FEEDBACK_ICONS = {
    success: '✅',
    error:   '❌',
    warning: '⚠️',
    info:    'ℹ️',
    loading: '⏳',
    auth:    '🔐',
    rate:    '⏳',
    notFound:'🔍',
} as const;

// ── Entity shortcuts ──────────────────────────────────────────────────────────

export const ENTITY_ICONS = {
    sync:         '⇄',
    chat:         '💬',
    project:      '▣',
    remoteSession: '🌐',
    remoteAgent: '📡',
    remoteProject: '🌐',
    agent:   '🤖',
    skill:   '⚡',
    tool:    '🔧',
    flow:    '🔀',
    mcp:     '🔌',
    llm:     '🔮',
    branch:  '🌿',
    history: '📚',
    nav:     '🧭',
    model:   '🔮',
} as const;

// ── Slash commands ────────────────────────────────────────────────────────────
// One entry per slash command identity (`SlashCommandDef.icon`). Command tables
// must reference these instead of inlining emoji, so a command's icon is always
// reviewable in one place (see packages/llm-ui SlashCommandPlugin).

export const SLASH_ICONS = {
    new:          ACTION_ICONS.add,
    retry:        ACTION_ICONS.refresh,
    continue:     '⏩',
    reedit:       '↩️',
    delete:       '✂️',
    clear:        ACTION_ICONS.delete,
    btw:          '💬',
    shorter:      '📏',
    longer:       '📐',
    simplify:     '💡',
    summarize:    '📝',
    history:      ENTITY_ICONS.history,
    fresh:        '✨',
    fold:         '📁',
    foldAll:      '📂',
    unfoldAll:    '📖',
    top:          '⬆️',
    bottom:       '⬇️',
    nav:          ENTITY_ICONS.nav,
    copy:         ACTION_ICONS.copy,
    export:       ACTION_ICONS.export,
    print:        '🖨️',
    branch:       ENTITY_ICONS.branch,
    branchSwitch: '🔀',
    branchPrev:   '⏮️',
    branchNext:   '⏭️',
    branchList:   '📋',
    branchRename: ACTION_ICONS.edit,
    branchDelete: ACTION_ICONS.delete,
    agent:        ENTITY_ICONS.agent,
    model:        ENTITY_ICONS.model,
    help:         ACTION_ICONS.help,
    skill:        ENTITY_ICONS.skill,
    skills:       ENTITY_ICONS.skill,
    tools:        '🔧',
    read:         '📄',
    grep:         '🔎',
    glob:         ACTION_ICONS.search,
    addDir:       '📁',
    setHome:      '🏠',
    plan:         '🗺️',
    cancel:       '⏹️',
    resume:       '▶️',
    approve:      FEEDBACK_ICONS.success,
    exec:         '⬛',
} as const;

// ── Agent icon picker palette ─────────────────────────────────────────────────

export const AGENT_ICON_PALETTE = [
    '🤖','🔮','💡','🎯','🚀','⚡','🔥','✨',
    '🎨','📝','📊','📈','🔍','🔧','⚙️','🛠️',
    '💻','🖥️','📱','🌐','☁️','🔒','🔑','📡',
    '📚','📖','✏️','🖊️','📌','📎','🗂️','📁',
    '💬','💭','🗨️','👤','👥','🤝','👋','✋',
    '🌟','⭐','🌙','☀️','🌈','🍀','🌸','🌺',
    '🦾','🦿','🕸️','💎','🏆','🎖️','🥇',
] as const;


/** Small outline icons for the shared file toolbar. */
export const VFS_TOOLBAR_ICONS = {
    import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg>',
    export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M4 16v4h16v-4"/></svg>',
} as const;

/** Consistent outline icons for toolbox resource types and purpose groups. */
const toolboxIcon = (shape: string): string => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;
/** Quiet outline controls for conversation content and its composer. */
export const CHAT_ICONS = {
    copy: toolboxIcon('<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'),
    edit: toolboxIcon('<path d="m15 4 5 5M4 20l5-1L21 7a3.5 3.5 0 0 0-5-5L4 14l-1 7z"/>'),
    delete: toolboxIcon('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'),
    more: toolboxIcon('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    chevron: toolboxIcon('<path d="m7 10 5 5 5-5"/>'),
    thinking: toolboxIcon('<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0l-1 2H9l-1-2z"/>'),
    search: toolboxIcon('<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>'),
} as const;
export const TOOLBOX_ICONS = {
    prompts: toolboxIcon('<path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5"/>'),
    providers: toolboxIcon('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M8 6h.01M8 12h.01M8 18h.01"/>'),
    connections: toolboxIcon('<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1"/>'),
    agents: toolboxIcon('<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 7V3M9 16h6M8 11h.01M16 11h.01M1 11v5m22-5v5"/>'),
    skills: toolboxIcon('<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z"/>'),
    flows: toolboxIcon('<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/>'),
    mcp: toolboxIcon('<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8zm6 9v5"/>'),
    tools: toolboxIcon('<path d="M14 6a5 5 0 0 0-6 6l-5 5a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-4 3-3-3 3-4z"/>'),
    files: toolboxIcon('<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'),
    web: toolboxIcon('<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>'),
    memory: ENTITY_ICONS.llm,
    tasks: toolboxIcon('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m7 8 1 1 2-2m-3 7 1 1 2-2m3-5h4m-4 6h4"/>'),
    terminal: toolboxIcon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 8 4 4-4 4m7 0h5"/>'),
    collaboration: toolboxIcon('<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8zM7 10h10M7 14h6"/>'),
    extensions: toolboxIcon('<path d="M9 3h6v4a3 3 0 1 1 4 4h3v7h-7a3 3 0 1 1-6 0H3v-7h4a3 3 0 1 1 2-4V3z"/>'),
    settings: toolboxIcon('<path d="M4 6h16M4 12h16M4 18h16"/><rect x="7" y="4" width="3" height="4" rx="1"/><rect x="14" y="10" width="3" height="4" rx="1"/><rect x="8" y="16" width="3" height="4" rx="1"/>'),
} as const;

/** Provider lettermarks remain legible on hosts without emoji fonts. */
const providerMark = (label: string): string => `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor" opacity=".08"/><text x="12" y="16" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="600" fill="currentColor">${label}</text></svg>`;
export const TOOLBOX_PROVIDER_ICONS: Readonly<Record<string, string>> = {
    anthropic: providerMark('A'), gemini: providerMark('G'), deepseek: providerMark('DS'),
    openai: providerMark('O'), chatgpt: providerMark('GPT'), openrouter: providerMark('OR'), cloudapi: providerMark('C'),
    volcengine: providerMark('V'), 'doubao-speech': providerMark('DB'), codex: TOOLBOX_ICONS.terminal, custom: TOOLBOX_ICONS.providers,
};

const harnessMark = (label: string, mark: string) => ({label, icon: providerMark(mark)
    .replace('aria-hidden="true"', `role="img" aria-label="${label}"`).replace('><rect', `><title>${label}</title><rect`)});
const HARNESS_MARKS: Readonly<Record<string, {label: string; icon: string}>> = {
    nestos: harnessMark('NestOS', 'M'), codex: harnessMark('Codex', 'CX'), dsht: harnessMark('DSHT', 'DS'),
    dsh: harnessMark('DSHT', 'DS'), claude: harnessMark('Claude Code', 'CC'),
    'claude-code': harnessMark('Claude Code', 'CC'), claudecode: harnessMark('Claude Code', 'CC'),
};
/** Provider-declared kinds choose a visual mark; unknown kinds retain a readable label. */
export function harnessPresentation(kind: string, profileId?: string): {label: string; icon: string} {
    const key = kind.toLowerCase();
    const source = Object.hasOwn(HARNESS_MARKS, key) ? HARNESS_MARKS[key]! : {label: kind, icon: TOOLBOX_ICONS.terminal};
    return profileId && profileId !== kind ? {...source, label: `${source.label} · ${profileId}`} : source;
}
