import { createModuleLogger, t, type LocaleKey } from '@itookit/common';

const log = createModuleLogger('toolbox-filters');
const labels: Record<string, LocaleKey> = {
    chat: 'toolbox.capability.chat', vision: 'toolbox.capability.vision',
    'image.generate': 'toolbox.capability.image', 'speech.synthesize': 'toolbox.capability.speech',
    audio: 'toolbox.capability.audio', tools: 'toolbox.capability.tools', thinking: 'toolbox.capability.thinking', embedding: 'toolbox.capability.embedding',
    video: 'model.capability.video', structuredOutput: 'model.capability.structuredOutput',
};
export const capabilityLabel = (tag: string): string => labels[tag] ? t(labels[tag]) : tag;
export const capabilityLabels = (tags?: string[]): string[] => (tags ?? []).map(capabilityLabel);

/** Compose existing tag queries instead of maintaining a second filtering state. */
export class CapabilityFilters {
    readonly root = document.createElement('div');
    private readonly choices = document.createElement('div');
    private readonly clear = document.createElement('button');
    constructor(private readonly query: () => string, private readonly change: (query: string) => void,
        private readonly changed?: (tags: string[], visible: boolean) => void) {
        this.root.className = 'toolbox-capabilities'; this.choices.className = 'toolbox-capabilities__choices';
        this.root.setAttribute('aria-label', t('toolbox.capability.hint'));
        this.clear.type = 'button'; this.clear.textContent = t('toolbox.capability.clear');
        this.clear.onclick = () => this.change(this.tokens().filter(token => !this.selected(token)).join(' '));
        this.root.append(this.choices, this.clear);
    }
    update(tags: string[], visible: boolean): void {
        this.root.hidden = !visible || !tags.length;
        const unique = [...new Set(['chat', 'vision', 'image.generate', 'speech.synthesize', ...tags])]
            .sort((a, b) => Object.keys(labels).indexOf(a) - Object.keys(labels).indexOf(b));
        if (this.choices.dataset.tags !== JSON.stringify(unique)) {
            this.choices.dataset.tags = JSON.stringify(unique); this.choices.replaceChildren(...unique.map(tag => this.button(tag)));
        }
        this.sync();
    }
    sync(): void {
        const tokens = this.tokens(), count = tokens.filter(token => this.selected(token)).length;
        this.clear.hidden = !count;
        for (const button of this.choices.querySelectorAll<HTMLButtonElement>('button'))
            button.setAttribute('aria-pressed', String(tokens.some(token => token.toLowerCase() === button.dataset.query!.toLowerCase())));
        this.changed?.(tokens.filter(token => this.selected(token)).map(token => token.slice(4)), !this.root.hidden);
    }
    remove(tag: string): void { this.change(this.tokens().filter(token => token.toLowerCase() !== 'tag:' + tag.toLowerCase()).join(' ')); }
    private button(tag: string): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.capability = tag;
        button.textContent = capabilityLabel(tag); button.dataset.query = 'tag:' + tag;
        button.onclick = () => {
            const tokens = this.tokens(), token = button.dataset.query!, active = tokens.some(value => value.toLowerCase() === token.toLowerCase());
            log.debug('capability.filter.changed', {capability: tag, selected: !active});
            this.change((active ? tokens.filter(value => value.toLowerCase() !== token.toLowerCase()) : [...tokens, token]).join(' '));
        };
        return button;
    }
    private tokens(): string[] { return this.query().trim().split(/\s+/).filter(Boolean); }
    private selected(token: string): boolean { return Object.keys(labels).some(tag => token.toLowerCase() === 'tag:' + tag); }
}
