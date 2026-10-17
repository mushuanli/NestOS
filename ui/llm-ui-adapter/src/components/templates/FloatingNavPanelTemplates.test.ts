import { expect, it } from 'vitest';
import { FloatingNavPanelTemplates } from './FloatingNavPanelTemplates';
    it('renders the Navigator plus button as a grouped creation entry', () => {
        const html = FloatingNavPanelTemplates.renderBranchActions({
            id: 'message',
            roundId: 'round',
            role: 'user',
            preview: '',
            isCollapsed: false,
            index: 0,
            timestamp: 1,
        });
        expect(html).toContain('data-action="open-create-menu"');
        expect(html).not.toContain('data-action="create-branch"');
    });
