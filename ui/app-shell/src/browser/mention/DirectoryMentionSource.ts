/**
 * @file app-shell/src/browser/mention/DirectoryMentionSource.ts
 */
import { type Suggestion, type HoverPreviewData } from './autocomplete-source';
import { BaseMentionSource, MentionSourceDependencies } from './BaseMentionSource';

export type DirectorySourceDependencies = MentionSourceDependencies;

export class DirectoryMentionSource extends BaseMentionSource {
  readonly key = 'dir';
  readonly triggerChar = '@';

  async getSuggestions(query: string): Promise<Suggestion[]> {
    try {
      const result = await this.engine.driver.search({
        type: 'directory',
        name: query ? { contains: query } : undefined,
        limit: 20,
      });
      return this.filterResults(Array.from(result.nodes)).map(node => ({
        id: node.path,
        label: `${node.icon || '📁'} ${node.name} (${node.viewId ? `[${node.viewId}] ` : ''}${node.path})`,
        title: node.name,
        type: 'directory',
        path: node.path,
        module: node.viewId,
      }));
    } catch (e) {
      console.error('[DirectoryMentionSource] Error:', e);
      return [];
    }
  }

  async getHoverPreview(uri: string): Promise<HoverPreviewData | null> {
    const dirId = this.parseUri(uri);
    if (!dirId) return null;

    try {
      const node = await this.engine.driver.getNode(dirId);
      if (!node) return null;

      const childText = node.type === 'directory' && node.childCount != null
        ? `Contains ${node.childCount} items`
        : 'Contents info not available';
      return {
        title: node.name,
        icon: node.icon || '📁',
        contentHTML: `<div class="vfs-dir-preview"><div class="vfs-meta" style="font-size:0.8em;color:#888;margin-bottom:4px;">${node.path}</div><p>${childText}</p></div>`,
      };
    } catch (e) {
      console.error('[DirectoryMentionSource] getHoverPreview error:', e);
      return null;
    }
  }
}
