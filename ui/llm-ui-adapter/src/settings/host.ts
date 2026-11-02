import {settingsNavigation} from './navigation';
import * as presentation from '@itookit/common';
import {createSettingsUI,type SettingsHost,type SettingsEditorOptions,type SettingsUI} from '@itookit/llm-ui/settings';
import * as rules from '@itookit/kernel-adapters/contracts';
import * as config from '@itookit/kernel-adapters/llm/config';
import {getPrimaryProtocol,getProviderProtocols,getProviderDefaultProtocol,modelReasoning,isReasoningCapabilities,isMediaCatalog,requireMediaCapabilities,API_PROTOCOLS} from '@itookit/driver-llm/contracts';
import {mcpConfiguration,mcpTimeoutMs} from '@itookit/tools/mcp-contracts';
import yaml from 'js-yaml';
import {editorFilePath,type EditorOptions} from '@itookit/ui-common-adapter';

function prepareOptions(value:unknown):SettingsEditorOptions {
    const options=(value??{}) as EditorOptions, path=editorFilePath(options), files=options.files?.fs;
    return {...options,...settingsNavigation(options),...(path&&files?{resource:{rename:(name:string)=>files.driver.rename(path,name),updateMetadata:(changes:Record<string,unknown>)=>files.driver.updateMetadata(path,changes)}}:{})};
}
const host:SettingsHost={
    presentation:{...presentation,iconChoices:presentation.SETTINGS_ICON_CHOICES,get credentialHelp(){return [presentation.t('provider.credentials.storage'),presentation.t('provider.credentials.process')];},t:(key,params)=>presentation.t(key as presentation.LocaleKey,params),
        escapeHTML:value=>presentation.escapeHTML(String(value??'')),escapeAttr:value=>presentation.escapeAttr(String(value??''))},
    rules:{...rules,...config,getPrimaryProtocol,getProviderProtocols,getProviderDefaultProtocol,modelReasoning,isReasoningCapabilities,isMediaCatalog,requireMediaCapabilities,API_PROTOCOLS,mcpConfiguration,mcpTimeoutMs},
    codecs:{yaml:{load:yaml.load,dump:yaml.dump}},prepareOptions,
};
export const settings:SettingsUI=createSettingsUI(host);
