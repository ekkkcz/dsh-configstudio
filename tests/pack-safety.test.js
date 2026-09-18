/**
 * M3 安全与一致性回归（独立核查发现的问题，逐条钉住）。
 *
 * 这一批断言都来自"独立只读核查 + 实测复现"，与 tests/pack.test.js 的常规性质互补：
 * 那边验的是"功能对不对"，这边验的是"边界上会不会自坏 / 被绕过 / 落半截"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip, readZip, ZipError, checkEntryName, isExecutableName } from '../src/core/zip.js';
import {
  buildRetestPack, buildShowcasePack, parseRetestPack, sanitizeOutputPolicy, sanitizePreviewPolicy,
} from '../src/core/pack.js';
import { taskHashOf } from '../src/core/task.js';
import { recipeHash, normalizeRecipeContent } from '../src/core/recipe.js';
import { sha256 } from '../src/core/canonical.js';
import { Store } from '../src/core/store.js';

const TOOL = { name: 'HTML Arena', version: 'test' };
const NOW = '2026-09-18T00:00:00.000Z';

function experiment(over = {}) {
  return {
    id: 'exp_t', title: '测试', category: 'dashboard',
    taskSnapshot: { prompt: '做一个页面', startHtml: null, outputRequirements: '' },
    outputPolicy: {}, previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
    createdAt: 1, updatedAt: 2, status: 'completed', ...over,
  };
}
function attempt(slot, recipe = {}) {
  return {
    id: 'att_' + slot, slot, attemptNo: 1, status: 'completed',
    recipe: { name: '候选 ' + slot, provider: 'p', model: 'm', systemPrompt: '', promptSegments: [], temperature: null, maxTokens: null, reasoningEffort: null, ...recipe },
    extraction: { htmlHash: 'h' + slot },
    receipt: { startedAt: 1, finishedAt: 2 }, error: null,
  };
}
const packOf = (entries) => readZip(writeZip(entries));
const entriesOf = (built) => built.entries.map((e) => ({ name: e.name, data: e.data }));

/**
 * 改完条目内容后把清单重新盖章（否则先撞到的是 hash 校验，测不到下面要测的那条守卫）。
 * 真实攻击者当然不会重新盖章 —— 但那属于"被 hash 拦下"，另有测试覆盖。
 */
function reseal(entries) {
  const pack = entries.find((e) => e.name === 'pack.json');
  let manifest = null;
  try { manifest = JSON.parse(pack.data.toString('utf8')); } catch { manifest = null; }
  // pack.json 本身被改坏（null / 数组）时没法盖章，也不需要盖章 —— 那正是要测的形状守卫
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return entries;
  manifest.contents = entries.filter((e) => e.name !== 'pack.json')
    .map((e) => ({ path: e.name, bytes: e.data.length, sha256: sha256(e.data) }));
  pack.data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  return entries;
}

test('【高1 回归】题目/配方里含本机路径时，导出→导入仍然一致（不再自己拒自己）', async () => {
  const prompt = '参考 D:\\开发\\dsh插件\\样例.html 的做法，做一个天气页。';
  const sysPrompt = '你是前端专家，风格参考 /home/user/templates/base.html。';
  const exp = experiment({ taskSnapshot: { prompt, startHtml: null, outputRequirements: '单文件' } });
  const built = await buildRetestPack({
    experiment: exp, attempts: [attempt(0, { systemPrompt: sysPrompt })], options: {}, tool: TOOL, now: NOW,
  });
  const zip = packOf(entriesOf(built));
  const parsed = await parseRetestPack(zip);   // 以前这里会抛 hash-mismatch「包被改过」
  const sourceTaskHash = await taskHashOf(exp.taskSnapshot);
  assert.equal(parsed.summary.taskHash, sourceTaskHash, '题目指纹必须与源实验一致');
  assert.equal(parsed.task.prompt, prompt, '题目正文逐字节不变（用户的内容不替它改）');
  const taskEntry = zip.entries.find((e) => e.name === 'task.json');
  assert.equal(JSON.parse(taskEntry.data.toString('utf8')).prompt, prompt);
  const rec = zip.entries.find((e) => e.name === 'recipes.json');
  assert.equal(JSON.parse(rec.data.toString('utf8')).candidates[0].recipe.systemPrompt, sysPrompt);
  assert.equal(parsed.recipes.candidates[0].contentHash, recipeHash(attempt(0, { systemPrompt: sysPrompt }).recipe));
});

test('【高2 回归】标题/作品里含路径时，报告仍然闭合、作品逐字节不变', async () => {
  const html = '<html><head><title>带路径的作品</title></head><body>路径 D:\\开发\\x\\a.html<script>1</script></body></html>';
  const built = await buildShowcasePack({
    experiment: experiment({ title: '带路径 D:\\开发\\项目 的实验' }),
    attempts: [attempt(0)], shots: [], options: { screenshots: false }, tool: TOOL, now: NOW,
    readHtml: () => html,
  });
  const report = built.entries.find((e) => e.name === 'index.html').data.toString('utf8');
  assert.ok(report.includes('</title>'), '标题必须闭合（脱敏吃到 </title> 会让整页空白）');
  assert.ok(report.includes('</body></html>'));
  assert.equal((report.match(/<h1>/g) || []).length, 1);
  assert.equal(report.includes('D:\\开发'), false, '报告里不该出现本机路径');
  // 报告是 HTML：替换标记会被转义成 &lt;本地路径&gt;
  assert.ok(report.includes('&lt;本地路径&gt;'), '替换后的标记要能看到');
  const work = built.entries.find((e) => e.name.startsWith('works/'));
  assert.equal(work.data.toString('utf8'), html, '作品文件必须逐字节照抄');
  // 报告里印的"作品指纹"必须与包里那份文件的 sha256 一致（以前一个算原字节、一个算打包后字节）
  const manifest = JSON.parse(built.entries.find((e) => e.name === 'pack.json').data.toString('utf8'));
  const listed = manifest.contents.find((c) => c.path === work.name);
  assert.equal(listed.sha256, sha256(work.data));
});

test('【中1 回归】声明的大小撒谎时按声明上限解压（压缩炸弹不再靠信任）', () => {
  const bomb = Buffer.from(writeZip([{ name: 'bomb.json', data: 'A'.repeat(4 * 1024 * 1024) }]));
  // 把中央目录与本地头的 usize 都改成 1024：三条"解压前"的闸门会全被绕过
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(1024, central + 24);
  bomb.writeUInt32LE(1024, 22);
  const before = process.memoryUsage().arrayBuffers;
  const t0 = Date.now();
  assert.throws(() => readZip(bomb), (err) => err instanceof ZipError && err.code === 'size-mismatch');
  const elapsed = Date.now() - t0;
  const grew = process.memoryUsage().arrayBuffers - before;
  assert.ok(elapsed < 500, '必须在解压上限处立刻停下，耗时 ' + elapsed + 'ms');
  assert.ok(grew < 16 * 1024 * 1024, '不该为撒谎的条目分配几十 MB：+' + Math.round(grew / 1024 / 1024) + 'MB');
});

test('【中2 回归】包里的输出规则被钳制，清单自述不作数', async () => {
  assert.deepEqual(sanitizeOutputPolicy({ timeoutMs: -1, maxTokens: 'abc', concurrency: 0 }).policy,
    { maxTokens: null, timeoutMs: null, concurrency: null });
  assert.equal(sanitizeOutputPolicy({ timeoutMs: 1e15 }).warnings.length, 1);
  assert.equal(sanitizeOutputPolicy({ timeoutMs: 120000 }).policy.timeoutMs, 120000);
  assert.equal(sanitizePreviewPolicy({ networkPolicy: 'weird', viewport: 'mobile' }).policy.networkPolicy, 'offline');
  assert.equal(sanitizePreviewPolicy({ networkPolicy: 'cdn' }).policy.networkPolicy, 'cdn');

  // 清单谎报"包含题目"，而 task.json 里题目是空的
  const built = await buildRetestPack({
    experiment: experiment({ taskSnapshot: { prompt: '真实题目', startHtml: null, outputRequirements: '' } }),
    attempts: [attempt(0)], options: { prompt: false }, tool: TOOL, now: NOW,
  });
  const entries = entriesOf(built);
  const pack = entries.find((e) => e.name === 'pack.json');
  const manifest = JSON.parse(pack.data.toString('utf8'));
  manifest.task.included.prompt = true;
  manifest.output = { maxTokens: 'abc', timeoutMs: 1e15, concurrency: 0 };
  manifest.candidates[0].letter = 'A<script>alert(1)</script>';
  pack.data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const parsed = await parseRetestPack(packOf(entries));
  assert.equal(parsed.summary.promptIncluded, false, '要按 task.json 的实际内容判断');
  assert.ok(parsed.warnings.some((w) => w.includes('不一致')));
  assert.equal(parsed.sanitized.outputPolicy.timeoutMs, null);
  assert.equal(parsed.sanitized.outputPolicy.maxTokens, null);
  assert.equal(parsed.sanitized.outputPolicy.concurrency, null);
  assert.equal(parsed.summary.candidates[0].letter, 'A', '字母由服务端按槽位重算，不采信包里的自由值');
});

test('【中2 回归】槽位重复 / 形状畸形都被拒绝，得到 400 而不是 500', async () => {
  const built = await buildRetestPack({
    experiment: experiment(), attempts: [attempt(0), attempt(1)], options: {}, tool: TOOL, now: NOW,
  });
  const withDupSlot = entriesOf(built).map((e) => {
    if (e.name !== 'recipes.json') return e;
    const doc = JSON.parse(e.data.toString('utf8'));
    doc.candidates[1].slot = 0;
    doc.candidates[1].contentHash = doc.candidates[0].contentHash;
    doc.candidates[1].recipe = doc.candidates[0].recipe;
    return { name: e.name, data: Buffer.from(JSON.stringify(doc, null, 2) + '\n') };
  });
  await assert.rejects(() => parseRetestPack(packOf(reseal(withDupSlot))), (err) => err.code === 'bad-recipes');

  for (const [label, mutate] of [
    ['pack.json = null', (es) => { es.find((e) => e.name === 'pack.json').data = Buffer.from('null'); }],
    ['pack.json = []', (es) => { es.find((e) => e.name === 'pack.json').data = Buffer.from('[]'); }],
    ['task.json = null', (es) => { es.find((e) => e.name === 'task.json').data = Buffer.from('null'); }],
    ['recipes.candidates = [null]', (es) => {
      const e2 = es.find((e) => e.name === 'recipes.json');
      const doc = JSON.parse(e2.data.toString('utf8'));
      doc.candidates = [null];
      e2.data = Buffer.from(JSON.stringify(doc, null, 2) + '\n');
    }],
  ]) {
    const entries = entriesOf(built);
    mutate(entries);
    reseal(entries);
    await assert.rejects(() => parseRetestPack(packOf(entries)),
      (err) => {
        assert.ok(err instanceof ZipError, label + ' 抛的不是 ZipError：' + err.name + ' ' + err.message);
        assert.ok(!/Cannot read propert/.test(err.message), label + ' 落到了 TypeError（会变成 500）：' + err.message);
        return true;
      }, label);
  }
});

test('【中3 回归】本地头名字与中央目录不一致的包被拒绝（差分解析）', async () => {
  const built = await buildRetestPack({ experiment: experiment(), attempts: [attempt(0)], options: {}, tool: TOOL, now: NOW });
  const buf = Buffer.from(writeZip(entriesOf(built)));
  // 只改本地头那一处的 task.json -> 'ab/evil.json'（同长度 9）
  const at = buf.indexOf(Buffer.from('task.json'));
  buf.write('ab/evil.j', at, 'utf8');
  assert.throws(() => readZip(buf), (err) => err.code === 'name-mismatch');
});

test('【中4 回归】Windows 语义的名字与可绕过的扩展名都被拒绝', () => {
  for (const bad of ['a.html:ads', 'con/x.html', 'a.html.', 'a.html ', 'a//b.txt', 'evil.js.', 'evil.ps1 ']) {
    assert.throws(() => writeZip([{ name: bad, data: 'x' }]), (err) => err instanceof ZipError, JSON.stringify(bad));
  }
  assert.equal(isExecutableName('evil.js.'), true);
  assert.equal(isExecutableName('evil.exe '), true);
  // 大小写与 Unicode 归一化后重名的包：拒绝
  const dupCase = writeZip([{ name: 'A.json', data: '1' }, { name: 'a.json', data: '2' }]);
  assert.throws(() => readZip(dupCase), (err) => err.code === 'duplicate-name');
  const nfc = 'é.txt';
  const nfd = 'e\u0301.txt';
  const dupUnicode = writeZip([{ name: nfc, data: '1' }, { name: nfd, data: '2' }]);
  assert.throws(() => readZip(dupUnicode), (err) => err.code === 'duplicate-name');
  assert.equal(checkEntryName('dir/').ok, true, '目录条目仍然合法');
});

test('【低1 回归】导入写库是一个事务：中途失败不会留下半个实验或半套配方', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-tx-'));
  const store = new Store(dir);
  try {
    const before = store.listExperiments().length;
    assert.throws(() => {
      store.transact(() => {
        store.createExperiment({
          title: '半成品', category: '', taskSnapshot: { prompt: 'p' }, taskHash: 'h',
          outputPolicy: {}, previewPolicy: {},
        });
        store.createRecipe({ name: '半套配方', note: null, snapshot: { provider: 'p', model: 'm' }, source: 'pack-import' });
        throw new Error('模拟第 3 步失败');
      });
    }, /模拟第 3 步失败/);
    assert.equal(store.listExperiments().length, before, '实验表必须回滚');
    assert.equal(store.listRecipes().length, 0, '配方表必须回滚');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('【低3 回归】报告里的 src/href 只接受包内相对路径', async () => {
  const { renderShowcaseReport } = await import('../src/core/report.js');
  const report = renderShowcaseReport({
    experiment: { title: 't', category: '' },
    task: { prompt: 'p', startHtml: null, outputRequirements: '' },
    taskHash: 'h',
    candidates: [{
      slot: 0, letter: 'A', revealed: true, name: 'x', statusLabel: '已完成',
      workFile: 'javascript:alert(1)', rawFile: 'data:text/html;base64,PHNjcmlwdD4=', needsNetwork: false, externalRefs: [],
    }],
    vote: null, screenshots: [{ file: 'javascript:alert(2)', caption: 'x' }],
    privacy: { included: [], excluded: [], notes: [] },
    tool: TOOL, generatedAt: NOW, schemaVersion: 1,
  });
  assert.equal((report.match(/<iframe/g) || []).length, 0, '非法地址不该生成 iframe');
  assert.equal(/javascript:/.test(report), false);
  assert.equal(/<img/.test(report), false);
  assert.ok(report.includes('包内路径不合法'));
  // 正常的相对路径仍然生成 iframe（不是把所有东西都挡掉了）
  const ok = renderShowcaseReport({
    experiment: { title: 't', category: '' },
    task: { prompt: 'p', startHtml: null, outputRequirements: '' },
    taskHash: 'h',
    candidates: [{ slot: 0, letter: 'A', revealed: true, statusLabel: '已完成', workFile: 'works/a.html', needsNetwork: false, externalRefs: [] }],
    vote: null, screenshots: [],
    privacy: { included: [], excluded: [], notes: [] },
    tool: TOOL, generatedAt: NOW, schemaVersion: 1,
  });
  assert.equal((ok.match(/<iframe/g) || []).length, 1);
});

test('【低4 回归】展示包导出后自校验：清单与实际条目一一对应', async () => {
  const built = await buildShowcasePack({
    experiment: experiment(), attempts: [attempt(0), attempt(1)],
    shots: [{ file: 'shots/a-desktop.png', data: Buffer.from([0x89, 0x50]), viewport: 'desktop', caption: 'A', meta: {} }],
    options: {}, tool: TOOL, now: NOW, readHtml: () => '<html><body>x</body></html>',
    screenshotRecords: [{ id: 's1', status: 'ok' }],
  });
  const manifest = built.manifest;
  const names = built.entries.map((e) => e.name).filter((n) => n !== 'pack.json').sort();
  assert.deepEqual(manifest.contents.map((c) => c.path).sort(), names);
  for (const c of manifest.contents) {
    const entry = built.entries.find((e) => e.name === c.path);
    assert.equal(c.sha256, sha256(entry.data), c.path);
  }
});

test('【低4 回归】候选字母只有一个来源（slotLetter）', async () => {
  const { slotLetter } = await import('../src/core/pack.js');
  assert.deepEqual([0, 1, 2, 3].map(slotLetter), ['A', 'B', 'C', 'D']);
  assert.equal(slotLetter(99), '?');
  void normalizeRecipeContent;
});
