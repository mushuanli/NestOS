import type { PrintOptions } from '@itookit/mdxeditor';
import { DefaultPrintService } from './print';

export class LLMPrintService extends DefaultPrintService {
    /**
     * LLM 对话专用样式：结构由本适配层生成，样式也归本适配层所有，
     * 通用打印服务只负责通用排版。
     */
    private static readonly LLM_STYLES = `
        .mdx-print-message { page-break-inside: avoid; }
        .mdx-print-message + .mdx-print-message { margin-top: 12px; }
        /* ============================================
           LLM CONVERSATION - MESSAGE
           ============================================ */

        .mdx-print-message {
            margin: 16px 0;
            padding: 16px;
            border-radius: 12px;
            border: 1px solid;
        }

        .mdx-print-message__header {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
        }

        .mdx-print-message__avatar {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            margin-right: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
        }

        .mdx-print-message__role {
            font-size: 0.8125em;
            font-weight: 600;
            text-transform: uppercase;
        }

        .mdx-print-message--user {
            background-color: #ddf4ff;
            border-color: #54aeff;
            margin-left: 10%;
        }

        .mdx-print-message--user .mdx-print-message__avatar {
            background-color: #0969da;
            color: #ffffff;
        }

        .mdx-print-message--assistant {
            background-color: #f6f8fa;
            border-color: #d0d7de;
            margin-right: 10%;
        }

        .mdx-print-message--assistant .mdx-print-message__avatar {
            background-color: #8250df;
            color: #ffffff;
        }

        .mdx-print-message--system {
            background-color: #fff8c5;
            border-color: #d4a72c;
            font-style: italic;
        }

        /* ============================================
           LLM CONVERSATION - SESSION DIVIDER
           ============================================ */

        .mdx-print-session {
            position: relative;
            margin: 32px 0;
            text-align: center;
        }

        .mdx-print-session__line {
            position: absolute;
            top: 50%;
            left: 0;
            right: 0;
            border-top: 2px dashed #d0d7de;
        }

        .mdx-print-session__label {
            position: relative;
            display: inline-block;
            padding: 4px 16px;
            background-color: #ffffff;
            font-size: 0.75em;
            font-weight: 500;
            color: #656d76;
            text-transform: uppercase;
        }

        .mdx-print-message__content { white-space: normal; overflow-wrap: anywhere; }
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
