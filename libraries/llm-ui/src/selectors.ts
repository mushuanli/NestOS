import type {Choice, SelectorView} from './contracts';

/** A dependent value cannot leak from one model or removed selector to another. */
export class ComposerSelectors {
    private readonly values = new Map<string, {current: string; incoming: string; scope: string}>();
    update(selectors: readonly SelectorView[]): void {
        const ids = new Set(selectors.map(selector => selector.id));
        const roots = new Set(selectors.filter(selector => !selector.variants).map(selector => selector.id));
        if (ids.size !== selectors.length || selectors.some(selector => selector.variants && !roots.has(selector.variants.selectorId)))
            throw new Error('Selectors require unique identities and independent variant parents');
        for (const id of this.values.keys()) if (!ids.has(id)) this.values.delete(id);
        for (const selector of selectors.filter(item => !item.variants)) this.synchronize(selector, selector.value, selector.choices, '');
        for (const selector of selectors.filter(item => item.variants)) {
            const parent = this.values.get(selector.variants!.selectorId)?.current ?? '';
            const variant = selector.variants!.values[parent];
            this.synchronize(selector, variant?.value ?? selector.value, variant?.choices ?? selector.choices, parent);
        }
    }
    private synchronize(selector: SelectorView, incoming: string, choices: readonly Choice[], scope: string): void {
        const prior = this.values.get(selector.id);
        if (!prior || prior.scope !== scope || prior.incoming !== incoming || !choices.some(choice => choice.id === prior.current))
            this.values.set(selector.id, {current: choices.some(choice => choice.id === incoming) ? incoming : choices[0]?.id ?? '', incoming, scope});
    }
    choices(selector: SelectorView): readonly Choice[] {
        return selector.variants?.values[this.values.get(selector.variants.selectorId)?.current ?? '']?.choices ?? selector.choices;
    }
    get(id: string): string {return this.values.get(id)?.current ?? '';}
    set(id: string, value: string): void {const row = this.values.get(id); if (row) row.current = value;}
    snapshot(): Readonly<Record<string, string>> {return Object.fromEntries([...this.values].map(([id, value]) => [id, value.current]));}
}
