// @file: llm-ui/utils/modelBadges.ts
// 模型能力 / 用途分类 badge 渲染辅助。
// Provider / Connection / Agent 三处 editor 共用，避免重复渲染逻辑。
// 图标与颜色统一来自 @itookit/common 的 MODEL_CAPABILITY_META / MODEL_CATEGORY_META。

import type { LLMModel } from '@itookit/driver-llm/contracts';
import { t, escapeAttr, MODEL_CAPABILITY_META, MODEL_CATEGORY_META } from '@itookit/common';

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

/** Describe declared capabilities, with a category fallback when no details are available. */
function capabilityBadges(model: LLMModel) {
    const badges = CAPABILITY_FIELDS
        .filter(([, field]) => model[field] === true)
        .map(([cap]) => {
            const meta = MODEL_CAPABILITY_META[cap];
            const label = t(`model.capability.${cap}` as Parameters<typeof t>[0]);
            return {...meta, key: cap, label};
        });
    const operations = (['image.generate', 'speech.synthesize'] as const).filter(operation => model.operations?.[operation] || model.supportedOperations?.includes(operation));
    badges.push(...operations.map(operation => {
        const meta = MODEL_CATEGORY_META[operation === 'image.generate' ? 'image' : 'audio'];
        const label = t(operation === 'image.generate' ? 'model.capability.imageGeneration' : 'model.capability.speechSynthesis');
        return {...meta, key: operation, label};
    }));
    if (!badges.length && model.category && MODEL_CATEGORY_META[model.category] && model.capabilitiesKnown !== false) {
        const meta = MODEL_CATEGORY_META[model.category], label = t(`model.category.${model.category}` as Parameters<typeof t>[0]);
        badges.push({...meta, key: `category.${model.category}`, label});
    }
    return badges;
}

/** Share the same capability descriptions between native options and HTML badges. */
export function modelCapabilityIndicators(model: LLMModel) {
    const unique = new Map<string, {color: string; keys: Set<string>; labels: Set<string>}>();
    for (const badge of capabilityBadges(model)) {
        const entry = unique.get(badge.icon) ?? {color: badge.color, keys: new Set<string>(), labels: new Set<string>()};
        entry.keys.add(badge.key); entry.labels.add(badge.label); unique.set(badge.icon, entry);
    }
    return [...unique].map(([icon, entry]) => ({icon, color: entry.color, keys: [...entry.keys], label: [...entry.labels].join(' / ')}));
}

/** One visual badge can describe several capabilities that share the same icon. */
export function renderModelCapabilityBadges(model: LLMModel): string {
    return modelCapabilityIndicators(model).map(({icon, color, keys, label: text}) => {
        const label = escapeAttr(text);
        return `<span class="model-cap-badge" data-capability="${escapeAttr(keys[0])}" data-capabilities="${escapeAttr(keys.join(' '))}" role="img" aria-label="${label}" style="${badgeStyle(color)}" title="${label}">${icon}</span>`;
    }).join('') || (model.capabilitiesKnown === true ? '' : `<span class="model-cap-badge" role="img" aria-label="${escapeAttr(t('model.capability.unknown'))}" title="${escapeAttr(t('model.capability.unknown'))}">?</span>`);
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
