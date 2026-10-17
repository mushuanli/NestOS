import { Toast } from '@itookit/ui-common';

export function promptInterruptedRun(
    snapshot: { interruptedAssistantId?: string },
    onResume: (interruptedAssistantId: string) => void,
): void {
    const assistantId = snapshot.interruptedAssistantId;
    if (!assistantId) return;
    Toast.action(
        '上次执行未完成，是否需要重新执行？',
        '重新执行',
        () => onResume(assistantId),
    );
}
