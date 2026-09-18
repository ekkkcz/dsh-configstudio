/**
 * 用户设置测试 —— 外部插件能力开关与持久化（用户反馈 1）。
 *
 * 核心约定（都是用户明确要求的）：
 *  - **默认一律关**：探测到另一个插件 ≠ 应该替用户启用它。
 *  - 设置**跟随数据目录**持久化，不用浏览器本地存储。
 *  - 认不出来的东西一律忽略，坏文件不能让插件起不来。
 * 全部为本地文件操作，零模型费用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, CAPABILITIES, defaultSettings, normalizeSettings, capabilityEnabled, SETTINGS_VERSION } from '../src/core/settings.js';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'arena-settings-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('默认值：所有外部能力一律关闭（反馈 1 的核心要求）', () => {
  const d = defaultSettings();
  for (const c of CAPABILITIES) {
    assert.equal(d.capabilities[c.key], false, c.key + ' 默认必须是关');
    assert.equal(c.defaultEnabled, false, c.key + ' 的声明式默认值也必须是 false');
  }
  assert.equal(d.version, SETTINGS_VERSION);
});

test('清单里每一项都写明了来源与代价（不能是"匿名能力"）', () => {
  assert.ok(CAPABILITIES.length >= 1);
  for (const c of CAPABILITIES) {
    assert.ok(c.key && c.label, 'key 与 label 必填');
    assert.match(c.source, /^@|^[a-z]/i, '必须写明来自哪个外部包');
    assert.ok(c.what && c.what.length > 10, '必须说明开启后会发生什么');
    assert.ok(c.cost && c.cost.length > 4, '必须说明代价（会花钱 / 会调用谁）');
  }
});

test('全新数据目录：读出来是默认值，且不写盘（不产生副作用）', () => withDir((dir) => {
  const s = new SettingsStore(dir);
  const v = s.read();
  assert.equal(v.capabilities['prompt-optimizer'], false);
  assert.equal(existsSync(join(dir, 'settings.json')), false, '只是读一次不该创建文件');
}));

test('写入后能读回来，并且真的落盘在数据目录里（跟随数据目录而非浏览器）', () => withDir((dir) => {
  const s = new SettingsStore(dir);
  const r = s.update({ capabilities: { 'prompt-optimizer': true } });
  assert.equal(r.ok, true);
  assert.equal(r.settings.capabilities['prompt-optimizer'], true);
  const file = join(dir, 'settings.json');
  assert.ok(existsSync(file), '设置必须落在数据目录里');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.capabilities['prompt-optimizer'], true);
  // 换一个 Store 实例（模拟重启 / 换浏览器）也要读到同一份
  assert.equal(new SettingsStore(dir).read().capabilities['prompt-optimizer'], true);
}));

test('关闭也是显式写入，不会"删掉键就变回默认"造成歧义', () => withDir((dir) => {
  const s = new SettingsStore(dir);
  s.update({ capabilities: { 'prompt-optimizer': true } });
  s.update({ capabilities: { 'prompt-optimizer': false } });
  assert.equal(s.read().capabilities['prompt-optimizer'], false);
}));

test('认不出的能力键被忽略并如实回报，不写进文件', () => withDir((dir) => {
  const s = new SettingsStore(dir);
  const r = s.update({ capabilities: { 'prompt-optimizer': true, 'some-other-plugin': true } });
  assert.deepEqual(r.rejected, ['some-other-plugin']);
  assert.equal('some-other-plugin' in r.settings.capabilities, false);
}));

test('非布尔值被拒绝，不猜（"false" 字符串不等于 false）', () => withDir((dir) => {
  const s = new SettingsStore(dir);
  const r = s.update({ capabilities: { 'prompt-optimizer': 'false' } });
  assert.equal(r.rejected.length, 1);
  assert.equal(r.settings.capabilities['prompt-optimizer'], false);
}));

test('坏掉的设置文件退回默认值并说明原因，不让插件不可用', () => withDir((dir) => {
  writeFileSync(join(dir, 'settings.json'), '{ 这不是 JSON', 'utf8');
  const s = new SettingsStore(dir);
  const v = s.read();
  assert.equal(v.capabilities['prompt-optimizer'], false, '坏文件必须退回默认值（默认关，安全侧）');
  assert.match(s.error, /无法解析/);
}));

test('未知字段与未来版本号：忽略但告知，不崩', () => {
  const { settings, notes } = normalizeSettings({ version: 99, capabilities: { 'prompt-optimizer': true }, 未来字段: 1 });
  assert.equal(settings.capabilities['prompt-optimizer'], true, '已知字段仍要生效');
  assert.ok(notes.some((n) => /版本/.test(n)), '要提示版本不一致');
});

test('capabilityEnabled 是唯一判定入口，默认关', () => withDir((dir) => {
  const s = new SettingsStore(dir);
  assert.equal(capabilityEnabled(s, 'prompt-optimizer'), false);
  s.update({ capabilities: { 'prompt-optimizer': true } });
  assert.equal(capabilityEnabled(s, 'prompt-optimizer'), true);
}));

test('给界面用的视图：把"探测到"与"已启用"分成两件事讲清楚', () => withDir((dir) => {
  const s = new SettingsStore(dir);
  const detected = { 'prompt-optimizer': { available: true, current: { provider: 'p', model: 'm' } } };
  const v = s.view(detected);
  const cap = v.capabilities[0];
  assert.equal(cap.detected, true, '探测到了');
  assert.equal(cap.enabled, false, '但默认没有启用 —— 这正是用户要的选择权');
  assert.equal(cap.detectedCurrent.provider, 'p');
}));

test('没探测到时也如实说明，开关仍可预先打开', () => withDir((dir) => {
  const s = new SettingsStore(dir);
  const v = s.view({ 'prompt-optimizer': { available: false, reason: '连不上' } });
  const cap = v.capabilities[0];
  assert.equal(cap.detected, false);
  assert.equal(cap.detectedReason, '连不上');
  const r = s.update({ capabilities: { 'prompt-optimizer': true } });
  assert.equal(r.ok, true, '没装也可以先打开，等它装好就生效');
}));
