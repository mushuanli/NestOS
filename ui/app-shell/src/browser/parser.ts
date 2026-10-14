/**
 * @file app-shell/src/browser/parser.ts
 * @desc Content parsing utility. No internal dependencies except contracts.
 */

import {
  tryParseJson,
  formatJsonSummary,
  parseMarkdown,
} from '@itookit/common';

import type { Heading, TaskCounts } from '@itookit/common';
interface FileMetadata { taskCount?: TaskCounts; clozeCount?: number; mermaidCount?: number; mentions?: Record<string, string[]> }
interface ParseResult { summary: string; searchableText: string; headings: Heading[]; metadata: FileMetadata }

export function parseFileInfo(
  contentString: string | null | undefined
): ParseResult {
  const defaultResult: ParseResult = {
    summary: '',
    searchableText: '',
    headings: [],
    metadata: {},
  };

  if (typeof contentString !== 'string' || !contentString) {
    return defaultResult;
  }

  // 1. JSON 处理
  const json = tryParseJson(contentString);
  if (json) {
    return {
      summary: formatJsonSummary(json),
      searchableText: contentString,
      headings: [],
      metadata: {},
    };
  }

  // 2. 委托给 Common Utils 进行全量解析
  const parsed = parseMarkdown(contentString, {
    extractHeadings: true,
    extractSummary: true,
    extractSearchable: true,
    extractTasks: true,
  });

  // 3. 数据适配 (Adapter)
  const metadata: FileMetadata = {};
  if (parsed.taskCounts) metadata.taskCount = parsed.taskCounts;
  if (parsed.clozeCount > 0) metadata.clozeCount = parsed.clozeCount;
  if (parsed.mermaidCount > 0) metadata.mermaidCount = parsed.mermaidCount;
  if (Object.keys(parsed.mentions).length > 0) metadata.mentions = parsed.mentions;

  return {
    summary: parsed.summary || '',
    searchableText: parsed.searchableText,
    headings: parsed.headings,
    metadata,
  };
}

// 导出辅助函数供其他 VFS 组件直接使用
export { extractTaskCounts } from '@itookit/common';
