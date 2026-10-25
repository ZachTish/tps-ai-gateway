import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const stub = `
export class Element {
  constructor(tag = 'div', options = {}) { this.tag = tag; this.text = options.text || ''; this.attrs = options.attr || {}; this.children = []; this.scrollTop = 0; }
  createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  addClass() {}
  empty() { this.children = []; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, callback) { this[type] = callback; }
  focus() { this.focused = true; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  querySelector(selector) { const value = selector.match(/="(.*?)"/)[1]; return this.all().find(el => el.attrs['data-ai-focus'] === value); }
}
export class App {}
export class Notice {}
export const Platform = globalThis.__tpsAiTestPlatform;
export class Plugin {}
export class PluginSettingTab { constructor(app) { this.app = app; this.containerEl = new Element(); } }
class Control {
  constructor(el) { this.selectEl = el; }
  addOption(value, label) { (this.options ||= {})[value] = label; return this; }
  setValue(value) { this.value = value; return this; }
  setPlaceholder(value) { this.placeholder = value; return this; }
  setButtonText(value) { this.text = value; return this; }
  onClick(callback) { this.click = callback; return this; }
  setDisabled(value) { this.disabled = value; return this; }
  onChange(callback) { this.change = callback; return this; }
}
export class Setting {
  constructor(container) { this.el = container.createDiv(); this.el.setting = this; this.controlEl = this.el.createDiv(); }
  setName(name) { this.name = name; return this; }
  setDesc(description) { this.description = description; return this; }
  addDropdown(callback) { this.control = new Control(this.controlEl.createEl('select')); callback(this.control); return this; }
  addToggle(callback) { this.control = new Control(this.controlEl.createEl('input')); callback(this.control); return this; }
  addText(callback) { this.control = new Control(this.controlEl.createEl('input')); callback(this.control); return this; }
  addButton(callback) { this.button = new Control(this.controlEl.createEl('button')); callback(this.button); return this; }
  addComponent(callback) { this.control = callback(this.controlEl); return this; }
}
export class SecretComponent extends Control { constructor(app, el) { super(el); } }
export class TFile {}
export class TFolder {}
export class Vault {}
export async function requestUrl() { throw new Error('No network in UI tests'); }
`;
globalThis.__tpsAiTestPlatform = {isMacOS: true, isIosApp: false};
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'ui-stub', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js' }));
  } }],
});
const { AiGatewaySettingTab, AiConnectionSettings } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function setup(order = ['apple', 'ollama', 'openai', 'gemini']) {
  let saves = 0;
  const plugin = { settings: { providerOrder: order, appleIntelligenceEnabled: false, ollamaEnabled: false, openAiModel: 'existing', geminiModel: 'existing', enableLogging: false }, saveSettings: async () => { saves++; } };
  const tab = new AiConnectionSettings({}, plugin, new AiGatewaySettingTab({}).containerEl);
  tab.display();
  return { plugin, tab, saves: () => saves, fields: () => tab.containerEl.all().filter(el => el.setting).map(el => el.setting), elements: () => tab.containerEl.all() };
}
const field = (ui, prefix) => ui.fields().find(item => item.name.startsWith(prefix));

test('settings now configure providers directly without Controller, writes or requests', () => {
  const ui = setup(['gemini-cli']);
  assert.equal(ui.saves(), 0);
  assert.ok(field(ui, 'Provider'));
  assert.ok(field(ui, 'Connect Google Gemini'));
  assert.equal(field(ui, 'OpenAI API key'), undefined);
  assert.equal(ui.elements().filter(el => el.tag === 'details').length, 1);
  assert.ok(field(ui, 'Enable logging'));
  const tab = new AiGatewaySettingTab({}, ui.plugin); tab.display();
  assert.ok(tab.containerEl.all().some(el => el.setting?.name === 'Provider'));
  assert.ok(!tab.containerEl.all().some(el => el.setting?.name === 'AI connections'));
  tab.hide(); assert.equal(ui.saves(), 0);
});

test('Google eligibility distinguishes work accounts from discontinued consumer CLI access',()=>{
 const ui=setup(['gemini-cli']);
 assert.match(field(ui,'Provider').control.options['gemini-cli'],/Eligible work account/);
 assert.ok(ui.elements().some(el=>el.text.includes('ended personal Google AI Pro/Ultra access')));
 assert.ok(ui.elements().some(el=>el.text.includes('Antigravity')));
 const api=setup(['gemini']);assert.match(field(api,'Google AI API key').description,/billed separately/);
});

test('all providers expose only their own connection fields and explicit test', async () => {
  const ui = setup([]);
  const cases = [
    ['gemini-cli','Connect Google Gemini'], ['grok-cli','Connect Grok'],
    ['apple-shortcuts','Shortcut name'], ['compatible','API base URL'],
    ['gemini','Google AI API key'], ['openai','OpenAI API key'], ['ollama','Ollama URL'],
  ];
  for (const [id, name] of cases) {
    await field(ui, 'Provider').control.change(id); await Promise.resolve();
    assert.deepEqual(ui.plugin.settings.providerOrder, [id]);
    assert.ok(field(ui, name), id);
    assert.ok(field(ui, 'Test connection'), id);
    assert.ok(ui.elements().find(el => el.attrs['data-ai-focus'] === 'primary').focused);
  }
  assert.equal(ui.plugin.settings.ollamaEnabled, false);
  assert.equal(ui.plugin.settings.openAiModel, 'existing');
});

test('existing retired route and every backup remain editable without implicit migration', async () => {
  const ui = setup();
  assert.deepEqual(ui.plugin.settings.providerOrder, ['apple','ollama','openai','gemini']);
  assert.equal(ui.saves(), 0);
  assert.ok(field(ui, 'Retired Apple bridge'));
  assert.equal(field(ui, 'Backup provider').control.value, 'existing');
  for (const [id,name] of [['ollama','Ollama URL'],['openai','OpenAI API key'],['gemini','Google AI API key']]) {
    field(ui, 'Configure existing backup').control.change(id);
    assert.ok(field(ui, name));
  }
  await field(ui, 'Backup provider').control.change('none');
  assert.deepEqual(ui.plugin.settings.providerOrder, ['apple']);
  assert.equal(field(ui, 'Configure existing backup'), undefined);
});

test('selecting an existing backup as primary avoids duplicates and preserves other backups', async () => {
  const ui=setup();
  field(ui,'Provider').control.change('gemini'); await Promise.resolve();
  assert.deepEqual(ui.plugin.settings.providerOrder,['gemini','ollama','openai']);
});

test('mobile clearly labels desktop-only connections and disables connect/test', () => {
  globalThis.__tpsAiTestPlatform.isMacOS=false;
  const ui=setup(['gemini-cli']);
  assert.equal(field(ui,'Connect Google Gemini').button.disabled,true);
  assert.equal(field(ui,'Test connection').button.disabled,true);
  assert.ok(ui.elements().some(el => el.text.includes('cannot run on iPhone')));
  globalThis.__tpsAiTestPlatform.isMacOS=true;
});

test('test targets exactly the selected provider and no calls happen during rendering', async()=>{
 const ui=setup(['openai']);const calls=[];ui.plugin.validateProviderChain=async p=>calls.push(p);
 assert.equal(calls.length,0);await field(ui,'Test connection').button.click();assert.deepEqual(calls,['openai']);
});

test('disposed editor cannot rerender after delayed save and failure restores route', async()=>{
 const ui=setup(['openai']);let finish;ui.plugin.saveSettings=()=>new Promise(resolve=>finish=resolve);
 field(ui,'Provider').control.change('gemini');const before=ui.tab.containerEl.children;ui.tab.dispose();finish();await Promise.resolve();
 assert.equal(ui.tab.containerEl.children,before);
 const failed=setup(['openai']);failed.plugin.saveSettings=async()=>{throw Error('disk')};
 field(failed,'Provider').control.change('gemini');await Promise.resolve();await Promise.resolve();assert.deepEqual(failed.plugin.settings.providerOrder,['openai']);
});
