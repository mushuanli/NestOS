import {MODEL_CAPABILITY_META, MODEL_CATEGORY_META, t} from '@itookit/common';
import {capabilityLabel} from './capability-filters';
import type {NodePresentation} from '@itookit/vfs-ui';

/** Each connection exposes only the capabilities of its configured models. */
export function modelIndicators(tags: string[] = []): NodePresentation['indicators'] {
    const icons: Record<string, {icon: string}> = {...MODEL_CATEGORY_META, ...MODEL_CAPABILITY_META,
        'image.generate': MODEL_CATEGORY_META.image, 'speech.synthesize': MODEL_CATEGORY_META.audio};
    const labelsByIcon = new Map<string, Set<string>>();
    for (const tag of tags) {
        const icon = icons[tag]?.icon;
        if (!icon) continue;
        const labels = labelsByIcon.get(icon) ?? new Set<string>();
        labels.add(capabilityLabel(tag)); labelsByIcon.set(icon, labels);
    }
    const values = [...labelsByIcon].map(([icon, labels]) => ({icon, label: [...labels].join(' / ')}));
    return values.length ? values : [{icon: '?', label: t('connection.modelCapabilitiesUnknown')}];
}
