// @file: common/interfaces/skills/fs-skill-types.ts
// 文件系统 Skill 相关类型：SKILL.md frontmatter、目录信息、作用域条目。

import type { CompactSection, SkillTaskProgramRef } from './skill-types';

/**
 * SKILL.md YAML frontmatter 字段（kebab-case，与 YAML 键名一致）。
 */
export interface SkillFrontmatter {
    name: string;
    description: string;
    /** 触发策略：reference（语义/glob 自动触发）| action（仅手动 slash 命令） */
    'trigger-strategy'?: 'reference' | 'action';
    /**
     * 显式覆盖 reference 的自动加载：`false` 表示仍可被显式加载（load_skill / 面板 / `/sk-<id>`）
     * 并登记持久加载身份，但新运行不因策略自动注入。缺省时沿用 `trigger-strategy` 推导值。
     */
    'auto-load'?: boolean;
    'version-policy'?: import('./skill-types').SkillVersionPolicy;
    /** 禁止模型通过 load_skill 加载（action skill 专用） */
    'disable-model-invocation'?: boolean;
    /** Glob 模式列表，匹配打开文件时自动挂载（L4 空间联动） */
    globs?: string[];
    /** 按需加载的背景知识文件路径（相对 skill 目录） */
    references?: string[];
    /** 输出模板文件路径（相对 skill 目录） */
    template?: string;
    /** 修正日志文件路径（相对项目根） */
    'correction-log'?: string;
    /** 加载优先级（越小越优先），默认 50 */
    priority?: number;
    /** Subagent 委托配置 */
    subagent?: {
        role: string;
        model?: string;
    };
    /** 多步 Skill 对应的 Durable TaskProgram。 */
    'task-program'?: SkillTaskProgramRef;
}

/**
 * 已解析的文件系统 Skill 目录信息。
 */
export interface FSSkillDirectory {
    /** Skill 目录绝对路径（e.g. /project/_agent/skills/rest-api） */
    dirPath: string;
    /** 由 name 派生的 skill id（name 转 kebab-case） */
    skillId: string;
    /** 解析后的 frontmatter */
    frontmatter: SkillFrontmatter;
    /** body 内容（不含 Compact Instructions 区块） */
    instructions: string;
    /** 提取的 Compact Instructions（若存在） */
    compact?: CompactSection;
}

/**
 * 作用域继承链条目。
 * 由 buildScopeEntries() 构建，描述从项目根到当前 CWD 的 skill 目录链。
 */
export interface ScopeEntry {
    /** _agent/skills/ 目录的绝对路径 */
    dirPath: string;
    /** 作用域层级 */
    scopeLevel: 'global-fs' | 'parent-fs' | 'local-fs';
    /** 该条目所属目录的绝对路径（用于 isSkillInScope() 比较） */
    scopeRoot: string;
}
