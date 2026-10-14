/**
 * @file common/utils/MarkdownAnalyzer.ts
 */

interface DocumentInfo {
    filename: string;
    path: string;
    mimeType?: string;
    size?: number;
}

interface AnalysisContext {
    filePath: string;
}

interface ReferenceExtractionResult {
    references: string[];
    metadata?: Record<string, unknown>;
}

export class MarkdownAnalyzer {
    readonly id = 'markdown-analyzer';

    private supportedExtensions: Set<string>;
    private supportedMimeTypes = new Set(['text/markdown', 'text/plain']);

    constructor(extensions: string[] = ['.md', '.markdown', '.mdx', '.txt']) {
        this.supportedExtensions = new Set(
            extensions.map(e => e.startsWith('.') ? e : `.${e}`)
        );
    }

    supports(doc: DocumentInfo): boolean {
        // 1. 优先检查扩展名
        const extIndex = doc.filename.lastIndexOf('.');
        if (extIndex !== -1) {
            const ext = doc.filename.substring(extIndex).toLowerCase();
            if (this.supportedExtensions.has(ext)) return true;
        }
        
        if (doc.mimeType && this.supportedMimeTypes.has(doc.mimeType)) {
            return true;
        }

        return false;
    }

    async analyze(
        content: string | ArrayBuffer, 
        context: AnalysisContext
    ): Promise<ReferenceExtractionResult> {
        const text = typeof content === 'string' 
            ? content 
            : new TextDecoder().decode(content);
        
        const refs = new Set<string>();

        // 策略 1: 匹配 @asset/filename 语法
        this.extractAssetProtocolRefs(text, refs);

        // 策略 2: 匹配相对伴生目录
        this.extractSidecarRefs(text, context.filePath, refs);

        // 策略 3: 匹配通用相对路径
        this.extractRelativePathRefs(text, refs);

        return { references: Array.from(refs) };
    }

    /**
     * 提取 @asset/ 协议引用
     */
    private extractAssetProtocolRefs(text: string, refs: Set<string>): void {
        const regex = /@asset\/([^\s)"']+)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            // 提取完整路径中的文件名
            const filename = this.extractFilename(match[1]);
            if (filename) refs.add(filename);
        }
    }

    /**
     * 提取伴生目录引用
     */
    private extractSidecarRefs(
        text: string, 
        filePath: string, 
        refs: Set<string>
    ): void {
        const baseName = filePath.split('/').pop();
        if (!baseName) return;
        
        const sidecarDir = `.${baseName}`;
        const escapedDir = sidecarDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // 匹配 Markdown 链接和 HTML 属性
        const patterns = [
            new RegExp(`\\]\\(\\s*${escapedDir}\\/([^)\\s]+)`, 'g'),
            new RegExp(`(?:src|href)=["']${escapedDir}\\/([^"']+)["']`, 'g'),
        ];
        
        for (const regex of patterns) {
            let match;
            while ((match = regex.exec(text)) !== null) {
                try {
                    const decoded = decodeURIComponent(match[1]);
                    const filename = this.extractFilename(decoded);
                    if (filename) refs.add(filename);
                } catch {
                    const filename = this.extractFilename(match[1]);
                    if (filename) refs.add(filename);
                }
            }
        }
    }

    /**
     * 提取通用相对路径引用
     */
    private extractRelativePathRefs(text: string, refs: Set<string>): void {
        // 匹配 Markdown 链接 [text](./path) 或 [text](path)
        const linkRegex = /\]\(\s*(?:\.\/)?([^)\s"']+)\s*(?:"[^"]*")?\s*\)/g;
        let match;
        
        while ((match = linkRegex.exec(text)) !== null) {
            const path = match[1];
            
            // 跳过绝对 URL 和特殊协议
            if (this.shouldSkipPath(path)) continue;
            
            const filename = this.extractFilename(path);
            if (filename) refs.add(filename);
        }

        // 匹配 HTML src/href 属性
        const htmlRegex = /(?:src|href)=["'](?:\.\/)?([^"']+)["']/g;
        while ((match = htmlRegex.exec(text)) !== null) {
            const path = match[1];
            if (this.shouldSkipPath(path)) continue;
            
            const filename = this.extractFilename(path);
            if (filename) refs.add(filename);
        }
    }

    /**
     * 判断路径是否应该跳过
     */
    private shouldSkipPath(path: string): boolean {
        return (
            path.startsWith('http://') ||
            path.startsWith('https://') ||
            path.startsWith('data:') ||
            path.startsWith('mailto:') ||
            path.startsWith('tel:') ||
            path.startsWith('javascript:') ||
            path.startsWith('#') ||
            path.startsWith('/')  // 绝对路径
        );
    }

    /**
     * 从路径中提取文件名
     */
    private extractFilename(path: string): string | null {
        if (!path) return null;
        
        // 移除查询参数和锚点
        const cleanPath = path.split('?')[0].split('#')[0];
        
        // 获取最后一个路径段
        const filename = cleanPath.split('/').pop();
        
        // 验证文件名有效性
        if (!filename || filename === '.' || filename === '..') {
            return null;
        }
        
        return filename;
    }
}
