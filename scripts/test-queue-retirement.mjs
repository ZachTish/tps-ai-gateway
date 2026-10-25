import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,existsSync} from 'node:fs';
const result=await build({entryPoints:['src/main.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'obsidian',setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const Platform = {isMacOS:false,isIosApp:false}; export class Plugin {} export class PluginSettingTab {} export class App {} export class Notice {} export class Setting {} export class SecretComponent {} export const requestUrl=()=>{throw Error("Unexpected provider request")};'}));}}]});
const {default:Gateway}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const request={taskId:'fixture',messages:[{role:'user',content:'synthetic'}],schema:{type:'object'}};
function harness(order=['openai']){
 const g=new Gateway(),calls=[];
 g.settings={providerOrder:order,ollamaEnabled:true,openAiApiKeySecret:'fixture',geminiApiKeySecret:'fixture'};
 g.app={vault:new Proxy({}, {get(){assert.fail('Queue accessed vault');}})};
 g.loadSettings=async()=>{};g.addSettingTab=()=>{};g.addCommand=()=>{};
 g.registerObsidianProtocolHandler=()=>{};g.registerEvent=()=>assert.fail('Queue listener registered');g.registerInterval=()=>assert.fail('Queue timer registered');
 g.readSecret=()=> 'synthetic';
 g.completeStructuredLocally=async(r,providers)=>{calls.push({r,providers});return {data:{ok:true},provider:providers[0],model:'fixture',traceId:'fixture',attempts:1};};
 return {g,calls};
}
test('activation and unload register no queue listeners, timers or vault work',async()=>{
 const {g}=harness();await g.onload();assert.equal(g.api.features.appleIntelligence,false);assert.equal(g.app.tpsAiGateway,g.api);g.onunload();assert.equal(g.app.tpsAiGateway,undefined);
 const source=readFileSync('src/main.ts','utf8');assert.doesNotMatch(source,/scheduleRemoteQueueScan|scanRemoteQueue|createRemoteJob|waitForRemoteJob|setInterval|vault\.on|Request files folder/);assert.equal(existsSync('src/remote-queue.ts'),false);
});
test('each direct provider route still forwards the explicit request without a file handoff',async()=>{
 for(const provider of ['openai','gemini','ollama']){const {g,calls}=harness([provider]);const r=await g.completeStructured(request);assert.equal(r.provider,provider);assert.equal(calls.length,1);assert.deepEqual(calls[0].r.messages,request.messages);}
});
test('retired Apple and durable requests fail before direct backup or file work',async()=>{
 const apple=harness(['apple','openai']);await assert.rejects(apple.g.completeStructured(request),/unavailable.*retired/);assert.equal(apple.calls.length,0);
 const durable=harness();await assert.rejects(durable.g.completeStructured({...request,durableJobId:'old-request'}),/Durable AI jobs are retired/);assert.equal(durable.calls.length,0);
});
test('missing credentials cannot fall back to writing a queue file',async()=>{
 const {g,calls}=harness();g.readSecret=()=>'';await assert.rejects(g.completeStructured(request),/File-queue fallback is retired/);assert.equal(calls.length,0);
});

test('20 real settings loads preserve saved data and provider order without credential or storage writes',async()=>{
 const shared={settingsVersion:2,providerOrder:['openai'],openAiApiKey:'synthetic-legacy',remoteQueueFolder:'Existing queue'};
 const before=structuredClone(shared);let reads=0,localReads=0;
 const g=new Gateway();g.loadData=async()=>{reads++;return structuredClone(shared);};g.saveData=async()=>assert.fail('Startup shared settings write');
 g.app={loadLocalStorage(){localReads++;return null;},saveLocalStorage(){assert.fail('Startup local write');},secretStorage:new Proxy({}, {get(){assert.fail('Startup credential access');}})};
 for(let i=0;i<20;i++)await g.loadSettings();
 assert.equal(reads,20);assert.equal(localReads,20);assert.deepEqual(shared,before);assert.deepEqual(g.settings.providerOrder,['openai']);
});

test('an explicit model change preserves inert queue settings and other saved fields',async()=>{
 let local={settingsVersion:3,providerOrder:['openai'],remoteQueueFolder:'Existing queue',previousQueueFolders:['Old queue'],futureField:{keep:true}};let writes=0;
 const g=new Gateway();g.loadData=async()=>({});g.app={loadLocalStorage:()=>structuredClone(local),saveLocalStorage:(_key,value)=>{writes++;local=structuredClone(value);}};
 await g.loadSettings();assert.equal(writes,0);g.settings.openAiModel='explicit-model';await g.saveSettings();
 assert.equal(writes,1);assert.equal(local.openAiModel,'explicit-model');assert.equal(local.remoteQueueFolder,'Existing queue');assert.deepEqual(local.previousQueueFolders,['Old queue']);assert.deepEqual(local.futureField,{keep:true});
});

test('unload while settings are loading cannot publish a late API or register owners',async()=>{
 const {g}=harness();let finish;
 g.loadSettings=()=>new Promise(resolve=>{finish=resolve;});
 let registrations=0;g.addSettingTab=()=>{registrations++;};g.addCommand=()=>{registrations++;};
 const loading=g.onload();g.onunload();finish();await loading;
 assert.equal(registrations,0);assert.equal(g.app.tpsAiGateway,undefined);assert.equal(g.api,undefined);
});
