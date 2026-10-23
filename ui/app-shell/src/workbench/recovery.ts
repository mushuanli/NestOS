import {t} from '@itookit/common';
import type {IEditor} from '@itookit/ui-common';

export interface RecoveryParticipant {
    captureRecovery?(): unknown;
    restoreRecovery?(snapshot: unknown): void;
    suspendForRecovery?(): void;
    assertRecovery?(): void;
}
export interface AppRecoveryState {
    workspaces: Map<string, unknown>;
    presentation?: {workspaceId: string; mobileView?: string; navigationScope?: string};
}
export interface EditorRecoveryState { data?: unknown; scroll: Array<{path: number[]; top: number; left: number}>; }

/** Missing editor support must retain the original view, including programmatic edits. */
export function captureEditor(editor: IEditor, panel: HTMLElement): EditorRecoveryState {
    if (!editor.captureRecovery || !editor.restoreRecovery || !editor.suspendForRecovery)
        throw Object.assign(new Error(t('httpApp.recoveryUnsupported')), {code: 'RECOVERY_UNSUPPORTED_EDITOR'});
    return {data: editor.captureRecovery(), scroll: captureScroll(panel)};
}

export function restoreEditor(editor: IEditor, panel: HTMLElement, state: EditorRecoveryState): void {
    if (!editor.restoreRecovery) throw new Error(t('httpApp.recoveryUnsupported'));
    editor.restoreRecovery(state.data);
    const restore = () => {
        for (const position of state.scroll) {
            let node: Element | undefined = panel;
            for (const index of position.path) node = node?.children[index];
            if (node) {node.scrollTop = position.top; node.scrollLeft = position.left;}
        }
    };
    restore(); requestAnimationFrame(restore);
}

function captureScroll(panel: HTMLElement): EditorRecoveryState['scroll'] {
    const result: EditorRecoveryState['scroll'] = [];
    const visit = (node: Element, path: number[]) => {
        if (node.scrollTop || node.scrollLeft) result.push({path, top: node.scrollTop, left: node.scrollLeft});
        Array.from(node.children).forEach((child, index) => visit(child, [...path, index]));
    };
    visit(panel, []); return result;
}
