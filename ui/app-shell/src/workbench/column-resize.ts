import { t } from '@itookit/common';

/** Resizing is local to a retained directory tab, including keyboard access. */
export function installColumnResize(cell: HTMLTableCellElement): void {
    const handle = document.createElement('span'); handle.className = 'workbench-directory__resize'; handle.tabIndex = 0;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', t('workbench.resizeColumn'));
    handle.setAttribute('aria-valuemin', '100'); handle.setAttribute('aria-valuemax', '800');
    const resize = (delta: number) => {
        const width = Math.max(100, Math.min(800, (cell.getBoundingClientRect().width || Number.parseFloat(cell.style.width) || 180) + delta));
        cell.style.width = `${width}px`; handle.setAttribute('aria-valuenow', String(Math.round(width)));
    };
    handle.onclick = event => event.stopPropagation();
    handle.onkeydown = event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); event.stopPropagation(); resize(event.key === 'ArrowLeft' ? -16 : 16);
    };
    handle.onpointerdown = event => {
        event.preventDefault(); event.stopPropagation(); handle.setPointerCapture?.(event.pointerId);
        let previous = event.clientX;
        const move = (event: PointerEvent) => { resize(event.clientX - previous); previous = event.clientX; };
        const stop = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
    };
    cell.append(handle);
}
