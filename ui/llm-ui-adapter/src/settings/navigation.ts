import {t} from '@itookit/common';
import type {SettingsEditorOptions} from '@itookit/llm-ui/settings';
import type {EditorOptions} from '@itookit/ui-common-adapter';

export function settingsNavigation(options:EditorOptions):Pick<SettingsEditorOptions,'navigation'|'consumeAnchor'|'relatedConfiguration'> {
    const host=options.hostContext;
    return {navigation:host?{open:path=>host.navigate(path==='/model-defaults'?{target:'settings',resourceId:'model-defaults'}:{target:'toolbox',resourceId:path}),
        href:path=>path==='/model-defaults'?'#/settings/model-defaults':'#/toolbox/'+encodeURIComponent(path)}:undefined,
        consumeAnchor:()=>consumeAnchor(),relatedConfiguration:id=>id==='openai'&&host?{label:t('provider.auth.title'),open:async service=>{
            if(!service.getProviders().some(provider=>provider.id==='chatgpt')) {
                const defaults=service.getProviderDefaults().chatgpt;if(!defaults)throw new Error(t('toolbox.resourceMissing'));await service.saveProvider(defaults);
            }
            await host.navigate({target:'toolbox',resourceId:'/providers/chatgpt'});
        }}:undefined};
}
function consumeAnchor():{anchor:string}|undefined {
    const raw=sessionStorage.getItem('settings_anchor');if(!raw)return;
    sessionStorage.removeItem('settings_anchor');
    try {const value=JSON.parse(raw) as {target?:string;anchor?:string;timestamp?:number};
        if(value.target==='settings'&&typeof value.anchor==='string'&&typeof value.timestamp==='number'&&Date.now()-value.timestamp<=5000)return {anchor:value.anchor};
    }catch { /* An invalid navigation hint must not change editor state. */ }
}
