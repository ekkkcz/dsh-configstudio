/**
 * M4-2 升级 / 卸载验收 —— 0.4.0 → 0.5.0 的真实升级路径、schema 2 → 3 的迁移与**回退边界**、
 * 卸载后的数据保留。
 *
 * 为什么必须单独写：
 *  - 单测（tests/recipes.test.js）用**手工构造的老库**验证迁移逻辑，证明的是"迁移代码对"；
 *    这里要证明的是"**装 0.4.0、跑出数据、再装 0.5.0**"这条真实路径也对。
 *  - "回退边界"是用户真实会遇到的事：升到 0.5.0 之后若把插件退回 0.4.0，
 *    0.4.0 看到 schema 3 会怎样？必须**明确拒绝并给出可读原因**，不能静默损坏数据。
 *
 * 做法：**不碰用户任何现有 profile**，全部在临时目录里自建两个数据目录：
 *   A) 用交付区 v0.4.0 的 tgz 装进一个临时 profile → 起服务 → 造数据（模拟模型，零费用）
 *   B) 同一个 profile 换成 v0.5.0 的 tgz → 起服务 → 核对迁移与数据保留
 *   C) 再把 v0.4.0 装回去 → 核对"拒绝打开且原因可读"（回退边界）
 *   D) 卸载插件 → 核对数据目录仍在、配置里不再出现本插件
 *
 * 用法：node scripts/m4-upgrade-uninstall-check.mjs [--v040 <tgz>] [--v050 <tgz>]
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { launchBrowser } from '../src/preview/browser.js';
import { EVIDENCE_DIR, sleep, freePort, startDevServer, waitHealthy, hardKill, makeChecker, api, postJson } from './lib/devhost.mjs';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
/**
 * 老交付包的 tgz 文件名**故意不改**：v0.4.0 / v0.5.0 是改名（HTML Arena → ConfigStudio）
 * **之前**发出去的包，文件名就是当时那个名字。把交付区里的历史文件改名，
 * 会让"这一版当时交付了什么"变得无法核对 —— 历史交付物保持原样，
 * 所以这里按"当时的名字"去找，而不是跟着当前包名走。
 *
 * 仍允许用 `--v040/--v050` 显式指定（也接受新名字，方便以后重新打包的老版本）。
 */
function pickVintage(version, explicit) {
  if (explicit) return explicit;
  const dir = join('..', '交付区', 'v' + version);
  const candidates = [
    'html-arena-' + version + '.tgz',      // 改名前的历史交付物（当前两个都是这个）
    'configstudio-' + version + '.tgz',    // 改名后重新打包的
    'dsh-external-configstudio-' + version + '.tgz',  // npm pack 的默认命名
  ];
  for (const name of candidates) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return join(dir, candidates[0]);   // 一个都没有：报错时给出最常见的那条路径
}
const V040 = pickVintage('0.4.0', getArg('--v040', null));
const V050 = pickVintage('0.5.0', getArg('--v050', null));

/**
 * 从一个交付 tgz 里读出它的**真实身份**：包名、API 前缀、版本。
 *
 * 为什么必须读、不能写死：这个脚本装的是**历史交付物**（v0.4.0 / v0.5.0），
 * 它们是改名（HTML Arena → ConfigStudio）**之前**发出去的包 ——
 * 包名 `@dsh-external/html-arena`、API 前缀 `/html-arena`。
 *
 * 改名时把这里的期望一起改成了新名字，于是脚本开始断言"装完 0.4.0 之后
 * profile 里能看到 @dsh-external/configstudio"、并去等 `/configstudio/api` 就绪 ——
 * 而 0.4.0 里**根本没有**这个名字与前缀。这是**不可能成立**的期望，
 * 2026-09-21 的完整回归就是这样假红了一次（5/7）。
 *
 * 读 tgz 里的 package.json 才是唯一可靠来源，顺带也覆盖"以后再次改名"。
 */
function vintageOf(tgzPath) {
  const m = /^(?:dsh-external-)?([a-z0-9-]+)-(\d+\.\d+\.\d+)\.tgz$/.exec(basename(tgzPath));
  const fallback = m ? { pkgName: '@dsh-external/' + m[1], version: m[2], prefix: '/' + m[1] } : null;
  const dir = mkdtempSync(join(tmpdir(), 'arena-vintage-'));
  try {
    // tar 在 Windows 10+ 自带；解不开就退回"按文件名推"
    const r = spawnSync('tar', ['-xzf', tgzPath, '-C', dir], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (r.status !== 0) return fallback;
    const pj = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8'));
    let prefix = null;
    try {
      const idx = readFileSync(join(dir, 'package', 'src', 'index.js'), 'utf8');
      const mm = /API_PREFIX = '([^']+)'/.exec(idx) || /API_PREFIX = "([^"]+)"/.exec(idx);
      if (mm) prefix = mm[1];
    } catch { /* 读不到就按包名推一个 */ }
    return { pkgName: pj.name, version: pj.version, prefix: prefix || ('/' + String(pj.name).split('/').pop()) };
  } catch {
    return fallback;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

// 两个历史版本各自的真实身份（包名 / 前缀 / 版本），后面所有断言都对着它做
const ID40 = vintageOf(V040);
const ID50 = vintageOf(V050);

const { add, report, finish } = makeChecker({
  what: 'M4-2 升级 / 卸载：0.4.0 → 0.5.0、schema 2 → 3 迁移与回退边界、数据保留',
  note: '模拟模型，零费用；全程在临时数据目录，不碰用户现有 profile',
  extra: { v040: V040, v050: V050 },
});

/** 直接读 sqlite 的 schema_version 与表的清单（不经过插件，避免"用被测物证明被测物"）。 */
function readSchema(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const cols = db.prepare('PRAGMA table_info(attempts)').all().map((c) => c.name);
    return { version: row ? Number(row.value) : null, tables, attemptsCols: cols };
  } finally { db.close(); }
}

function countRows(dbPath, table) {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare('SELECT COUNT(*) c FROM ' + table).get().c; } finally { db.close(); }
}

const dataDir = mkdtempSync(join(tmpdir(), 'arena-m4-upgrade-'));
const profileName = 'arena-m4up-' + Math.random().toString(36).slice(2, 8);
let server = null;

/** 把某个 tgz 装进临时 profile（用 dsh 自己的命令，与用户操作一致）。 */
function dshPlugin(verb, spec) {
  const argv = ['plugin', '--profile', profileName, verb];
  if (spec) argv.push(spec);
  const r = spawnSync('dsh', argv, { encoding: 'utf8', shell: true, windowsHide: true, timeout: 180000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * 起服务，**加载指定那份安装里的产品代码**（`root` 指向已安装的包目录）。
 *
 * 这一点是本脚本的关键：如果这里跑的是仓库里当前这份代码，
 * "升级验证"就变成了"用新代码验证新代码"，一点意义都没有。
 */
async function serve(root, prefix = ID50.prefix) {
  const port = await freePort();
  server = startDevServer({ port, dataDir, latencyMs: 120, root });
  // 前缀来自**那一版包自己的** API_PREFIX：0.4.0 / 0.5.0 是 /html-arena，
  // 写死新名字会让"装老版本"这一步永远等不到就绪（实测假红过一次）。
  await waitHealthy('http://127.0.0.1:' + port + prefix + '/api', 25000);
  return 'http://127.0.0.1:' + port + prefix + '/api';
}

/** 某个版本的包在临时 profile 里被装到了哪个目录（包名不同，目录名也不同）。 */
function installedRootOf(id) {
  return join(process.env.USERPROFILE || '', '.dsh', 'profiles', profileName, 'node_modules', '@dsh-external', String(id.pkgName).split('/').pop());
}

/** 已安装包目录（每次装完/卸完都会重新求值）：0.4.0 与 0.5.0 的目录名不同。 */
function installedRoot(id = ID50) { return installedRootOf(id); }
/** 读那份安装自己的 package.json 版本（不经过插件，避免自证）。 */
function installedVersion(id = ID50) {
  const p = join(installedRootOf(id), 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).version || null; } catch { return null; }
}
async function stop() { if (server) { await hardKill(server, '直连服务'); server = null; } }

try {
  // ── 0) 前置：两个 tgz 真的都在
  add('前置', 'v0.4.0 的 tgz 存在', existsSync(V040), { path: V040 });
  add('前置', 'v0.5.0 的 tgz 存在', existsSync(V050), { path: V050 });

  // ── A) 装 0.4.0 到临时 profile（真实 dsh 命令）
  const inst40 = dshPlugin('add', V040);
  add('A 装 0.4.0', 'dsh plugin add v0.4.0 成功', inst40.code === 0, { code: inst40.code, tail: inst40.out.slice(-200) });
  const profPkg = join(process.env.USERPROFILE || '', '.dsh', 'profiles', profileName, 'package.json');
  const pkg40 = existsSync(profPkg) ? readFileSync(profPkg, 'utf8') : '';
  // 0.4.0 的包名是 @dsh-external/html-arena（改名前的名字）—— 期望值来自那份 tgz 自己
  add('A 装 0.4.0', 'profile 的 bundles 里出现了本插件（用 0.4.0 自己的包名判）',
    pkg40.includes(ID40.pkgName), { expect: ID40.pkgName, hasBundles: pkg40.includes('dsh-web-app') });
  add('A 装 0.4.0', 'package.json 没有 BOM（BOM 会让 DSH 读不了配置）',
    existsSync(profPkg) && readFileSync(profPkg)[0] !== 0xEF, { firstByte: existsSync(profPkg) ? readFileSync(profPkg)[0] : null });

  // ── A2) 用 0.4.0 的代码造数据（模拟模型，零费用）
  const base = await serve(installedRootOf(ID40), ID40.prefix);
  const meta0 = await api(base, '/meta');
  add('A 造数据', '跑起来的确实是**装进去的那份 0.4.0**（不是仓库里当前这份）',
    installedVersion(ID40) === ID40.version && meta0.status === 200 && String(meta0.body.pluginVersion).startsWith(ID40.version),
    { installedPkg: installedVersion(ID40), served: meta0.body && meta0.body.pluginVersion, vintage: ID40 });

  // 建一个实验 + 一个配方（走真实接口）
  const exp = await postJson(base, '/experiments', {
    title: 'M4 升级测试（0.4.0 造的）', prompt: '做一个只有一行大字的页面', category: 'landing',
    candidates: [
      { name: '候选 A', provider: 'sim-ok-a', model: 'sim-fast' },
      { name: '候选 B', provider: 'sim-ok-b', model: 'sim-fast' },
    ],
  });
  add('A 造数据', '0.4.0 上能建实验', exp.status < 300 && Boolean(exp.body && exp.body.experiment), { status: exp.status });
  const expId = exp.body.experiment.id;

  // 跑一轮（模拟模型，零费用）。走的是产品真实的 /start 入口：它自己建 attempt、走并发闸门。
  const started = await postJson(base, '/experiments/' + expId + '/start', {
    candidates: [
      { name: '候选 A', provider: 'sim-ok-a', model: 'sim-fast' },
      { name: '候选 B', provider: 'sim-ok-b', model: 'sim-fast' },
    ],
    concurrency: 2,
  });
  report.startResponse = { status: started.status, started: started.body && started.body.started, error: started.body && started.body.error, problems: started.body && started.body.problems };
  add('A 造数据', '/start 接受了这一轮（真 attempt，不是空壳实验）',
    started.status === 202 && ((started.body && started.body.started) || []).length === 2,
    { status: started.status, started: started.body && started.body.started, error: started.body && started.body.error, problems: started.body && started.body.problems });

  // 等两个候选都跑完
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    const st = await api(base, '/experiments/' + expId);
    const list = (st.body && st.body.attempts) || [];
    if (list.length >= 2 && list.every((a) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(a.status))) break;
  }
  const before = await api(base, '/experiments/' + expId);
  const attemptsBefore = (before.body && before.body.attempts) || [];
  // 用**内容指纹**当口径：只有真的从库里取到 hash 才算数，取不到就是 null，
  // 那样下面的对比会退化成 "null === null" 的假绿（第一版就是这么踩的）。
  const fp = (a) => a.extraction && a.extraction.rawTextHash;
  report.attemptsBefore = attemptsBefore.map((a) => ({ slot: a.slot, status: a.status, rawTextHash: fp(a), htmlHash: a.extraction && a.extraction.htmlHash }));
  add('A 造数据', '0.4.0 上跑完两个候选（模拟模型）', attemptsBefore.length >= 2,
    { attempts: attemptsBefore.length, statuses: attemptsBefore.map((a) => a.status) });

  // 存一个配方（0.4.0 已有配方对象）
  const rec = await postJson(base, '/recipes', { name: 'M4 升级配方', snapshot: { provider: 'sim-ok-a', model: 'sim-fast', temperature: 0.7 } });
  add('A 造数据', '0.4.0 上能存配方', rec.status < 300, { status: rec.status });

  const dbPath = join(dataDir, 'arena.db');
  const schema40 = readSchema(dbPath);
  add('A 造数据', '0.4.0 写出的库是 schema 2（升级前的真实起点）', schema40.version === 2, schema40);
  add('A 造数据', 'schema 2 的库里**没有** pack_imports 表（0.5.0 才加的）',
    !schema40.tables.includes('pack_imports'), { tables: schema40.tables });
  const expCount40 = countRows(dbPath, 'experiments');
  const attCount40 = countRows(dbPath, 'attempts');
  const recCount40 = countRows(dbPath, 'recipes');
  report.before40 = { schema: schema40.version, experiments: expCount40, attempts: attCount40, recipes: recCount40 };
  await stop();

  // ── B) 同一个 profile 换成 0.5.0（真实的升级路径）
  const rm40 = dshPlugin('remove', ID40.pkgName);
  add('B 升级', '先卸载 0.4.0（用它的真实包名）', rm40.code === 0, { code: rm40.code, pkgName: ID40.pkgName });
  const inst50 = dshPlugin('add', V050);
  add('B 升级', '再装 0.5.0（这就是用户的升级动作）', inst50.code === 0, { code: inst50.code, tail: inst50.out.slice(-160) });

  const base2 = await serve(installedRootOf(ID50), ID50.prefix);
  const meta1 = await api(base2, '/meta');
  add('B 升级', '升级后跑的是装进去的 0.5.0，且数据目录已迁移',
    installedVersion(ID50) === ID50.version && meta1.status === 200 && String(meta1.body.pluginVersion).startsWith(ID50.version),
    { installedPkg: installedVersion(ID50), served: meta1.body && meta1.body.pluginVersion, vintage: ID50 });

  const schema50 = readSchema(dbPath);
  add('B 迁移', '数据目录被迁移到 schema 3', schema50.version === 3, { before: schema40.version, after: schema50.version });
  add('B 迁移', 'schema 3 里出现了 pack_imports 表（新增，不改老列）',
    schema50.tables.includes('pack_imports'), { tables: schema50.tables });
  add('B 迁移', 'attempts 表的既有列一个没丢（只加列不改列）',
    schema40.attemptsCols.every((c) => schema50.attemptsCols.includes(c)),
    { before: schema40.attemptsCols, after: schema50.attemptsCols });
  add('B 迁移', '迁移也补上了 2→3 之前就该有的配方引用列',
    schema50.attemptsCols.includes('recipe_id') && schema50.attemptsCols.includes('recipe_version'),
    { attemptsCols: schema50.attemptsCols });

  // 数据保留：行数、内容、作品文件
  const expCount50 = countRows(dbPath, 'experiments');
  const attCount50 = countRows(dbPath, 'attempts');
  const recCount50 = countRows(dbPath, 'recipes');
  add('B 数据保留', '实验条数一摸一样', expCount50 === expCount40, { before: expCount40, after: expCount50 });
  add('B 数据保留', 'attempt 条数一摸一样', attCount50 === attCount40, { before: attCount40, after: attCount50 });
  add('B 数据保留', '配方条数一摸一样', recCount50 === recCount40, { before: recCount40, after: recCount50 });

  const after = await api(base2, '/experiments/' + expId);
  const attemptsAfter = (after.body && after.body.attempts) || [];
  add('B 数据保留', '升级后那条实验还能打开，且 attempt 状态与内容都在',
    after.status === 200 && attemptsAfter.length === attemptsBefore.length,
    { status: after.status, before: attemptsBefore.map((a) => a.status), after: attemptsAfter.map((a) => a.status) });
  const beforeHashes = attemptsBefore.map(fp);
  const afterHashes = attemptsAfter.map(fp);
  const beforeHtml = attemptsBefore.map((a) => a.extraction && a.extraction.htmlHash);
  const afterHtml = attemptsAfter.map((a) => a.extraction && a.extraction.htmlHash);
  add('B 数据保留', '升级前确实拿到了正文指纹（否则下面的"一致"是 null === null 的假绿）',
    beforeHashes.length === 2 && beforeHashes.every((h) => typeof h === 'string' && h.length === 64), { beforeHashes });
  add('B 数据保留', '升级后 attempt 的**正文指纹**与升级前逐条一致',
    JSON.stringify(beforeHashes) === JSON.stringify(afterHashes) && afterHashes.every((h) => typeof h === 'string'),
    { beforeHashes, afterHashes });
  add('B 数据保留', '升级后作品 HTML 的指纹也与升级前逐条一致',
    JSON.stringify(beforeHtml) === JSON.stringify(afterHtml) && afterHtml.every((h) => typeof h === 'string'),
    { beforeHtml, afterHtml });
  add('B 数据保留', '两个候选的作品 HTML 互不相同（不是同一个文件被算了两次）',
    new Set(afterHtml).size === afterHtml.length, { afterHtml });

  const recipes50 = await api(base2, '/recipes?full=1');
  add('B 数据保留', '升级后配方还在，且带版本记录',
    recipes50.status === 200 && (recipes50.body.recipes || []).length >= 1,
    { count: (recipes50.body && recipes50.body.recipes || []).length });

  // 作品文件（artifacts）也要在
  const artDir = join(dataDir, 'artifacts');
  const artFiles = existsSync(artDir) ? readdirSync(artDir) : [];
  add('B 数据保留', '作品正文文件（artifacts）在升级后仍然存在', artFiles.length > 0, { files: artFiles.length });
  await stop();

  // ── C) 回退边界：把 0.4.0 装回去，它必须**明确拒绝**打开 schema 3
  const back = dshPlugin('remove', ID50.pkgName);
  add('C 回退边界', '卸掉 0.5.0', back.code === 0, { code: back.code, pkgName: ID50.pkgName });
  const reinstall40 = dshPlugin('add', V040);
  add('C 回退边界', '把 0.4.0 装回去（用户真实的回退动作）', reinstall40.code === 0, { code: reinstall40.code });

  // 直接跑 0.4.0 的 Store 去看它对 schema 3 的反应（比起服务更直接地看到"拒绝打开"这句话）
  const profileNM = installedRootOf(ID40);   // 此刻装回去的是 0.4.0
  const storeUrl = 'file:///' + join(profileNM, 'src', 'core', 'store.js').replace(/\\/g, '/');
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', [
    "const { Store } = await import(process.argv[1]);",
    "try { const s = new Store(process.argv[2]); s.close(); console.log('OPENED schema=' + 'unexpected'); }",
    "catch (e) { console.log('REFUSED ' + (e && e.message || e)); }",
  ].join(String.fromCharCode(10)), storeUrl, dataDir], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const refusedLine = ((probe.stdout || '') + (probe.stderr || '')).trim().split(String.fromCharCode(10)).filter(Boolean).pop() || '';
  report.rollbackProbe = { code: probe.status, line: refusedLine.slice(0, 300) };
  add('C 回退边界', '0.4.0 打开 schema 3 的目录时**明确拒绝**，而不是静默按老结构读',
    refusedLine.startsWith('REFUSED'), { line: refusedLine.slice(0, 220) });
  add('C 回退边界', '拒绝信息里写清了原因与出路（schema 号 + 请升级插件）',
    /schema/.test(refusedLine) && /升级|upgrade/.test(refusedLine), { line: refusedLine.slice(0, 220) });
  // 拒绝之后数据必须**原封不动**（没被老版本改写）
  const schemaAfterRollback = readSchema(dbPath);
  add('C 回退边界', '拒绝打开之后数据目录仍是 schema 3、行数未变（没有被老版本动过）',
    schemaAfterRollback.version === 3 && countRows(dbPath, 'experiments') === expCount50,
    { schema: schemaAfterRollback.version, experiments: countRows(dbPath, 'experiments') });

  // ── D) 卸载：数据保留
  const rmFinal = dshPlugin('remove', ID40.pkgName);
  add('D 卸载', 'dsh plugin remove 成功', rmFinal.code === 0, { code: rmFinal.code });
  const pkgAfterRemove = existsSync(profPkg) ? readFileSync(profPkg, 'utf8') : '';
  add('D 卸载', '卸载后 profile 的 bundles 里不再出现本插件',
    !pkgAfterRemove.includes(ID40.pkgName) && !pkgAfterRemove.includes(ID50.pkgName),
    { stillThere: [ID40.pkgName, ID50.pkgName].filter((n) => pkgAfterRemove.includes(n)) });
  add('D 卸载', '卸载后数据目录**仍然存在**（用户记录不被静默删除）',
    existsSync(dbPath) && existsSync(artDir), { db: existsSync(dbPath), artifacts: existsSync(artDir) });
  add('D 卸载', '卸载后数据库仍可读、行数未变',
    existsSync(dbPath) && countRows(dbPath, 'experiments') === expCount50, { experiments: countRows(dbPath, 'experiments') });

  // ── E) 再装回来：用户重装后能继续用
  const reinstall50 = dshPlugin('add', V050);
  add('E 重装', '再装 0.5.0 成功', reinstall50.code === 0, { code: reinstall50.code });
  const base3 = await serve(installedRootOf(ID50), ID50.prefix);
  const meta2 = await api(base3, '/meta');
  add('E 重装', '重装后能起来，且仍是装进去的 0.5.0',
    installedVersion(ID50) === ID50.version && meta2.status === 200 && String(meta2.body.pluginVersion).startsWith(ID50.version),
    { installedPkg: installedVersion(ID50), served: meta2.body && meta2.body.pluginVersion });
  const schemaFinal = readSchema(dbPath);
  add('E 重装', '反复装/卸之后 schema 仍是 3，没有被反复迁移', schemaFinal.version === 3, { version: schemaFinal.version });
  const expFinal = await api(base3, '/experiments?limit=200');
  add('E 重装', '重装后那条 0.4.0 造的实验仍在列表里',
    expFinal.status === 200 && (expFinal.body.experiments || []).some((e) => e.id === expId),
    { found: (expFinal.body && expFinal.body.experiments || []).some((e) => e.id === expId), total: (expFinal.body && expFinal.body.experiments || []).length });
  // 浏览器打开一次界面，确认卸载/重装后前端也真的能用
  const b = await launchBrowser();
  if (b.ok) {
    const browser = b.browser;
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
    try {
      await page.goto(base3.replace('/api', '/api/ui'), { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('#mode-badge', { timeout: 20000 });
      await page.waitForTimeout(1500);
      add('E 重装', '重装后界面能打开、0 页面异常且能看到刚装回的那条实验',
        errs.length === 0 && (await page.evaluate(() => (document.getElementById('experiment-list').innerText || '').includes('M4 升级测试'))),
        { pageErrors: errs });
    } catch (err) {
      add('E 重装', '重装后界面能打开', false, String(err && err.message).slice(0, 200));
    } finally { await browser.close(); }
  } else add('E 重装', '可启动浏览器', false, { reason: b.reason });
  await stop();

  report.summaryData = { dataDir: '<tmp>', profile: profileName, beforeSchema: 2, afterSchema: 3 };
} catch (err) {
  report.error = String(err && err.stack || err).slice(0, 1500);
  add('验收', '流程未中断', false, report.error.split(String.fromCharCode(10))[0]);
} finally {
  await stop();
  // 收尾：把临时 profile 删掉（不留垃圾在用户 .dsh 下）；数据目录是 tmp，系统会清
  try {
    rmSync(join(process.env.USERPROFILE || '', '.dsh', 'profiles', profileName), { recursive: true, force: true });
    add('收尾', '临时 profile 已删除（不在用户的 .dsh 下留垃圾）',
      !existsSync(join(process.env.USERPROFILE || '', '.dsh', 'profiles', profileName)));
  } catch (err) {
    add('收尾', '临时 profile 已删除', false, String(err && err.message).slice(0, 200));
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}

process.exitCode = finish('m4-upgrade-uninstall');
