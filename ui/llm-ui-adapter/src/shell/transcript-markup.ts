import { randomUUID, CHAT_ICONS, TOOLBOX_ICONS, escapeHTML, t } from '@itookit/common';
import type { MDxPlugin } from '@itookit/mdxeditor';
import { copyText } from '@itookit/ui-common';

export const TRANSCRIPT_SYSTEM = 'nestos-system';
export const TRANSCRIPT_TOOL = 'nestos-tool';
export const TRANSCRIPT_CONTEXT = 'nestos-context';

/** Only explicit native provenance may hide context; prompt text is never inspected. */
export function contextLabel(kind: string): string | undefined {
    if (kind === 'agents_md.instructions') return t('chatMessage.contextInstructions');
    if (kind === 'environments.environment_context') return t('chatMessage.contextEnvironment');
    const supplemental = ['goal.internal_context', 'permissions.approved_command_prefix_saved', 'permissions.instructions',
        'collaboration_mode.instructions', 'host_skills.instructions', 'multi_agent.mode_instructions',
        'multi_agent.role_instructions', 'model_switch.instructions', 'daemon_recovery.internal_context',
        'plugins.recommendations', 'apps.instructions', 'plugins.usage_instructions', 'multi_agent.usage_hint'];
    return supplemental.includes(kind) ? t('chatMessage.contextSupplement') : undefined;
}

function renderContext(text: string, key: string, kind: string): string | false {
    const label = contextLabel(kind);
    if (!label) return false;
    return `<details class="llm-ui-transcript-context" data-mdx-disclosure-key="native-context:${escapeHTML(key)}">
        <summary>${CHAT_ICONS.chevron}<span>${escapeHTML(label)}</span></summary>
        <div class="llm-ui-transcript-context__body"><button type="button" class="llm-ui-transcript-context__copy" data-transcript-copy>${CHAT_ICONS.copy}${t('action.copy')}</button>
            <div class="llm-ui-transcript-context__content">${escapeHTML(text)}</div></div>
    </details>`;
}

function bindContextCopies(element: HTMLElement): void {
    for (const button of element.querySelectorAll<HTMLButtonElement>('[data-transcript-copy]')) {
        button.onclick = async () => {
            const text = button.nextElementSibling?.textContent ?? '';
            const copied = await copyText(text);
            button.title = t(copied ? 'editor.copySuccess' : 'editor.copyFailed');
            button.setAttribute('aria-label', button.title);
        };
    }
}

/** Generated transcript blocks remain text; only this renderer supplies their markup. */
function renderSystem(text: string, key: string): string {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 100);
    return `<details class="llm-ui-transcript-note" data-mdx-disclosure-key="native-system:${escapeHTML(key)}">
        <summary><span class="llm-ui-transcript-note__label">${t('chatMessage.systemNote')}</span>
            <span class="llm-ui-transcript-note__preview">${escapeHTML(preview)}</span>${CHAT_ICONS.chevron}</summary>
        <div class="llm-ui-transcript-note__content">${escapeHTML(text)}</div>
    </details>`;
}

function renderTool(text: string): string {
    const [title, ...details] = text.split('\n');
    return `<div class="llm-ui-transcript-tool">
        <span class="llm-ui-transcript-tool__label">${TOOLBOX_ICONS.tools}${t('harness.roleTool')}</span>
        <span class="llm-ui-transcript-tool__name">${escapeHTML(title ?? '')}</span>
        ${details.length ? `<span class="llm-ui-transcript-tool__targets">${details.map(detail => `<code>${escapeHTML(detail)}</code>`).join(' · ')}</span>` : ''}
    </div>`;
}

export type TranscriptEncoder = (text: string, language: string) => string;

export function transcriptCodeBlock(text: string, language: string): string {
    let length = 3;
    for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
    const fence = '`'.repeat(length);
    return `${fence}${language}\n${text}\n${fence}`;
}

function renderRegisteredBlock(text: string, language: string): string | false {
    if (language.startsWith(TRANSCRIPT_TOOL + ' ')) return renderTool(text);
    if (language.startsWith(TRANSCRIPT_CONTEXT + ' ')) {
        const [, key, kind] = language.split(' ');
        return renderContext(text, key ?? '', kind ?? '');
    }
    if (!language.startsWith(TRANSCRIPT_SYSTEM + ' ')) return false;
    return renderSystem(text, language.slice(TRANSCRIPT_SYSTEM.length + 1));
}

/** Only blocks registered by this view's native projection receive transcript roles. */
export function createTranscriptMarkup(): {plugin: MDxPlugin; encode: TranscriptEncoder; clear(): void} {
    const scope = 'native-transcript-' + randomUUID() + ':';
    const blocks = new Map<string, {text: string; language: string}>();
    const plugin: MDxPlugin = {name: 'native-transcript-markup', install(context) {
        context.registerSyntaxExtension({renderer: {code(token) {
            const block = blocks.get(token.lang ?? '');
            if (!block || block.text.replace(/\r\n?/g, '\n') !== token.text) return false;
            return renderRegisteredBlock(token.text, block.language);
        }}});
        context.on('domUpdated', ({element}: {element: HTMLElement}) => bindContextCopies(element));
    }};
    return {plugin, clear: () => blocks.clear(), encode(text, language) {
        const key = scope + encodeURIComponent(language);
        blocks.set(key, {text, language});
        return transcriptCodeBlock(text, key);
    }};
}
