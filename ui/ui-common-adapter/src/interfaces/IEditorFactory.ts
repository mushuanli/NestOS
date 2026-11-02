/**
 * @file ui-common/interfaces/IEditorFactory.ts
 * @description 定义了标准的编辑器工厂函数类型。
 */

import { IEditor, EditorOptions } from './IEditor';

/**
 * ✨ [最终] 定义一个标准的编辑器工厂函数类型。
 * 这是连接UI和编辑器的核心契约。
 *
 * @param container - 编辑器将被挂载的HTML元素。
 * @param options - 创建和初始化编辑器实例所需的标准配置。
 * @returns 一个Promise，解析为完全初始化好的、符合IEditor接口的实例。
 */
export type EditorFactory = (
    container: HTMLElement,
    options: EditorOptions
) => Promise<IEditor>;
