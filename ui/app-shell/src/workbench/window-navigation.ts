import {FILE_BROWSER_ICONS, t} from '@itookit/common';

export interface WindowNavigation {
    home?(): void;
    parent?(): void;
}

/** Navigation actions stay host-owned and follow the current resource. */
export function windowNavigation(actions: WindowNavigation) {
    const button = (kind: 'home' | 'parent', icon: string) => {
        const element = document.createElement('button'); element.type = 'button';
        element.className = 'workbench-window-navigation'; element.dataset.windowNavigation = kind;
        element.innerHTML = icon; element.title = t(kind === 'home' ? 'workbench.home' : 'workbench.parent');
        element.setAttribute('aria-label', element.title); element.onclick = () => actions[kind]?.();
        return element;
    };
    const home = actions.home ? button('home', FILE_BROWSER_ICONS.home) : undefined, parent = button('parent', FILE_BROWSER_ICONS.up);
    parent.hidden = !actions.parent;
    return {buttons: [...(home ? [home] : []), ...(actions.parent ? [parent] : [])], update(canGoUp: boolean) {parent.hidden = !actions.parent || !canGoUp;},
        destroy() {home?.remove(); parent.remove();}};
}
