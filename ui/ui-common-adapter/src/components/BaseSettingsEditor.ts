import {SettingsBaseEditor} from '@itookit/ui-common';
import {ENTITY_ICONS, SETTINGS_ICON_CHOICES, randomUUID, t, escapeAttr} from '@itookit/common';
import {editorFilePath, type EditorOptions} from '../interfaces/IEditor';

/** Connect shared settings lifecycle to the host file capabilities. */
export abstract class BaseSettingsEditor<TService> extends SettingsBaseEditor<TService, EditorOptions> {
    constructor(container:HTMLElement, service:TService, options:EditorOptions) {
        const path=editorFilePath(options), files=options.files?.fs;
        super(container,service,options,{t:key=>t(key as Parameters<typeof t>[0]),escapeAttr,entityIcon:ENTITY_ICONS.llm,iconChoices:SETTINGS_ICON_CHOICES,operationId:randomUUID},
            path&&files?{rename:name=>files.driver.rename(path,name),updateMetadata:changes=>files.driver.updateMetadata(path,changes)}:undefined);
    }
}
export type IEditorHostContext=NonNullable<EditorOptions['hostContext']>;
