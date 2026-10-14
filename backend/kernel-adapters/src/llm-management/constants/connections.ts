// @file: device-llm/constants/connections.ts
// Layer 2 — Connection 默认定义。
// 职责：引用 Provider（通过 providerId）+ 命名 + tier 映射（optimal/standard/fast）。
// Connection 不持有 apiKey（在 Provider 层），也不持有模型目录（在 Provider 层）。
//
// 同一 Provider 可有多个 Connection，每个 Connection 选取不同的模型族作为 tier 策略。

import type { DefaultConnectionDef } from '@itookit/kernel-adapters/contracts';
import { externalConnections } from './llm-configs';

/** 系统默认连接 ID */
export const LLM_DEFAULT_ID = 'default';
export const LLM_DEFAULT_NAME = '默认';

/** LLM 请求超时（ms） */
export const DEFAULT_TIMEOUT = 60000;
/** 最大重试次数 */
export const DEFAULT_MAX_RETRIES = 3;
/** 重试基础延迟（ms） */
export const DEFAULT_RETRY_DELAY = 1000;

/** Re-export for convenience */
export type { DefaultConnectionDef };

/**
 * 内置默认连接列表。
 * 第一条 id='default' 为系统默认连接。
 * 同一 Provider 可出现多次，代表不同的模型族策略。
 */
export const DEFAULT_CONNECTIONS: DefaultConnectionDef[] = [
    // ── DeepSeek — 系统默认连接 ──────────────────────────────────────────
    {
        id: 'default',
        name: 'DeepSeek',
        providerId: 'deepseek',
        tiers: {
            optimal: 'deepseek-v4-pro',
            standard: 'deepseek-v4-flash',
            fast: 'deepseek-v4-flash',
        },
    },
    // External connections loaded from .llm configs
    ...externalConnections,

    // ── Anthropic ─────────────────────────────────────────────────────────
    {
        id: 'conn-anthropic',
        name: 'Anthropic',
        providerId: 'anthropic',
        tiers: {
            optimal: 'claude-opus-4-8-20251101',
            standard: 'claude-sonnet-4-6-20250514',
            fast: 'claude-haiku-4-5-20251001',
        },
    },

    // ── Google Gemini ─────────────────────────────────────────────────────
    {
        id: 'conn-gemini',
        name: 'Google Gemini',
        providerId: 'gemini',
        tiers: {
            optimal: 'gemini-3.1-pro',
            standard: 'gemini-3.5-flash',
            fast: 'gemini-3.5-flash',
        },
    },

    // ── CloudAPI — Claude 系列 ────────────────────────────────────────────
    {
        id: 'conn-cloudapi',
        name: 'CloudAPI',
        providerId: 'cloudapi',
        tiers: {
            optimal: 'claude-opus-4-6',
            standard: 'claude-sonnet-4-6',
            fast: 'claude-haiku-4-5',
        },
    },

    // ── OpenRouter ────────────────────────────────────────────────────────
    {
        id: 'conn-openrouter',
        name: 'OpenRouter',
        providerId: 'openrouter',
        // No default tiers — model list too heterogeneous; user configures manually
    },

    // ── OpenAI ────────────────────────────────────────────────────────────
    {
        id: 'conn-openai',
        name: 'OpenAI',
        providerId: 'openai',
        tiers: {
            optimal: 'gpt-5.5',
            standard: 'gpt-5-pro',
            fast: 'gpt-5-mini',
        },
    },

    // ── Local Codex app-server ────────────────────────────────────────────
    {
        id: 'conn-codex',
        name: 'Codex (Local)',
        providerId: 'codex',
        tiers: {
            optimal: 'gpt-5.6-sol',
            standard: 'gpt-5.6-sol',
            fast: 'gpt-5.6-sol',
        },
    },

    // ── Volcengine — 图片 OCR / 视觉理解 ─────────────────────────────────
    {
        id: 'conn-volcengine-vision',
        name: '图片转文字',
        providerId: 'volcengine',
        tiers: {
            optimal: 'doubao-seed-2-0-lite-260428',
            standard: 'doubao-seed-2-0-lite-260428',
            fast: 'doubao-seed-2-0-mini-260428',
        },
    },
];
