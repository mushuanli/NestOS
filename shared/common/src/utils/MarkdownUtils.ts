/**
 * @file @itookit/common/utils/MarkdownUtils.ts
 * @description 统一的 Markdown 解析工具库 - 零依赖纯函数
 */

import type { Heading } from '../types/heading';

// ============================================================================
// 类型定义
// ============================================================================


export interface TaskCounts {
  total: number;
  completed: number;
}

export interface ParsedMarkdownContent {
  /** 代码块外的行（保留行结构） */
  linesOutsideCode: string[];
  /** 代码块外的纯文本（已移除行内代码） */
  textOutsideCode: string;
  /** 原始行数组 */
  allLines: string[];
}

export type MentionMap = Record<string, string[]>;

export interface MarkdownMetadata {
  headings: Heading[];
  summary: string | null;
  searchableText: string;
  taskCounts: TaskCounts | null;
  clozeCount: number;
  mermaidCount: number;
  mentions: MentionMap;
}

export interface ParseOptions {
  extractHeadings?: boolean;
  extractSummary?: boolean;
  extractTasks?: boolean;
  extractSearchable?: boolean;
  summaryMaxLength?: number;
  debug?: boolean;
}

// ============================================================================
// 核心工具函数
// ============================================================================

/**
 * 生成 URL 友好的 slug
 * @description 相比旧版，增加了对中文的支持，并优化了标点处理
 */
export function slugify(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[\s\-_]+/g, '-')      // 空白和连字符统一为单个 -
    .replace(/[^\w\u4e00-\u9fa5-]/g, '') // 保留字母数字中文和连字符
    .replace(/^-+|-+$/g, '');        // 移除首尾连字符
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 尝试解析 JSON 字符串
 */
export function tryParseJson(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }
  
  if (
    (trimmed.startsWith('{') && !trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && !trimmed.endsWith(']'))
  ) {
    return null;
  }
  
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// ============================================================================
// 代码块过滤
// ============================================================================

/**
 * 解析 Markdown 内容，过滤代码块
 */
export function parseMarkdownContent(content: string): ParsedMarkdownContent {
  const allLines = content.split('\n');
  const linesOutsideCode: string[] = [];
  
  let inCodeBlock = false;
  let codeBlockMarker = '';
  let codeBlockMarkerLength = 0;

  for (const line of allLines) {
    // 检测围栏代码块边界（支持 ``` 和 ~~~，至少3个字符）
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    
    if (fenceMatch) {
      const marker = fenceMatch[1].charAt(0);
      const markerLength = fenceMatch[1].length;
      
      if (!inCodeBlock) {
        // 进入代码块
        inCodeBlock = true;
        codeBlockMarker = marker;
        codeBlockMarkerLength = markerLength;
      } else if (
        marker === codeBlockMarker && 
        markerLength >= codeBlockMarkerLength &&
        line.trim() === fenceMatch[1] // 结束行只能是纯围栏符号
      ) {
        // 退出代码块
        inCodeBlock = false;
        codeBlockMarker = '';
        codeBlockMarkerLength = 0;
      }
      // 围栏行本身不加入结果
      continue;
    }
    
    if (!inCodeBlock) {
      linesOutsideCode.push(line);
    }
  }

  // 生成纯文本（移除行内代码）
  const textOutsideCode = linesOutsideCode
    .join('\n')
    .replace(/`[^`\n]+`/g, ''); // 移除行内代码，但不跨行

  return {
    allLines,
    linesOutsideCode,
    textOutsideCode,
  };
}

// ============================================================================
// 标题提取
// ============================================================================

/**
 * 从 Markdown 内容中提取标题
 */
export function extractHeadings(
  content: string,
  options: { nested?: boolean } = {}
): Heading[] {
  const { nested = false } = options;
  const { linesOutsideCode } = parseMarkdownContent(content);
  
  const headings: Heading[] = [];
  const slugCount = new Map<string, number>();
  const stack: Heading[] = [];

  for (const line of linesOutsideCode) {
    // 匹配 1-6 级标题
    const match = line.match(/^(#{1,6})\s+(.+)/);
    
    if (!match) continue;
    
    const level = parseInt(match[1].length.toString()); // 确保是 number
    const text = match[2].trim();
    
    if (!text) continue;
    
    // 生成唯一 ID
    const rawSlug = slugify(text);
    const baseSlug = `heading-${rawSlug}`;
    const count = slugCount.get(baseSlug) || 0;
    slugCount.set(baseSlug, count + 1);
    const id = count > 0 ? `${baseSlug}-${count}` : baseSlug;
    
    const heading: Heading = { level, text, id, children: [] };
    
    if (nested) {
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      
      if (stack.length === 0) {
        headings.push(heading);
      } else {
        // 父节点一定有 children 数组
        stack[stack.length - 1].children.push(heading);
      }
      
      stack.push(heading);
    } else {
      headings.push(heading);
    }
  }
  
  return headings;
}

// ============================================================================
// 任务统计
// ============================================================================

export function extractTaskCounts(
  content: string,
  _options: { debug?: boolean } = {}
): TaskCounts {
  const { textOutsideCode } = parseMarkdownContent(content);
  
  let total = 0;
  let completed = 0;

  // Markdown 任务语法
  const mdRegex = /(?:^|[\s|])(?:[-+*]|\d+\.)?\s*\[([ xX])\]/gm;
  const mdMatches = [...textOutsideCode.matchAll(mdRegex)];
  total += mdMatches.length;
  completed += mdMatches.filter(m => m[1].toLowerCase() === 'x').length;

  // HTML 复选框
  const htmlRegex = /<input[^>]+type=["']checkbox["'][^>]*>/gi;
  const htmlMatches = [...textOutsideCode.matchAll(htmlRegex)];
  
  total += htmlMatches.length;
  for (const match of htmlMatches) {
    if (/\bchecked\b/i.test(match[0])) {
      completed++;
    }
  }

  return { total, completed };
}

// ============================================================================
// 摘要提取
// ============================================================================

export function extractSummary(
  content: string,
  maxLength: number = 150
): string | null {
  // 1. JSON 处理 (Chat Manifest 等)
  const json = tryParseJson(content);
  if (isRecord(json)) {
    const obj = json;
    
    if (typeof obj.description === 'string') return obj.description;
    if (typeof obj.summary === 'string') return obj.summary;
    
    // Chat 格式
    if (Array.isArray(obj.pairs) && obj.pairs.length > 0) {
      const firstPair = obj.pairs[0];
      if (isRecord(firstPair) && typeof firstPair.human === 'string') {
        return firstPair.human;
      }
    }
    return null;
  }

  // 2. Markdown 处理
  const { linesOutsideCode } = parseMarkdownContent(content);
  
  for (const line of linesOutsideCode) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) continue; // Skip headings
    if (/^[-*_]{3,}$/.test(trimmed)) continue; // Skip HR
    if (trimmed === '---') continue; // Skip frontmatter marker
    
    const cleaned = trimmed
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')  // links -> text
      .replace(/!\[.*?\]\(.*?\)/g, '')      // remove images
      .replace(/[*_~`]/g, '')              // remove format chars
      .trim();
    
    if (cleaned) {
      return cleaned.length > maxLength 
        ? cleaned.substring(0, maxLength) + '…' 
        : cleaned;
    }
  }
  
  return null;
}

// ============================================================================
// 可搜索文本
// ============================================================================

export function extractSearchableText(content: string): string {
  // JSON 处理
  const json = tryParseJson(content);
  if (isRecord(json)) {
    const obj = json;
    const parts: string[] = [];
    
    if (typeof obj.name === 'string') parts.push(obj.name);
    if (typeof obj.title === 'string') parts.push(obj.title);
    if (typeof obj.description === 'string') parts.push(obj.description);
    if (typeof obj.summary === 'string') parts.push(obj.summary);
    
    if (Array.isArray(obj.pairs)) {
      for (const pair of obj.pairs) {
        if (!isRecord(pair)) continue;
        if (typeof pair.human === 'string') parts.push(pair.human);
        if (typeof pair.ai === 'string') parts.push(pair.ai);
      }
    }
    return parts.join('\n');
  }

  // Markdown 处理
  const { linesOutsideCode } = parseMarkdownContent(content);
  
  return linesOutsideCode
    .join('\n')
    .replace(/^#{1,6}\s+/gm, '')           
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')    
    .replace(/!\[.*?\]\(.*?\)/g, '')       
    .replace(/`[^`\n]+`/g, '')             
    .replace(/[*_~]+/g, '')                
    .replace(/^\s*[-+*]\s+/gm, '')         
    .replace(/^\s*\d+\.\s+/gm, '')         
    .replace(/^\s*>\s+/gm, '')             
    .replace(/\|/g, ' ')                   
    .replace(/\s+/g, ' ')                  
    .trim();
}

// ============================================================================
// 杂项统计与工具
// ============================================================================

export function extractClozeCount(content: string): number {
  const matches = content.match(/--/g) || [];
  return Math.floor(matches.length / 2); // 假设 --cloze-- 成对出现
}

export function extractMermaidCount(content: string): number {
  const matches = content.match(/```mermaid/gi) || [];
  return matches.length;
}

/**
 * Extract @type:id mentions from content.
 * Supports both @user:alice and [text](mdx://type/id) forms.
 * Pure regex extraction — no provider resolution needed for metadata purposes.
 */
function extractMentions(content: string): MentionMap {
  const regex = /@(\w+):([\w-]+)|\[[^\]]+\]\(mdx:\/\/(\w+)\/([^)]+)\)/g;
  const mentions: MentionMap = {};
  for (const match of content.matchAll(regex)) {
    const type = match[1] ?? match[3];
    const id = match[2] ?? match[4];
    if (!type || !id) continue;
    if (!mentions[type]) mentions[type] = [];
    if (!mentions[type].includes(id)) mentions[type].push(id);
  }
  return mentions;
}

const DEFAULT_PARSE_OPTIONS: Required<ParseOptions> = {
  extractHeadings: true,
  extractSummary: true,
  extractTasks: true,
  extractSearchable: true,
  summaryMaxLength: 150,
  debug: false,
};

export function parseMarkdown(
  content: string,
  options: ParseOptions = {}
): MarkdownMetadata {
  const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };
  
  if (!content || typeof content !== 'string') {
    return { headings: [], summary: null, searchableText: '', taskCounts: null, clozeCount: 0, mermaidCount: 0, mentions: {} };
  }

  const result: MarkdownMetadata = {
    headings: [],
    summary: null,
    searchableText: '',
    taskCounts: null,
    clozeCount: 0,
    mermaidCount: 0,
    mentions: {},
  };

  if (opts.extractHeadings) result.headings = extractHeadings(content, { nested: true });
  if (opts.extractSummary) result.summary = extractSummary(content, opts.summaryMaxLength);
  if (opts.extractSearchable) result.searchableText = extractSearchableText(content);
  if (opts.extractTasks) {
    const counts = extractTaskCounts(content, { debug: opts.debug });
    if (counts.total > 0) result.taskCounts = counts;
  }

  result.clozeCount = extractClozeCount(content);
  result.mermaidCount = extractMermaidCount(content);
  result.mentions = extractMentions(content);

  return result;
}

export function formatJsonSummary(json: unknown): string {
  if (Array.isArray(json)) return `[List: ${json.length} items]`;
  if (!isRecord(json)) return String(json);

  const keys = Object.keys(json);
  const parts: string[] = [];
  const priorityKeys = ['title', 'name', 'description', 'desc', 'summary', 'type', 'id', 'status'];
  
  const sortedKeys = keys.sort((a, b) => {
    const idxA = priorityKeys.indexOf(a);
    const idxB = priorityKeys.indexOf(b);
    if (idxA > -1 && idxB > -1) return idxA - idxB;
    if (idxA > -1) return -1;
    if (idxB > -1) return 1;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    if (parts.length >= 4) break;
    const val = json[key];
    if (typeof val === 'string') {
      parts.push(`${key}: ${val.length > 30 ? val.substring(0, 30) + '...' : val}`);
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      parts.push(`${key}: ${val}`);
    } else if (Array.isArray(val)) {
      parts.push(`${key}: [${val.length}]`);
    } else if (val === null) {
      parts.push(`${key}: null`);
    }
  }
  
  return parts.length > 0 ? parts.join(' | ') : '{ ... }';
}
