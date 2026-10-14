// Tool service and host execution ports.
// Owned by @itookit/tools; legacy shared packages forward these types.

import type { ToolMeta, ToolInvokeRequest, ToolInvokeResult, ToolBatchResult } from './tool-types';
import type { ToolDefinition } from '@itookit/llm-context';

/**
 * 工具设备服务接口。
 *
 * 由 device-tools 的 ToolDeviceDriver 实现。
 * llm-agent 的 ToolExecutor 通过此接口（或设备文件 ioctl）调用工具。
 */
export interface IToolService {
    /** 获取所有已注册工具的元数据列表 */
    listTools(): ToolMeta[];

    /** 获取指定工具的元数据 */
    getToolMeta(id: string): ToolMeta | undefined;

    /** 获取所有已启用工具的 LLM ToolDefinition（用于发送给模型） */
    getToolDefinitions(): ToolDefinition[];

    /** 执行单个工具调用 */
    invoke(request: ToolInvokeRequest): Promise<ToolInvokeResult>;

    /**
     * 批量执行工具调用。
     *
     * 并行策略：
     * - sideEffect='none' 的工具可以并行执行
     * - sideEffect='local'/'external' 的工具串行执行
     */
    invokeBatch(requests: ToolInvokeRequest[]): Promise<ToolBatchResult>;

    /** 注册外部工具（插件扩展用） */
    registerTool(meta: ToolMeta, definition: ToolDefinition, handler: ToolHandler): void;

    /** 注销工具 */
    unregisterTool(id: string): void;
}

/**
 * 工具执行处理器。
 *
 * 每个具体工具实现此函数签名。
 * 返回字符串形式的输出，直接作为 LLM 的 tool_result content。
 *
 * 所有异常都应在内部捕获并返回 error 描述字符串，
 * 而不是向外抛出（Agent 循环要求工具异常不传播）。
 */
export type ToolHandler = (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
) => Promise<string>;

/**
 * 工具执行上下文。
 *
 * 工具处理器执行时的环境信息。
 */
/**
 * 浏览器环境下的虚拟文件系统访问接口。
 *
 * 当 node:fs/promises 不可用时（browser build），工具通过此接口
 * 访问 vfslib 中的虚拟文件，而非本地真实文件系统。
 *
 * 路径格式：VFS 模块相对路径，如 `/notes.md`、`subdir/file.ts`。
 * `cwd` 是当前模块的 VFS 根路径，由调用方注入。
 */
export interface ToolVFSContext {
    /** 读取 VFS 文件，返回 UTF-8 字符串。 */
    readFile(path: string, options?: { maxBytes?: number }): Promise<string>;
    /** 写入 VFS 文件（upsert 语义）。 */
    writeFile(path: string, content: string): Promise<void>;
    /**
     * 列出路径下所有文件（递归），返回相对路径列表。
     * Discovery respects .gitignore/.mindosignore by default. includeIgnored only
     * changes discovery filtering; it never grants access to additional files.
     */
    listFiles(dir?: string, options?: { includeIgnored?: boolean; excludeDirectories?: readonly string[]; signal?: AbortSignal }): Promise<string[]>;
    /** Lazy discovery; consumers can stop traversal as soon as their result budget is full. */
    walkFiles?(dir?: string, options?: { includeIgnored?: boolean; excludeDirectories?: readonly string[]; signal?: AbortSignal }): AsyncIterable<string>;
    /**
     * 查询单一路径的节点类型（不递归），不存在返回 null。
     *
     * 用于校验工作目录之类的存在性检查：`listFiles` 会递归遍历整棵树，
     * 对大目录（如仓库根）代价极高，不适合作为存在性判断。
     */
    stat?(path: string): Promise<'file' | 'directory' | 'seqfile' | 'device' | 'symlink' | null>;
}

export interface ToolExecutionContext {
    onProgress?: (progress: import('./tool-types').ToolProgress) => Promise<void>;
    /** 工作目录（Node.js 真实路径 或 VFS 模块相对路径） */
    cwd: string;
    /** 取消信号 */
    signal?: AbortSignal;
    /** 超时（毫秒） */
    timeoutMs: number;
    /**
     * 虚拟文件系统访问（仅在浏览器环境且 VFS 可用时注入）。
     *
     * 工具应优先检查此字段：有则走 VFS，无则走 node:fs/promises。
     * 这样同一套工具代码同时支持 Node.js（真实 FS）和浏览器（VFS）。
     */
    vfs?: ToolVFSContext;
}
