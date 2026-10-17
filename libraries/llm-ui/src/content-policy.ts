function escape(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
/** Model URLs cannot invoke executable schemes or invent object URLs. */
function allowed(value: string, image: boolean): boolean {
    if (value.startsWith('@asset/')) return true;
    try {
        const protocol = new URL(value, 'https://chat.invalid/').protocol;
        return ['http:', 'https:', ...(image ? [] : ['mailto:'])].includes(protocol);
    } catch { return false; }
}
interface LinkToken { href: string; title?: string | null; text: string; tokens: unknown[] }
export const markdownOptions = { markedOptions: { renderer: {
    link(this: { parser: { parseInline(tokens: unknown[]): string } }, token: LinkToken): string {
        const text = this.parser.parseInline(token.tokens);
        return allowed(token.href, false)
            ? `<a href="${escape(token.href)}" rel="noopener noreferrer">${text}</a>` : text;
    },
    image(token: LinkToken): string {
        return allowed(token.href, true)
            ? `<img src="${escape(token.href)}" alt="${escape(token.text)}">` : escape(token.text);
    },
} } };
