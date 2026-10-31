// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {packageConfiguration,readPackageSettings} from '../src/toolbox/package-configuration';
import type {ToolPackageInfo} from '@itookit/app-contracts/services';
it('shows real inherited defaults and preselects a sole account while retaining saved overrides',()=>{
 const item={id:'package',version:'1',status:'registered',configuration:{enabled:false,defaults:{},tools:[{id:'collect',parameters:[{name:'connection',type:'string',widget:'select',options:['personal'],default:'personal'},{name:'maxItems',type:'number',default:100}]}]}} as ToolPackageInfo;
 const root=document.createElement('div');root.innerHTML=packageConfiguration(item,false);
 expect(root.textContent).toContain('默认：100');expect(JSON.parse(root.querySelector('select')!.value)).toBe('personal');
 expect(readPackageSettings(root.querySelector('form')!,item).defaults.collect).toEqual({connection:'personal'});
 item.configuration!.defaults.collect={connection:'old-account'};root.innerHTML=packageConfiguration(item,false);
 expect(root.querySelector('select')!.selectedOptions[0].textContent).toContain('old-account');
});
it('hides compatibility tools, preserves their overrides and folds YAML-declared advanced parameters',()=>{
 const item={id:'package',version:'1',status:'registered',configuration:{enabled:true,disabledTools:[],defaults:{legacy:{directory:'old'}},tools:[
 {id:'collect',label:'Collect resources',advanced:['directory'],parameters:[{name:'directory',type:'string'}]},
 {id:'legacy',hidden:true,parameters:[{name:'directory',type:'string'}]}]}} as ToolPackageInfo;
 const root=document.createElement('div');root.innerHTML=packageConfiguration(item,false);
 expect(root.textContent).toContain('Collect resources');expect(root.querySelector('[data-package-tool=legacy]')).toBeNull();
 const advanced=root.querySelector('[name="collect.directory"]')!.closest('details')!;expect(advanced.open).toBe(false);
 root.querySelector<HTMLInputElement>('[data-tool-enabled]')!.checked=false;
 const value=readPackageSettings(root.querySelector('form')!,item);expect(value.disabledTools).toEqual(['collect']);expect(value.defaults.legacy).toEqual({directory:'old'});
});
