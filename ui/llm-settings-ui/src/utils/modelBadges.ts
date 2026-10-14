// @file: llm-ui/utils/modelBadges.ts
// 模型能力 / 用途分类 badge 渲染辅助。
// Provider / Connection / Agent 三处 editor 共用，避免重复渲染逻辑。
// 图标与颜色统一来自 @itookit/common 的 MODEL_CAPABILITY_META / MODEL_CATEGORY_META。

import type { LLMModel } from '@itookit/driver-llm/contracts';
import { t, MODEL_CAPABILITY_META, MODEL_CATEGORY_META } from '@itookit/common';

/** 能力键 → LLMModel 字段映射（固定渲染顺序） */
const CAPABILITY_FIELDS: ReadonlyArray<[string, keyof LLMModel]> = [
    ['vision', 'supportsVision'],
    ['thinking', 'supportsThinking'],
    ['tools', 'supportsTools'],
    ['audio', 'supportsAudio'],
    ['video', 'supportsVideo'],
    ['structuredOutput', 'supportsStructuredOutput'],
];

/** 生成单个 badge 的内联样式（颜色透明度叠加，复用 settings-badge 圆角尺寸） */
function badgeStyle(color: string): string {
    return `display:inline-flex;align-items:center;gap:2px;background:${color}20;color:${color};`
        + `border:1px solid ${color}40;font-size:11px;line-height:1;padding:2px 5px;border-radius:4px;`;
}

/**
 * 渲染模型能力 badge 组（inline HTML）。
 * 只渲染值为 true 的 supportsXXX 字段；无任何能力时返回空字符串。
 */
export function renderModelCapabilityBadges(model: LLMModel): string {
    return CAPABILITY_FIELDS
        .filter(([, field]) => model[field] === true)
        .map(([cap]) => {
            const meta = MODEL_CAPABILITY_META[cap];
            const label = t(`model.capability.${cap}` as Parameters<typeof t>[0]);
            return `<span class="model-cap-badge" style="${badgeStyle(meta.color)}" title="${label}">${meta.icon}</span>`;
        })
        .join('');
}

/**
 * 渲染模型用途分类 badge（inline HTML）。
 * category 未设置时默认渲染 'chat'。
 */
export function renderModelCategoryBadge(model: LLMModel): string {
    const cat = model.category ?? 'chat';
    const meta = MODEL_CATEGORY_META[cat] ?? MODEL_CATEGORY_META.chat;
    const label = t(`model.category.${cat}` as Parameters<typeof t>[0]);
    return `<span class="model-category-badge" style="${badgeStyle(meta.color)}" title="${label}">${meta.icon} ${label}</span>`;
}
