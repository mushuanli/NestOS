import type { PrintOptions } from '@itookit/mdxeditor';
import { DefaultPrintService } from './print';

export class LLMPrintService extends DefaultPrintService {
    /**
     * LLM 对话专用样式
     */
    private static readonly LLM_STYLES = `
        .mdx-print-message { page-break-inside: avoid; }
        .mdx-print-message + .mdx-print-message { margin-top: 12px; }
    `;

    /**
     * 重写渲染方法，添加对话结构转换
     */
    async renderForPrint(markdown: string, options: PrintOptions = {}): Promise<string> {
        // 预处理：将对话 Markdown 转换为带有 BEM 类名的结构
        const processedMarkdown = this.preprocessConversation(markdown);

        // 调用父类渲染
        return super.renderForPrint(processedMarkdown, {
            ...options,
            styles: [
                LLMPrintService.LLM_STYLES,
                ...(Array.isArray(options.styles) ? options.styles : options.styles ? [options.styles] : [])
            ],
        });
    }

    /**
     * 预处理对话 Markdown
     * 将角色标记转换为带有 BEM 类名的 HTML 结构
     */
    private preprocessConversation(markdown: string): string {
        const lines = markdown.split('\n');
        const result: string[] = [];
        let currentRole: 'user' | 'assistant' | 'system' | null = null;
        let messageBuffer: string[] = [];

        const flushMessage = () => {
            if (currentRole && messageBuffer.length > 0) {
                const content = messageBuffer.join('\n').trim();
                if (content) {
                    const avatarIcon = this.getRoleIcon(currentRole);
                    const roleLabel = this.getRoleLabel(currentRole);

                    result.push(`<div class="mdx-print-message mdx-print-message--${currentRole}">`);
                    result.push(`  <div class="mdx-print-message__header">`);
                    result.push(`    <span class="mdx-print-message__avatar">${avatarIcon}</span>`);
                    result.push(`    <span class="mdx-print-message__role">${roleLabel}</span>`);
                    result.push(`  </div>`);
                    result.push(`  <div class="mdx-print-message__content">\n\n${content}\n\n</div>`);
                    result.push(`</div>`);
                }
                messageBuffer = [];
            }
        };

        for (const line of lines) {
            // 检测角色标记
            const userMatch = line.match(/^##\s*User\s*$/i) || line.match(/^>\s*\*\*User\*\*/i);
            const assistantMatch = line.match(/^##\s*Assistant\s*$/i) || line.match(/^>\s*\*\*Assistant\*\*/i);
            const systemMatch = line.match(/^##\s*System\s*$/i) || line.match(/^>\s*\*\*System\*\*/i);
            const dividerMatch = line.match(/^---+$/);

            if (userMatch) {
                flushMessage();
                currentRole = 'user';
            } else if (assistantMatch) {
                flushMessage();
                currentRole = 'assistant';
            } else if (systemMatch) {
                flushMessage();
                currentRole = 'system';
            } else if (dividerMatch) {
                flushMessage();
                currentRole = null;
                result.push(`<div class="mdx-print-session">`);
                result.push(`  <div class="mdx-print-session__line"></div>`);
                result.push(`  <span class="mdx-print-session__label">New Session</span>`);
                result.push(`</div>`);
            } else if (currentRole) {
                messageBuffer.push(line);
            } else {
                result.push(line);
            }
        }

        flushMessage();
        return result.join('\n');
    }

    /**
     * 获取角色图标
     */
    private getRoleIcon(role: string): string {
        switch (role) {
            case 'user': return '👤';
            case 'assistant': return '🤖';
            case 'system': return '⚙️';
            default: return '💬';
        }
    }

    /**
     * 获取角色标签
     */
    private getRoleLabel(role: string): string {
        switch (role) {
            case 'user': return 'User';
            case 'assistant': return 'Assistant';
            case 'system': return 'System';
            default: return role;
        }
    }
}
