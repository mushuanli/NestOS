import type {CommandCatalog, ComposerCommand} from './contracts';

/** Distinct sources retain distinct identities even when their slash names coincide. */
export function composeCommandCatalogs(catalogs: readonly CommandCatalog[]): readonly ComposerCommand[] {
    const sources = new Set<string>(), ids = new Set<string>();
    return catalogs.flatMap(catalog => {
        if (!catalog.source.id || sources.has(catalog.source.id)) throw new Error('Duplicate command source');
        sources.add(catalog.source.id);
        return catalog.commands.map(command => {
            const id = JSON.stringify([catalog.source.id, command.id]);
            if (!command.id || ids.has(id) || !/^[\p{L}\p{N}_:.-]+$/u.test(command.name)
                || !Number.isSafeInteger(command.revision) || command.revision < 0) throw new Error('Invalid command identity');
            ids.add(id); return {...command, id, commandId: command.id, source: {...catalog.source}};
        });
    });
}

export function parseCommand(text: string): {name: string; arguments: string} | undefined {
    const match = text.trimStart().match(/^\/([\p{L}\p{N}_:.-]+)(?:\s+([\s\S]*))?$/u);
    return match ? {name: match[1], arguments: match[2] ?? ''} : undefined;
}

export function isCommandInput(text: string): boolean {
    return /^\/[\p{L}\p{N}_:.-]*(?:\s|$)/u.test(text.trimStart());
}
