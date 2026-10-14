// @file: device-llm/constants/agents.ts
// Layer 3 — Agent 默认定义（个性化功能定制）。
// Agents define prompts and capabilities independently of model connections.

import type { AgentType, AgentConfig, AgentDefinition, InitialAgentDef } from '@itookit/kernel-adapters/contracts';
import type { PromptPreset } from '@itookit/tools/contracts';

// 向后兼容：从 common 重新导出，避免其他包直接引用 device-llm 内部路径
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
        name: '英文单词 Anki',
        prompt: `将下面单词信息转换成MD表格，按照Unit进行分块。请深度挖掘并补充完整缺失的内容（音标、例句、词族、常用搭配、记忆技巧、同义词辨析等），忽略页码等无用信息。
请严格按照以下MD表格模板输出（注意首列是 [ ]，使用 ¶ 表示换行，¶¶ 表示换段，-- 包裹主体内容，^^audio 包裹发音文本）：

| 状态 | 中文释义 | 单词详情 |
| :--- | :--- | :--- |
| [ ] | {chn} | --[{name}] {name}: {symbol} ¶¶ 例句: {example_en} ¶ {example_cn} ¶¶ 词族: {word_family} ¶ 词组: {collocations} ¶ 记忆: {memory_tips} ¶¶ 辨析: {synonym_diff} --^^audio: {name} . {example_en} ^^|

示例：
| 状态 | 中文释义 | 单词详情 |
| :--- | :--- | :--- |
| [ ] | n. 友谊 | --[friendship] friendship: /'fren(d)ʃɪp/ ¶¶ 例句: True friendship is more valuable than money. ¶ 真正的友谊比金钱更珍贵。 ¶¶ 词族: friend(n.朋友), friendly(adj.友好的), befriend(v.与...交朋友) ¶ 词组: form a friendship(建立友谊), cherish friendship(珍惜友谊), lifelong friendship(终身的友谊), friendship bracelet(友谊手链) ¶ 记忆: 由friend(朋友)+ship(表示状态或性质的名词后缀)组成。联想记忆：ship像一艘船，友谊就像一艘承载感情的船。 ¶¶ 辨析: Friendship 强调朋友间的感情，relationship 泛指各种关系，bond 指紧密联系，companionship 强调陪伴，camaraderie 指团队中的同志情谊。 --^^audio: friendship . True friendship is more valuable than money. ^^|
---
`
    },
    {
        name: '英文单词 Anki JSON',
        prompt: `将下面单词信息仿照如下JSON数组格式进行转换，按照Unit进行分块，深度挖掘并补充完整所有缺失的内容，忽略页码等无用信息。请严格输出合法的JSON格式：
    [
        {
            "unit": "Unit 8",
            "words": [
                {
                    "name": "friendship",
                    "chn": "n. 友谊",
                    "symbol": "/'fren(d)ʃɪp/",
                    "example_en": "True friendship is more valuable than money.",
                    "example_cn": "真正的友谊比金钱更珍贵。",
                    "word_family": "friend(n.朋友), friendly(adj.友好的), befriend(v.与...交朋友)",
                    "memory_tips": "由friend(朋友)+ship(表示状态或性质的名词后缀)组成。联想记忆：ship像一艘船，友谊就像一艘承载感情的船。",
                    "difficulty": "2",
                    "collocations": "form a friendship(建立友谊), cherish friendship(珍惜友谊), lifelong friendship(终身的友谊), friendship bracelet(友谊手链)",
                    "image_prompt": "两个不同肤色的青少年在公园里交换友谊手链，背景是蓝天和绿树，他们脸上带着真诚的笑容。",
                    "synonym_diff": {
                        "words": "relationship, bond, companionship, camaraderie",
                        "quick_guide": "Friendship 强调朋友间的感情，relationship 泛指各种关系，bond 指紧密联系，companionship 强调陪伴，camaraderie 指团队中的同志情谊。",
                        "details": []
                    }
                }
            ]
        }
    ]
---
`
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
