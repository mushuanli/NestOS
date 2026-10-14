// @file: common/interfaces/skills/skill-service.ts
// Skill 设备的服务接口定义。

import type {
    SkillDefinition,
    SkillLoadResult,
    SkillRouteLayer,
    SkillMatchContext,
    SkillScopeLevel,
    ParsedCompactInstructions,
    SkillVersionSnapshot,
    SkillVersionDrift,
} from './skill-types';

/**
 * Skill 设备服务接口。
 *
 * 由 kernel-adapters 的 SkillDeviceDriver 实现。
 * 每个 Session 独立管理 Skill 的加载状态。
 */
export interface ISkillService {
    /** 获取所有已注册的 Skill 定义 */
    listSkills(): SkillDefinition[];

    /** 获取指定 Skill */
    getSkill(id: string): SkillDefinition | undefined;

    /** 获取所有 Skill 名称（用于 load_skill 提示） */
    getSkillNames(): string[];

    /**
     * 加载 Skill 到当前会话。
     *
     * 会将 Skill 的工具注册到 device-tools，
     * 并返回加载结果（包含新增的工具列表）。
     */
    loadSkill(id: string): Promise<SkillLoadResult>;
    /** Explicit host reload; ordinary model loads must respect the existing pin. */
    reloadSkill?(id: string): Promise<SkillLoadResult>;
    restoreSkillSnapshot?(snapshot: SkillVersionSnapshot): Promise<SkillLoadResult>;
    getSkillSnapshot?(id: string): SkillVersionSnapshot | undefined;
    getSkillDrifts?(): Record<string, SkillVersionDrift>;

    /**
     * 卸载 Skill。
     *
     * 从 device-tools 中移除 Skill 的工具。
     */
    unloadSkill(id: string): Promise<void>;

    /**
     * 获取已加载的 Skill 列表（用于 prompt 注入） */
    getLoadedSkills(): SkillDefinition[];

    /**
     * 获取尚未加载的 Skill 列表（用于提示 LLM 可用的 Skill）
     */
    getUnloadedSkills(): SkillDefinition[];

    /**
     * 根据任务 prompt 自动检测应加载的 Skill。
     */
    autoDetectSkills(prompt: string): string[];

    // ── CRUD（持久化管理）──
    saveSkill(skill: SkillDefinition): Promise<void>;
    deleteSkill(id: string): Promise<void>;

    /** 监听变化 */
    onChange(listener: () => void): () => void;

    // ── 四层路由 ──

    /**
     * 返回四层路由分类（L1 silent / L2 index / L3 dynamicMount / L4 spatial）。
     * 由上下文组装消费；接口本身不触发 Prompt 注入。
     */
    getRouteLayers(): SkillRouteLayer;

    /**
     * 语义匹配：给定用户消息和上下文，返回应加载的 skill id 列表。
     *
     * 优先级：triggerPatterns(regex) → 关键词重叠(≥2) → globs(openFiles)
     */
    semanticMatchSkills(userMessage: string, context?: SkillMatchContext): string[];

    /**
     * 文件打开时触发 Glob 挂载（L4 层）。
     * 若文件路径匹配某 skill 的 globs，将该 skill 标记为已挂载并加载。
     */
    mountByGlob(filePath: string): void;

    /**
     * 文件关闭时触发 Glob 卸载（L4 层）。
     * 若该 skill 无更多匹配文件，从已加载集合移除。
     */
    unmountByGlob(filePath: string): void;

    /**
     * 扫描指定目录下的 skill 子目录，注册为文件系统 skill。
     * 已注册的 skill 幂等（覆盖更新）。
     */
    registerFromDirectory(
        dirPath: string,
        scopeLevel: SkillScopeLevel,
        scopeRoot: string
    ): Promise<SkillLoadResult[]>;

    // ── Compact Instructions ──

    /** 解析单个 skill 的 compact instructions */
    parseCompactInstructions(skillId: string): ParsedCompactInstructions;

    /**
     * 聚合当前作用域内已加载、启用且允许模型调用的压缩规则。
     * 调用方负责将结果接入压缩提示词。
     */
    getCompactInstructions(): string;

    // ── 作用域管理 ──

    /**
     * 设置当前工作目录，触发作用域重建。
     *
     * 通过宿主 SkillSource 刷新；迟到的旧扫描不会覆盖新作用域。
     */
    setCwd(cwd: string): Promise<void>;

    /**
     * 返回当前作用域可见的 skill 列表（已过滤不在作用域内的 skill）。
     */
    getScopedSkills(): SkillDefinition[];

    /**
     * 重新扫描当前作用域条目，卸载失效 skill，加载新 skill。
     */
    refreshScopedSkills(): Promise<SkillLoadResult[]>;

    /**
     * 返回当前项目的 _agent/AGENT.md 内容。
     * 由调用方决定如何注入当前上下文。
     * 无 AGENT.md 或浏览器环境时返回空字符串。
     */
    getAgentMdContent(): string;
}

/** Host-owned controls for persisted Skill selections in a single Session. */
export interface SessionSkillControls {
    list(sessionId: string): ReturnType<SessionSkillControls['listLoaded']>;
    load(sessionId: string, skillId: string): Promise<string[]>;
    listLoaded(sessionId: string): Promise<Array<{ id: string; name: string; description: string; loaded: boolean; enabled: boolean; definitionEnabled: boolean; toolCount: number; toolIds?: string[];
        versionDigest?: string; versionPolicy?: import('./skill-types').SkillVersionPolicy; drift?: SkillVersionDrift; unversioned?: boolean }>>;
    /**
     * Read one Skill definition for an explicit invocation (`/sk-<id>`).
     *
     * Action and silent Skills cannot go through `load` (the model-context gate rejects them),
     * so the caller needs the instructions to inline them into the user message instead.
     */
    describe(sessionId: string, skillId: string): Promise<{ name: string; type: string; instructions: string; triggerStrategy?: 'reference' | 'action'; disableModelInvocation?: boolean; enabled: boolean } | undefined>;
    unload(sessionId: string, skillId: string): Promise<void>;
    /**
     * L4 editor wiring: a file became the active editor target. Skills whose `globs` match
     * get mounted for this Session only; the mount is transient (it is not written to the
     * persisted loaded identities), so closing the editor releases it again.
     */
    mountByGlob(sessionId: string, filePath: string): Promise<void>;
    /** The file is no longer open: drop it, and unmount Skills without another match. */
    unmountByGlob(sessionId: string, filePath: string): Promise<void>;
    /**
     * Subscribe to catalog/scope changes of a Session's live Skill scope (a Skill file was
     * written, the scope was refreshed, …). Resolves to the unsubscribe function; hosts use
     * it to refresh a visible Skill list without polling.
     */
    onChange(sessionId: string, listener: () => void): Promise<() => void>;
}
