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
export const Platform = { isIosApp: false };
export class Plugin {}
export class PluginSettingTab { constructor(app) { this.app = app; this.containerEl = new Element(); } }
class Control {
  constructor(el) { this.selectEl = el; }
  addOption(value, label) { (this.options ||= {})[value] = label; return this; }
  setValue(value) { this.value = value; return this; }
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
  addComponent(callback) { this.control = callback(this.controlEl); return this; }
}
export class SecretComponent extends Control { constructor(app, el) { super(el); } }
export class TFile {}
export class Vault {}
export async function requestUrl() { throw new Error('No network in UI tests'); }
`;
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'ui-stub', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js' }));
  } }],
});
const { AiGatewaySettingTab } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function setup(order = ['apple', 'ollama', 'openai', 'gemini']) {
  let saves = 0;
  const plugin = { settings: { providerOrder: order, appleIntelligenceEnabled: false, ollamaEnabled: false, openAiModel: 'existing', geminiModel: 'existing', enableLogging: false }, saveSettings: async () => { saves++; } };
  const tab = new AiGatewaySettingTab({}, plugin);
  tab.display();
  return { plugin, tab, saves: () => saves, fields: () => tab.containerEl.all().filter(el => el.setting).map(el => el.setting), elements: () => tab.containerEl.all() };
}
const field = (ui, prefix) => ui.fields().find(item => item.name.startsWith(prefix));

test('opening settings preserves existing routes and exposes every legacy backup without saving', async () => {
  const ui = setup();
  assert.equal(ui.saves(), 0);
  assert.deepEqual(ui.plugin.settings.providerOrder, ['apple', 'ollama', 'openai', 'gemini']);
  assert.equal(field(ui, 'Backup AI').control.value, 'existing');
  for (const [provider, label] of [['ollama', 'Ollama URL'], ['openai', 'OpenAI API key'], ['gemini', 'Google AI API key']]) {
    field(ui, 'Configure existing backup').control.change(provider);
    assert.ok(field(ui, label));
    assert.ok(ui.elements().find(el => el.attrs['data-ai-focus'] === 'backup-editor').focused);
  }
  assert.equal(ui.saves(), 0);
  assert.ok(field(ui, 'Use TishOS Apple Intelligence'));
  assert.equal(ui.elements().filter(el => el.tag === 'details').length, 1);
  assert.ok(field(ui, 'Enable logging'));
});

test('all modes show only their provider controls and keep disabled provider configuration editable', async () => {
  const ui = setup(['openai']);
  assert.ok(field(ui, 'OpenAI API key'));
  assert.equal(field(ui, 'Ollama URL'), undefined);
  for (const [label, provider, visible] of [['On device', 'ollama', 'Ollama URL'], ['TPS routed', 'apple', 'Use TishOS Apple Intelligence'], ['Cloud', 'gemini', 'Google AI model']]) {
    ui.elements().find(el => el.tag === 'button' && el.text === label).click();
    await Promise.resolve();
    assert.deepEqual(ui.plugin.settings.providerOrder, [provider]);
    assert.ok(field(ui, visible));
    assert.equal(ui.elements().filter(el => el.attrs['aria-pressed'] === 'true').length, 1);
    assert.ok(ui.elements().find(el => el.attrs['data-ai-focus'] === 'primary').focused);
  }
  assert.equal(ui.plugin.settings.appleIntelligenceEnabled, false);
  assert.equal(ui.plugin.settings.ollamaEnabled, false);
  assert.equal(ui.plugin.settings.openAiModel, 'existing');
});

test('backup selection replaces only the backup chain and none removes its editor', async () => {
  const ui = setup();
  await field(ui, 'Backup AI').control.change('gemini');
  assert.deepEqual(ui.plugin.settings.providerOrder, ['apple', 'gemini']);
  assert.ok(field(ui, 'Google AI API key'));
  assert.equal(field(ui, 'Configure existing backup'), undefined);
  assert.equal(field(ui, 'Ollama URL'), undefined);
  await field(ui, 'Backup AI').control.change('none');
  assert.deepEqual(ui.plugin.settings.providerOrder, ['apple']);
  assert.equal(field(ui, 'Google AI API key'), undefined);
  assert.ok(ui.elements().find(el => el.attrs['data-ai-focus'] === 'backup').focused);
});

test('selecting a former backup as primary removes duplicates and preserves remaining backups', async () => {
  const ui = setup();
  ui.elements().find(el => el.tag === 'button' && el.text === 'Cloud').click();
  await Promise.resolve();
  assert.deepEqual(ui.plugin.settings.providerOrder, ['openai', 'ollama', 'gemini']);
  field(ui, 'Cloud provider').control.change('gemini');
  await Promise.resolve();
  assert.deepEqual(ui.plugin.settings.providerOrder, ['gemini', 'ollama']);
});

test('empty provider order remains empty until an explicit primary selection', async () => {
  const ui = setup([]);
  assert.equal(ui.saves(), 0);
  assert.equal(field(ui, 'Backup AI').control.disabled, true);
  assert.equal(ui.elements().filter(el => el.attrs['aria-pressed'] === 'true').length, 0);
  ui.elements().find(el => el.tag === 'button' && el.text === 'Cloud').click();
  await Promise.resolve();
  assert.deepEqual(ui.plugin.settings.providerOrder, ['gemini']);
});
