// @file: device-llm/constants/providers.ts
// Layer 1 — Provider 目录（云提供商定义 + 模型 catalog）。
// 职责：持有 apiKey + 模型目录，是认证与模型信息的唯一来源。

import type { LLMProvider } from '@itookit/driver-llm/contracts';
import { externalProviders } from './llm-configs';

// ─── VFS 存储路径 ──────────────────────────────────────────────────────────────
/** VFS __config 模块中 Provider 数据的存储目录 */
export const PROVIDERS_DIR = '/llm/.providers';

// ─── 定价常量（每百万 token，USD）───────────────────────────────────────────────

const P = {
    // Claude 系列
    CLAUDE_FABLE_IN: 10.0, CLAUDE_FABLE_OUT: 50.0,
    CLAUDE_FABLE_CACHE_WRITE: 12.50, CLAUDE_FABLE_CACHE_READ: 1.0,
    CLAUDE_OPUS_IN: 5.0, CLAUDE_OPUS_OUT: 25.0,
    CLAUDE_OPUS_CACHE_WRITE: 6.25, CLAUDE_OPUS_CACHE_READ: 0.5,
    CLAUDE_SONNET_IN: 3.0, CLAUDE_SONNET_OUT: 15.0,
    CLAUDE_SONNET_CACHE_WRITE: 3.75, CLAUDE_SONNET_CACHE_READ: 0.3,
    CLAUDE_HAIKU_IN: 0.8, CLAUDE_HAIKU_OUT: 4.0,
    CLAUDE_HAIKU_CACHE_WRITE: 1.0, CLAUDE_HAIKU_CACHE_READ: 0.08,

    // GPT 系列
    GPT_PRO_IN: 5, GPT_PRO_OUT: 15,
    GPT_MINI_IN: 0.15, GPT_MINI_OUT: 0.6,

    // Gemini 系列
    GEMINI_PRO_IN: 1.25, GEMINI_PRO_OUT: 10,
    GEMINI_FLASH_IN: 0.15, GEMINI_FLASH_OUT: 0.6,

    // DeepSeek 系列
    DEEPSEEK_PRO_IN: 0.4286, DEEPSEEK_PRO_OUT: 0.8571,
    DEEPSEEK_PRO_CACHE_WRITE: 0.4286, DEEPSEEK_PRO_CACHE_READ: 0.0036,
    DEEPSEEK_FLASH_IN: 0.1429, DEEPSEEK_FLASH_OUT: 0.2857,
    DEEPSEEK_FLASH_CACHE_WRITE: 0.1429, DEEPSEEK_FLASH_CACHE_READ: 0.0029,

    // OpenRouter 系列（含代理溢价）
    LLAMA4_MAVERICK_IN: 0.4, LLAMA4_MAVERICK_OUT: 0.8,
    MISTRAL_LARGE_IN: 2, MISTRAL_LARGE_OUT: 6,

    // Doubao 系列
    DOUBAO_VISION_IN: 0.11, DOUBAO_VISION_OUT: 0.28,
    DOUBAO_PRO_IN: 0.08, DOUBAO_PRO_OUT: 0.28,
    DOUBAO_LITE_IN: 0.04, DOUBAO_LITE_OUT: 0.14,
} as const;

// ─── 内置 Pricing 表 ──────────────────────────────────────────────────────────
//
// 将同族模型（跨 provider、跨版本小升级）归为同一 pricing id。
// price = [input, output, cache_write, cache_read]，单位 USD/M tokens。
//
// 匹配优先级（lookupPricingEntry）：
//   1. providers.{providerId} 精确匹配 modelId
//   2. names[] 通配符匹配 modelId（支持 *）
//   3. default fallback
//
// providers.<name> = []        → 该 provider 下的实际 model id = 逻辑 id 本身
// providers.<name> = ["a","b"] → 路由使用 "a"，反向查找匹配 "a" 或 "b"
// key absent                   → 该 provider 不支持此模型
//
// 此常量同时作为 pricing.json 不存在时的编译期 fallback，
// 以及首次启动时写入 /llm/pricing.json 的默认内容。

import type { ModelPricingEntry } from '@itookit/kernel-adapters/contracts';

export const MODEL_PRICING: ModelPricingEntry[] = [
    {
        id: 'claude-fable',
        price: [P.CLAUDE_FABLE_IN, P.CLAUDE_FABLE_OUT, P.CLAUDE_FABLE_CACHE_WRITE, P.CLAUDE_FABLE_CACHE_READ],
        providers: { anthropic: ['claude-fable-5'] },
        names: ['claude-fable*'],
    },
    {
        id: 'claude-opus',
        price: [P.CLAUDE_OPUS_IN, P.CLAUDE_OPUS_OUT, P.CLAUDE_OPUS_CACHE_WRITE, P.CLAUDE_OPUS_CACHE_READ],
        providers: { anthropic: ['claude-opus-4-8'] },
        names: ['claude*opus*'],
    },
    {
        id: 'claude-sonnet5',
        price: [P.CLAUDE_SONNET_IN, P.CLAUDE_SONNET_OUT, P.CLAUDE_SONNET_CACHE_WRITE, P.CLAUDE_SONNET_CACHE_READ],
        providers: { anthropic: ['claude-sonnet-5'] },
        names: ['claude-sonnet-5*'],
    },
    {
        id: 'claude-sonnet',
        price: [P.CLAUDE_SONNET_IN, P.CLAUDE_SONNET_OUT, P.CLAUDE_SONNET_CACHE_WRITE, P.CLAUDE_SONNET_CACHE_READ],
        providers: { anthropic: ['claude-sonnet-4-6'], openrouter: ['anthropic/claude-sonnet-4.6'] },
        names: ['claude-sonnet-4*'],
    },
    {
        id: 'claude-haiku',
        price: [P.CLAUDE_HAIKU_IN, P.CLAUDE_HAIKU_OUT, P.CLAUDE_HAIKU_CACHE_WRITE, P.CLAUDE_HAIKU_CACHE_READ],
        providers: { anthropic: ['claude-haiku-4-5'] },
        names: ['claude-haiku-*'],
    },
    {
        id: 'deepseek-v4-pro',
        price: [P.DEEPSEEK_PRO_IN, P.DEEPSEEK_PRO_OUT, P.DEEPSEEK_PRO_CACHE_WRITE, P.DEEPSEEK_PRO_CACHE_READ],
        providers: { deepseek: [] },
    },
    {
        id: 'deepseek-v4-flash',
        price: [P.DEEPSEEK_FLASH_IN, P.DEEPSEEK_FLASH_OUT, P.DEEPSEEK_FLASH_CACHE_WRITE, P.DEEPSEEK_FLASH_CACHE_READ],
        providers: { deepseek: [] },
    },
    {
        id: 'gpt-pro',
        price: [P.GPT_PRO_IN, P.GPT_PRO_OUT, 0, 0],
        providers: {
            openai:     ['gpt-5.5', 'gpt-5-pro', 'gpt-5-codex'],
            openrouter: ['openai/gpt-5.5', 'openai/gpt-5-pro'],
            cloudapi:   ['gpt-5.5'],
        },
    },
    {
        id: 'gpt-mini',
        price: [P.GPT_MINI_IN, P.GPT_MINI_OUT, 0, 0],
        providers: {
            openai: ['gpt-5-mini'],
        },
    },
    {
        id: 'gemini-pro',
        price: [P.GEMINI_PRO_IN, P.GEMINI_PRO_OUT, 0, 0],
        providers: {
            gemini:     ['gemini-3.1-pro'],
            cloudapi:   ['gemini-3.1-pro'],
            openrouter: ['google/gemini-3.1-pro'],
        },
    },
    {
        id: 'gemini-flash',
        price: [P.GEMINI_FLASH_IN, P.GEMINI_FLASH_OUT, 0, 0],
        providers: {
            gemini:     ['gemini-3.5-flash'],
            cloudapi:   ['gemini-3.5-flash'],
            openrouter: ['google/gemini-3.5-flash'],
        },
    },
    {
        id: 'llama4-maverick',
        price: [P.LLAMA4_MAVERICK_IN, P.LLAMA4_MAVERICK_OUT, 0, 0],
        providers: { openrouter: ['meta-llama/llama-4-maverick'] },
    },
    {
        id: 'mistral-large',
        price: [P.MISTRAL_LARGE_IN, P.MISTRAL_LARGE_OUT, 0, 0],
        providers: { openrouter: ['mistralai/mistral-large-2411'] },
    },
    {
        id: 'doubao-vision',
        price: [P.DOUBAO_VISION_IN, P.DOUBAO_VISION_OUT, 0, 0],
        providers: { volcengine: ['doubao-seed-2-0-pro-260215'] },
    },
    {
        // volcengine 通过方舟代理的 deepseek-v4-pro 使用火山方舟 PRO 价格
        id: 'doubao-pro',
        price: [P.DOUBAO_PRO_IN, P.DOUBAO_PRO_OUT, 0, 0],
        providers: { volcengine: ['doubao-seed-2-0-code-preview-260215', 'deepseek-v4-pro-260425'] },
    },
    {
        // volcengine 通过方舟代理的 deepseek-v4-flash 使用火山方舟 LITE 价格
        id: 'doubao-lite',
        price: [P.DOUBAO_LITE_IN, P.DOUBAO_LITE_OUT, 0, 0],
        providers: { volcengine: ['doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428', 'deepseek-v4-flash-260425'] },
    },
    {
        // Global fallback: used when no other entry matches by providers or names.
        id: 'default',
        price: [0, 0, 0, 0],
        providers: {},
    },
];

// ─── 模型显示名称常量 ──────────────────────────────────────────────────────────

// Claude
export const MODEL_NAME_CLAUDE_48_OPUS = 'Claude Opus 4.8';
export const MODEL_NAME_CLAUDE_46_OPUS = 'Claude Opus 4.6';
export const MODEL_NAME_CLAUDE_46_SONNET = 'Claude Sonnet 4.6';
export const MODEL_NAME_CLAUDE_45_HAIKU = 'Claude Haiku 4.5';

// GPT
export const MODEL_NAME_GPT55 = 'GPT-5.5';
export const MODEL_NAME_GPT52 = 'GPT-5.2';
export const MODEL_NAME_GPT5_MINI = 'GPT-5 Mini';
export const MODEL_NAME_GPT5_CODEX = 'GPT-5 Codex';

// Gemini
export const MODEL_NAME_GEMINI_31_PRO = 'Gemini 3.1 Pro';
export const MODEL_NAME_GEMINI_35_FLASH = 'Gemini 3.5 Flash';

// DeepSeek
export const MODEL_NAME_DEEPSEEK_V4_PRO = 'DeepSeek V4 Pro';
export const MODEL_NAME_DEEPSEEK_V4_FLASH = 'DeepSeek V4 Flash';

// Volcengine / Doubao
export const MODEL_NAME_DOUBAO_SEED_20_PRO = 'Doubao Seed 2.0 Pro';
export const MODEL_NAME_DOUBAO_SEED_20_LITE = 'Doubao Seed 2.0 Lite';
export const MODEL_NAME_DOUBAO_SEED_20_MINI = 'Doubao Seed 2.0 Mini';
export const MODEL_NAME_DOUBAO_SEED_20_CODE = 'Doubao Seed 2.0 Code';
// Volcengine / Doubao — 第三方模型
export const MODEL_NAME_GLM_51 = 'GLM 5.1';
export const MODEL_NAME_KIMI_K26 = 'Kimi K2.6';
export const MODEL_NAME_MINIMAX_LATEST = 'MiniMax Latest';
// Volcengine / Doubao — 图片生成 (Seedream) / 视频生成 (Seedance)
export const MODEL_NAME_DOUBAO_SEEDREAM_50 = 'Doubao Seedream 5.0';
export const MODEL_NAME_DOUBAO_SEEDREAM_45 = 'Doubao Seedream 4.5';
export const MODEL_NAME_DOUBAO_SEEDANCE_20 = 'Doubao Seedance 2.0';
export const MODEL_NAME_DOUBAO_SEEDANCE_20_FAST = 'Doubao Seedance 2.0 Fast';

// Others
export const MODEL_NAME_OPENROUTER_AUTO = 'Auto (Best Model)';
export const MODEL_NAME_META_LLAMA4_MAVERICK = 'Meta: Llama 4 Maverick';
export const MODEL_NAME_MISTRAL_LARGE_2411 = 'Mistral: Mistral Large 2411';

// ─── 内置 Provider 目录 ────────────────────────────────────────────────────────

/**
 * 内置 Provider 目录（模型 catalog 唯一权威来源）。
 * key = provider.id；Connection 通过 providerId 引用。
 * 用户自定义覆盖持久化在 VFS PROVIDERS_DIR 中。
 */
export const LLM_PROVIDERS: Record<string, LLMProvider> = {
    // External providers loaded from .llm configs
    ...externalProviders,

    anthropic: {
        id: 'anthropic', isBuiltin: true,
        name: 'Anthropic',
        implementation: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        icon: '🏺',
        supportsThinking: true,
        models: [
            { id: 'claude-fable-5', name: 'Claude Fable 5', icon: '🧙' },
            { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', icon: '👑' },
            { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', icon: '🎯' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', icon: '🎭' },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', icon: '🍃' },
        ],
    },

    gemini: {
        id: 'gemini', isBuiltin: true,
        name: 'Google Gemini',
        implementation: 'gemini',
        baseURL: 'https://generativelanguage.googleapis.com',
        icon: '💎',
        supportsThinking: true,
        capabilities: {
            thinking: true,
            serverSideWebSearch: true,   // Gemini googleSearch grounding
        },
        models: [
            { id: 'gemini-3.1-pro', name: MODEL_NAME_GEMINI_31_PRO, icon: '🌟' },
            { id: 'gemini-3.5-flash', name: MODEL_NAME_GEMINI_35_FLASH, icon: '⚡' },
        ],
    },

    deepseek: {
        id: 'deepseek', isBuiltin: true,
        name: 'DeepSeek',
        implementation: 'openai-compatible',
        baseURL: 'https://api.deepseek.com',
        anthropicPath: '/anthropic/v1/messages',
        responsesPath: '/responses',
        icon: '🐋',
        supportsThinking: true,
        capabilities: {
            thinking: true,
            serverSideWebSearch: true,   // DeepSeek Responses API 内置 web_search
        },
        responses: {
            defaultThinkingEnabled: true, // DeepSeek Responses 默认开启思考，关闭需 effort='none'
        },
        models: [
            { id: 'deepseek-v4-pro', name: MODEL_NAME_DEEPSEEK_V4_PRO, icon: '👑', supportsThinking: true },
            { id: 'deepseek-v4-flash', name: MODEL_NAME_DEEPSEEK_V4_FLASH, icon: '⚡' },
        ],
    },

    openrouter: {
        id: 'openrouter', isBuiltin: true,
        name: 'OpenRouter',
        implementation: 'openai-compatible',
        baseURL: 'https://openrouter.ai',
        defaultPath: '/api/v1/chat/completions',
        icon: '🌐',
        requiresReferer: true,
        supportsThinking: true,
        models: [
            { id: 'openrouter/auto', name: MODEL_NAME_OPENROUTER_AUTO, icon: '🪄' },
            { id: 'openai/gpt-5.5', name: MODEL_NAME_GPT55, icon: '👑' },
            { id: 'openai/gpt-5-pro', name: MODEL_NAME_GPT52, icon: '✨' },
            { id: 'anthropic/claude-sonnet-4.6', name: MODEL_NAME_CLAUDE_46_SONNET, icon: '🎭' },
            { id: 'google/gemini-3.1-pro', name: MODEL_NAME_GEMINI_31_PRO, icon: '🌟' },
            { id: 'google/gemini-3.5-flash', name: MODEL_NAME_GEMINI_35_FLASH, icon: '⚡' },
            { id: 'meta-llama/llama-4-maverick', name: MODEL_NAME_META_LLAMA4_MAVERICK, icon: '🦙' },
            { id: 'mistralai/mistral-large-2411', name: MODEL_NAME_MISTRAL_LARGE_2411, icon: '⛵' },
        ],
    },

    cloudapi: {
        id: 'cloudapi', isBuiltin: true,
        name: 'CloudAPI',
        implementation: 'openai-compatible',
        baseURL: 'https://chat.cloudapi.vip',
        defaultPath: '/v1/chat/completions',
        icon: '☁️',
        supportsThinking: true,
        models: [
            { id: 'claude-opus-4-6', name: MODEL_NAME_CLAUDE_46_OPUS, icon: '👑' },
            { id: 'claude-sonnet-4-6', name: MODEL_NAME_CLAUDE_46_SONNET, icon: '🎭' },
            { id: 'claude-haiku-4-5', name: MODEL_NAME_CLAUDE_45_HAIKU, icon: '🍃' },
            { id: 'gemini-3.1-pro', name: MODEL_NAME_GEMINI_31_PRO, icon: '💫' },
            { id: 'gemini-3.5-flash', name: MODEL_NAME_GEMINI_35_FLASH, icon: '⚡' },
            { id: 'gpt-5.5', name: MODEL_NAME_GPT55, icon: '👑' },
        ],
    },

    openai: {
        id: 'openai', isBuiltin: true,
        name: 'OpenAI',
        implementation: 'openai-compatible',
        baseURL: 'https://api.openai.com',
        icon: '🤖',
        supportsThinking: true,
        models: [
            { id: 'gpt-5.5', name: MODEL_NAME_GPT55, icon: '👑' },
            { id: 'gpt-5-pro', name: MODEL_NAME_GPT52, icon: '✨' },
            { id: 'gpt-5-mini', name: MODEL_NAME_GPT5_MINI, icon: '🍃' },
            { id: 'gpt-5-codex', name: MODEL_NAME_GPT5_CODEX, icon: '💻' },
        ],
    },

    codex: {
        id: 'codex', isBuiltin: true,
        name: 'Codex (Local)',
        implementation: 'custom',
        baseURL: '',
        icon: '⌨️',
        supportsThinking: true,
        capabilities: {
            vision: true,
            audioInput: true,
            tools: true,
            thinking: true,
            streaming: true,
        },
        models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', icon: '💻', supportsThinking: true, supportsVision: true, supportsTools: true, supportsStructuredOutput: true },
        ],
    },

    volcengine: {
        id: 'volcengine', isBuiltin: true,
        name: 'Volcengine (火山方舟)',
        implementation: 'openai-compatible',
        baseURL: 'https://ark.cn-beijing.volces.com',
        defaultPath: '/api/v3/chat/completions',
        icon: '🌋',
        capabilities: {
            vision: true,
            audioInput: false,
            audioOutput: false,
            tools: true,
            thinking: true,
            streaming: true,
        },
        models: [
            // Seed-2.0 系列：对话 + 多模态视觉 + 工具调用 + 深度思考
            { id: 'doubao-seed-2-0-pro-260215', name: MODEL_NAME_DOUBAO_SEED_20_PRO, icon: '👑', category: 'chat', supportsThinking: true, supportsVision: true, supportsTools: true },
            { id: 'doubao-seed-2-0-lite-260428', name: MODEL_NAME_DOUBAO_SEED_20_LITE, icon: '⚡', category: 'chat', supportsThinking: true, supportsVision: true, supportsTools: true },
            { id: 'doubao-seed-2-0-mini-260428', name: MODEL_NAME_DOUBAO_SEED_20_MINI, icon: '🍃', category: 'chat', supportsThinking: true, supportsVision: true, supportsTools: true },
            // Seed-2.0 Code：对话 + 工具调用（代码增强）
            { id: 'doubao-seed-2-0-code-preview-260215', name: MODEL_NAME_DOUBAO_SEED_20_CODE, icon: '💻', category: 'chat', supportsTools: true },
            // DeepSeek-V4 系列：对话 + 深度思考 + 工具调用（纯文本推理）
            { id: 'deepseek-v4-pro-260425', name: MODEL_NAME_DEEPSEEK_V4_PRO, icon: '🧠', category: 'chat', supportsThinking: true, supportsTools: true },
            { id: 'deepseek-v4-flash-260425', name: MODEL_NAME_DEEPSEEK_V4_FLASH, icon: '🚀', category: 'chat', supportsThinking: true, supportsTools: true },
            // 文生图 (Seedream)：按张计费，走 images/generations 端点（非 chat/completions）
            { id: 'doubao-seedream-5-0-260128', name: MODEL_NAME_DOUBAO_SEEDREAM_50, icon: '🎨', category: 'image' },
            // 视频生成 (Seedance)：按时长计费，走异步任务端点（非 chat/completions）
            { id: 'doubao-seedance-2-0-260128', name: MODEL_NAME_DOUBAO_SEEDANCE_20, icon: '🎬', category: 'video' },
        ],
    },

    custom: {
        id: 'custom', isBuiltin: true,
        name: 'Custom (OpenAI Compatible)',
        implementation: 'openai-compatible',
        baseURL: '',
        icon: '🛠️',
        models: [],
    },
};

export function getProviderDefinition(provider: string): LLMProvider | undefined {
    return LLM_PROVIDERS[provider];
}

export function getModelDefinition(provider: string, modelId: string) {
    return LLM_PROVIDERS[provider]?.models.find(m => m.id === modelId);
}
