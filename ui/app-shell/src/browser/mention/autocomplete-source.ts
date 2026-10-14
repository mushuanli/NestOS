/**
 * @file app-shell/src/browser/mention/autocomplete-source.ts
 * Editor mention integration built on shared autocomplete contracts.
 * HoverPreviewData is defined in @itookit/common and re-exported here for convenience.
 */

import type { HoverPreviewData } from '@itookit/common';

export type { HoverPreviewData };

import type { IAutocompleteSource, Suggestion } from '@itookit/ui-common';
export type { Suggestion } from '@itookit/ui-common';

export abstract class IMentionSource implements IAutocompleteSource {
    abstract getSuggestions(query: string): Promise<Suggestion[]>;
    abstract readonly key: string;
    public triggerChar: string = '@';

    async getDataForProcess(_targetURL: URL): Promise<unknown | null> { return null; }
    async handleClick(_targetURL: URL): Promise<void> {}
    async getHoverPreview(_uri: string): Promise<HoverPreviewData | null> { return null; }
    async getContentForTransclusion(_targetURL: URL): Promise<string | null> { return null; }
}
