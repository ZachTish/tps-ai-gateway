import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {readFileSync} from 'node:fs';
globalThis.require=createRequire(import.meta.url);
async function load(file) {
 const built=await build({entryPoints:[file],bundle:true,write:false,platform:'node',format:'esm'});
 return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
}
const cli=await load('src/subscription-cli.ts');
const {AppleShortcutConnection,APPLE_MAX_INPUT,APPLE_MAX_RESULT}=await load('src/apple-shortcuts.ts');
const {sanitizeSettings,DEFAULT_SETTINGS}=await load('src/settings.ts');
const messages=[{role:'user',content:'Synthetic $(touch no) `secret` ü'}],schema={type:'object',required:['ok'],properties:{ok:{type:'boolean'}}};

test('fresh installs make no implicit provider selection; old selections and new fields round trip',()=>{
 assert.deepEqual(DEFAULT_SETTINGS.providerOrder,[]);
 const old=sanitizeSettings({providerOrder:['apple','openai'],appleIntelligenceEnabled:false});
 assert.deepEqual(old.providerOrder,['apple','openai']);assert.equal(old.appleIntelligenceEnabled,false);
 const modern=sanitizeSettings({providerOrder:['gemini-cli','apple-shortcuts','compatible','grok-cli'],appleShortcutName:'Personal AI',geminiCliModel:'custom'});
 assert.equal(modern.appleShortcutName,'Personal AI');assert.equal(modern.geminiCliModel,'custom');assert.equal(modern.providerOrder.length,4);
});
test('subscription environment excludes billing keys, inherited tools and arbitrary node injection',()=>{
 const base={HOME:'/Users/test',PATH:'/usr/bin',XAI_API_KEY:'secret',GEMINI_API_KEY:'secret',NODE_OPTIONS:'evil',GROK_CONFIG:'evil'};
 for(const provider of ['gemini-cli','grok-cli']){
  const env=cli.cliEnvironment(provider,'/private/profile',base);
  assert.equal(env.HOME,base.HOME);assert.equal(env.XAI_API_KEY,undefined);assert.equal(env.GEMINI_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.GROK_CONFIG,undefined);
 }
 assert.deepEqual(cli.GEMINI_PROFILE_SETTINGS.tools.core,[]);assert.equal(cli.GEMINI_PROFILE_SETTINGS.hooksConfig.enabled,false);
 assert.equal(cli.GEMINI_PROFILE_SETTINGS.security.auth.enforcedType,'oauth-personal');
});
test('command arguments never contain the prompt and Grok does not use an empty allowlist (which means all tools)',()=>{
 const args=cli.cliArguments('grok-cli','model; echo bad','/tmp/request.json');
 assert.equal(args[args.indexOf('--tools')+1],'read_file');
 assert.match(args[args.indexOf('--disallowed-tools')+1],/read_file,Agent/);
 assert.ok(args.includes('MCPTool'));assert.ok(args.includes('model; echo bad'));assert.ok(!args.includes('--yolo'));
 assert.ok(!JSON.stringify(args).includes(messages[0].content));
 assert.deepEqual(JSON.parse(cli.structuredPrompt(messages,schema)).messages,messages);
});
test('CLI envelopes are parsed without exposing error payloads',()=>{
 assert.equal(cli.parseCliResponse('gemini-cli','{"response":" {\\"ok\\":true} "}'),'{"ok":true}');
 assert.equal(cli.parseCliResponse('grok-cli','{"text":"{\\"ok\\":true}"}'),'{"ok":true}');
 for(const input of ['garbage','{"error":"secret"}','{}'])assert.throws(()=>cli.parseCliResponse('gemini-cli',input),e=>!e.message.includes('secret'));
});
test('subprocess input stays literal; output limit, deadline, failures and cancellation terminate work',async()=>{
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','HOME','TMPDIR'].includes(k)));
 const options={cwd:tmpdir(),env,timeoutMs:2000};
 const result=await cli.runProcess(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{...options,input:messages[0].content});assert.equal(result,messages[0].content);
 await assert.rejects(cli.runProcess(process.execPath,['-e','process.stdout.write("x".repeat(1048577))'],options),/size limit/);
 await assert.rejects(cli.runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{...options,timeoutMs:30}),/timed out/);
 await assert.rejects(cli.runProcess(process.execPath,['-e','process.stderr.write("secret");process.exit(1)'],options),e=>!e.message.includes('secret'));
 const pending=cli.runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],options);cli.cancelSubscriptionRequests();await assert.rejects(pending,/closed/);
});
test('Apple handoff verifies nonce/vault, completes once, preserves exact prompt and rejects overlapping requests',async()=>{
 let url;const connection=new AppleShortcutConnection(v=>url=v,()=> 'unique-nonce',1000);
 const pending=connection.request('TPS AI','Synthetic vault',messages,schema);
 const parsed=new URL(url);assert.equal(parsed.searchParams.get('name'),'TPS AI');assert.deepEqual(JSON.parse(parsed.searchParams.get('text')).messages,messages);
 let settled=false;pending.then(()=>settled=true);
 connection.receive({nonce:'wrong',vault:'Synthetic vault',status:'success',result:'{}'});
 connection.receive({nonce:'unique-nonce',vault:'wrong',status:'success',result:'{}'});await Promise.resolve();assert.equal(settled,false);
 await assert.rejects(connection.request('TPS AI','Synthetic vault',messages,schema),/already running/);
 connection.receive({nonce:'unique-nonce',vault:'Synthetic vault',status:'success',result:'{"ok":true}'});
 assert.equal((await pending).text,'{"ok":true}');connection.receive({nonce:'unique-nonce',vault:'Synthetic vault',status:'success',result:'different'});
});
test('Apple cancellation, errors, oversized input/result, timeout and unload fail without fallback',async()=>{
 for(const status of ['cancel','error']){
  const c=new AppleShortcutConnection(()=>{},()=> 'nonce',100);const p=c.request('AI','vault',messages,schema);
  c.receive({nonce:'nonce',vault:'vault',status,'errorMessage':'secret'});await assert.rejects(p,e=>!e.message.includes('secret'));
 }
 const c=new AppleShortcutConnection(()=>{},()=> 'nonce',20);
 await assert.rejects(c.request('AI','vault',[{role:'user',content:'x'.repeat(APPLE_MAX_INPUT)}],schema),/too large/);
 const over=c.request('AI','vault',messages,schema);c.receive({nonce:'nonce',vault:'vault',status:'success',result:'x'.repeat(APPLE_MAX_RESULT+1)});await assert.rejects(over,/oversized/);
 await assert.rejects(c.request('AI','vault',messages,schema),/timeout/);
 const close=c.request('AI','vault',messages,schema);c.dispose();await assert.rejects(close,/closed/);
});
test('build never deploys and settings CSS is scoped and responsive',()=>{
 assert.doesNotMatch(readFileSync('esbuild.config.mjs','utf8'),/runtimeDeploy|deploy-runtime/);
 const css=readFileSync('styles.css','utf8');assert.match(css,/@media/);assert.match(css,/:focus-visible/);assert.match(css,/height: auto/);
});
