// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {modelIndicators} from '../src/toolbox/model-indicators';
import {t} from '@itookit/common';

it('deduplicates declared model abilities and gives every icon an accessible description', () => {
    const icons = modelIndicators(['chat', 'vision', 'tools', 'vision', 'image.generate'])!;
    expect(icons).toHaveLength(4);
    expect(icons.map(item => item.label)).toContain(t('toolbox.capability.image'));
    expect(icons.every(item => item.icon && item.label)).toBe(true);
    expect(modelIndicators()).toEqual([{icon: '?', label: t('connection.modelCapabilitiesUnknown')}]);
});

it('merges audio and speech synthesis into one icon while retaining both descriptions', () => {
    const icons = modelIndicators(['audio', 'speech.synthesize', 'audio', 'speech.synthesize'])!;
    expect(icons).toHaveLength(1);
    expect(icons[0].label).toBe([t('toolbox.capability.audio'), t('toolbox.capability.speech')].join(' / '));
});
