// @file: kernel-adapters/llm-management/constants/agents.ts
// Layer 3 — Agent 默认定义（个性化功能定制）。
// Agents define prompts and capabilities independently of model connections.

import type { AgentType, AgentConfig, AgentDefinition, InitialAgentDef } from '@itookit/kernel-adapters/contracts';
import type { PromptPreset } from '@itookit/tools/contracts';

// 向后兼容：从 common 重新导出，避免其他包直接引用 llm-management 内部路径
export type { AgentType, AgentConfig, AgentDefinition, InitialAgentDef };

/** Agent 文件存储根目录 */
export const AGENT_DEFAULT_DIR = '/default';

const DEV_SYSTEM_PROMPT =
    "You are a helpful sinior developer assistant. Follow common development principles " +
    "where relevant including SOLID (Single Responsibility Principle, Open/Closed Principle, " +
    "Liskov Substitution Principle, Interface Segregation Principle, and Dependency Inversion " +
    "Principle), DRY (Don't Repeat Yourself), KISS (Keep It Simple, Stupid), YAGNI (You Ain't " +
    "Gonna Need It), CoC (Convention over Configuration), and LoD (Law of Demeter.)";

    const FEYNMAN_SYSTEM_PROMPT =
    "你是一位体现理查德·费曼简化复杂概念理念的杰出教师。你善于使用更简洁、更清晰、更直观的方式捕捉概念的精髓。";

const FEYNMAN_PROMPTLIST: PromptPreset[] = [
    {
        name: '作文分析',
        prompt: '按照优秀中学生作文标准审查分析下面作文要求和内容， 先进行审题，然后一步一步分析(如果要求命题题目是否合适，)主角是否正确，是否跑题，是否多部分扣题，立意是否深刻，是否详略得当，是否描写生动引起共情，是否突出主旨:'
    },
    {
        name: '作文改进',
        prompt: '参考上面意见，结合优秀作文标准以上面作文为骨架构造，输出订正后完整内容，要求详略得当描写生动感人主旨突出。'
    },
    {
        name: '作文拆解',
        prompt: '拆分文章结构，解析文章写作逻辑：'
    },
    {
        name: '解题思路',
        prompt: '像费曼一样分析题目关键并翻译成知识点，抓住问题的本质，简明清晰输出解题步骤：'
    },
    {
        name: '题型思路(多题)',
        prompt: '像费曼一样审查分析试卷中题目，先抓住所有题目共同点、本质、基本思考方法和步骤，然后使用这个基本方法和步骤去解释每一道题：'
    },
    {
        name: '知识检查',
        prompt: `请使用最小有效线索协议，测试我对[学科]中[主题]的真实掌握程度。
协议：
让我回忆或解释一个概念，但只给最少的提示——刚好让问题合理，又不至于让回忆变得太容易
例如：与其说“解释光合作用的过程”，不如问“叶子完成其主要任务时会发生什么？”

在我回答后，向我展示满分答案的样子，以及我答对了哪些、遗漏了哪些。

追踪一个“生成准确率”分数：我独立生成的必要内容所占的百分比。
针对[主题]提出至少 8 个最小可行线索问题。全部 8 个问题完成后：
生成准确率——我独立生成所需内容的百分比
哪些概念我只能识别，却无法生成？
识别与生成之间的差距——我表面上的知识有多少其实只是熟悉而已？
基于我的生成准确率结果给出的具体学习建议
从最小可行线索问题 1 开始。
记得在提示中填写空白处。`
    }
];

const DEV_PROMPTLIST: PromptPreset[] = [
    {
        name: '代码分析',
        prompt: '审查分析梳理下面代码，分析架构、接口、主要接口/流程的事件流:'
    },
    {
        name: '日志分析',
        prompt: '梳理下面日志， 画出 api 事件流， 找出异常流程:'
    },
];


/**
 * 内置默认 Agent 列表。
 * Connections are selected by the Session or Flow run.
 */
export const DEFAULT_AGENTS: InitialAgentDef[] = [
    // ── 默认 ───────────────────────────────────────────────────────────────────
    {
        id: 'default',
        name: '默认',
        type: 'agent',
        icon: '🤖',
        description: 'A helpful AI assistant',
        initPath: AGENT_DEFAULT_DIR,
        initialTags: ['system', 'default'],
        config: {
            systemPrompt: 'You are a helpful assistant.',
        },
    },

    // ── 编程大师 ────────────────────────────────────────────────────────────────
    {
        id: 'dev-id',
        name: '编程大师',
        type: 'agent',
        icon: '⚡️',
        description: '编程大师：遵循 SOLID / DRY / KISS / YAGNI / CoC / LoD 开发原则',
        initialTags: ['default'],
        initPath: AGENT_DEFAULT_DIR,
        defaultPrompts: DEV_PROMPTLIST,
        config: { systemPrompt: DEV_SYSTEM_PROMPT },
        interface: { inputs: [{ name: 'prompt', type: 'string' }], outputs: [{ name: 'response', type: 'string' }] },
    },



    // ── 费曼大师 ────────────────────────────────────────────────────────────────
    {
        id: 'learn-id',
        name: '费曼大师',
        type: 'agent',
        icon: '⚡️',
        description: '你是一位体现理查德·费曼简化复杂概念理念的杰出教师。',
        initialTags: ['default'],
        initPath: AGENT_DEFAULT_DIR,
        defaultPrompts: FEYNMAN_PROMPTLIST,
        config: { systemPrompt: FEYNMAN_SYSTEM_PROMPT },
        interface: { inputs: [{ name: 'prompt', type: 'string' }], outputs: [{ name: 'response', type: 'string' }] },
    },


];
