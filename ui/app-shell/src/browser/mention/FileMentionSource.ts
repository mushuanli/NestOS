/**
 * @file app-shell/src/browser/mention/FileMentionSource.ts
 */
import { escapeHTML } from '@itookit/common';
import type { FSNode } from '@itookit/vfs-core';
import { type Suggestion, type HoverPreviewData } from './autocomplete-source';
import { BaseMentionSource } from './BaseMentionSource';

export class FileMentionSource extends BaseMentionSource {
  readonly key = 'file';
  readonly triggerChar = '@';

  async getSuggestions(query: string): Promise<Suggestion[]> {
    try {
      const result = await this.engine.driver.search({
        type: 'file',
        name: query ? { contains: query } : undefined,
        limit: 20,
      });
      return this.filterResults(Array.from(result.nodes)).map(node => ({
        id: node.path,
        label: this.formatLabel(node),
        title: node.name,
        type: 'file',
        path: node.path,
        module: node.viewId,
      }));
    } catch (e) {
      console.error('[FileMentionSource] Error:', e);
      return [];
    }
  }

  private formatLabel(node: FSNode): string {
    const parent =
      node.path.substring(0, node.path.lastIndexOf('/')) || '/';
    const ctx = parent === '/' ? '' : ` ${parent}`;
    const mod = node.viewId ? `[${node.viewId}]` : '';
    return `${node.icon || '📄'} ${node.name} (${mod}${ctx})`;
  }

  async getHoverPreview(uri: string): Promise<HoverPreviewData | null> {
    const fileId = this.parseUri(uri);
    if (!fileId) return null;

    try {
      const [node, content] = await Promise.all([
        this.engine.driver.getNode(fileId),
        this.engine.driver.readContent(fileId),
      ]);
      if (!node) return null;

      const text =
        typeof content === 'string'
          ? content
          : new TextDecoder().decode(content as ArrayBuffer);
      const summary =
        text
          .substring(0, 150)
          .replace(/[\r\n]+/g, ' ')
          .replace(/([#*`])/g, '') + (text.length > 150 ? '...' : '');
      const date = new Date(node.modifiedAt).toLocaleDateString();
      const badge = node.viewId
        ? `<span style="background:#eee;padding:2px 4px;border-radius:3px;font-size:0.8em;margin-right:5px;">${node.viewId}</span>`
        : '';

      return {
        title: node.name,
        icon: node.icon || '📄',
        contentHTML: `
          <div class="vfs-hover-preview" style="font-size:0.9em;line-height:1.4;">
            <div style="margin-bottom:6px;color:#666;font-size:0.85em;display:flex;align-items:center;">
              ${badge}<span style="font-family:monospace;">${node.path}</span>
            </div>
            <div style="margin-bottom:8px;color:#333;">${escapeHTML(summary)}</div>
            <div style="color:#999;font-size:0.8em;border-top:1px solid #eee;padding-top:4px;">Updated: ${date}</div>
          </div>`,
      };
    } catch (e) {
      console.error('[FileMentionSource] getHoverPreview error:', e);
      return null;
    }
  }

  async getDataForProcess(targetURL: URL): Promise<any | null> {
    const fileId = targetURL?.pathname?.substring(1);
    if (!fileId) return null;

    try {
      const node = await this.engine.driver.getNode(fileId);
      if (!node) return null;
      const content = await this.engine.driver.readContent(fileId);
      return {
        id: node.path,
        title: node.name,
        content,
        tags: node.tags,
        module: node.viewId,
        path: node.path,
        createdAt: new Date(node.createdAt),
        modifiedAt: new Date(node.modifiedAt),
        ...node.metadata,
      };
    } catch (e) {
      console.warn('[FileMentionSource] Process data fetch failed:', e);
      return null;
    }
  }
}
