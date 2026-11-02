import {TOOLBOX_ICONS, t} from '@itookit/common';
import {FilterPanel, type FilterChip} from '@itookit/vfs-ui';
import {nestOSVFSPresentation} from '../browser/vfs-presentation';

export type NavigationFilterChip = FilterChip;
/** Only NestOS wording and business content styling remain in the host. */
export class NavigationFilters extends FilterPanel {
    constructor(label = t('workbench.filters'), options: {iconOnly?: boolean} = {}) {
        super({label, ...options, iconHTML: TOOLBOX_ICONS.settings}, nestOSVFSPresentation);
        this.content.classList.add('workbench-filters-content');
    }
}
