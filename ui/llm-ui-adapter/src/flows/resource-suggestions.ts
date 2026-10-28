import {guessMimeType} from '@itookit/vfs-core';
import {ResourceCommand, parseResourceReference, type ResourceScope} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import type {FileSuggestion} from '../domain/types';

/** Discovery carries metadata only; file bodies are read when the user submits. */
export async function resourceSuggestions(commands: ICommandBus, scope: ResourceScope, query: string, references = true, options?: {includeIgnored?: boolean}): Promise<FileSuggestion[]> {
    const entries = await commands.execute<Array<{label: string; reference: string}>>(ResourceCommand.Search, {query, scope, ...(options?.includeIgnored ? {includeIgnored: true} : {})});
    return entries.filter(entry => references || (parseResourceReference(entry.reference).root === 'current' && !parseResourceReference(entry.reference).navigation))
        .map(entry => ({name: entry.label, path: references ? entry.reference : '.' + parseResourceReference(entry.reference).path, mimeType: guessMimeType(entry.label),
            ...(references ? {reference: entry.reference} : {})}));
}
