// @itookit/common/types/heading.ts — markdown heading structure (pure type).

export interface Heading {
    /** 标题层级 1-6 */
    level: number;
    /** 标题文本 */
    text: string;
    /** 唯一标识符/锚点 (e.g. "heading-introduction-1") */
    id: string;
    /** 子标题（嵌套模式） */
    children: Heading[];
}
