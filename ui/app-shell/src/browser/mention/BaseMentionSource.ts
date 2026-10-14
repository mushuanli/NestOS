/**
 * @file app-shell/src/browser/mention/BaseMentionSource.ts
 * @desc Base class for mention sources.
 */
import {
  IMentionSource,
  type Suggestion,
  type HoverPreviewData,
} from './autocomplete-source';
import {
  type IFileSystem,
  type FSNode,
} from '@itookit/vfs-core';
const shouldFilterNode = (node: FSNode): boolean => !node.metadata?._showAll &&
  [node.name, ...node.path.split('/')].some(part => part.startsWith('.') || part.startsWith('_'));

export interface MentionSourceDependencies {
  engine: IFileSystem;
  scope?: boolean | string[];
}

export abstract class BaseMentionSource extends IMentionSource {
  protected readonly engine: IFileSystem;
  protected readonly searchScope: string[] | undefined;

  constructor({ engine, scope = true }: MentionSourceDependencies) {
    super();
    if (!engine)
      throw new Error(
        `${this.constructor.name} requires an IFileSystem instance.`
      );
    this.engine = engine;
    this.searchScope = Array.isArray(scope) ? scope : scope ? ['*'] : undefined;
  }

  protected filterResults = (results: FSNode[]): FSNode[] =>
    results.filter(node => !shouldFilterNode(node));

  protected parseUri(uri: string): string | null {
    if (!uri) return null;
    try {
      return new URL(uri).pathname?.substring(1) || null;
    } catch {
      return null;
    }
  }

  abstract getSuggestions(query: string): Promise<Suggestion[]>;
  abstract getHoverPreview(uri: string): Promise<HoverPreviewData | null>;
}
