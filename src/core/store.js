/**
 * 存储层：SQLite 只存索引与配置，大对象（原始正文、HTML）落文件系统。
 *
 * 对应 PRD 6.1 / 6.2 与 F06：
 *  - 原始正文不可变；HTML 是从正文提取的派生作品，二者用 hash 关联。
 *  - 所有路径由服务端用对象 ID 解析到插件自有目录，浏览器透传的路径一律不接受。
 *
 * 使用 Node 内置 node:sqlite（Node >= 22.5），避免任何原生编译依赖。
 *
 * @module html-arena/core/store
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { normalizeRecipeContent, recipeHash } from './recipe.js';

/**
 * 数据 schema 版本。改变表结构时提升，并在 #migrateFrom() 里写迁移（验收 A29）。
 *
 * 1 → 2（M2）：新增配方对象与版本表（F19 历史配方不被覆盖）、截图记录表（A23 截图失败要有记录），
 *              attempts 增加 recipe_id / recipe_version 两列（本轮引用启动时的快照）。
 * 迁移是**增量**的：老数据目录打开后原记录不变，只补新表与新列。
 */
export const SCHEMA_VERSION = 2;

/** 生成可信 ID。ID 只由服务端生成，永不接受浏览器提供的 ID 作为权威值。 */
export function newId(prefix) {
  return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 20);
}

/** 生成运行令牌（预览桥接用）。 */
export function newToken() {
  return randomBytes(16).toString('hex');
}

/**
 * 打开（或创建）一个 HTML Arena 存储。
 */
export class Store {
  /**
   * @param {string} dataDir 插件自有数据目录
   */
  constructor(dataDir) {
    this.dataDir = resolve(dataDir);
    this.artifactsDir = join(this.dataDir, 'artifacts');
    this.dbPath = join(this.dataDir, 'arena.db');
    mkdirSync(this.artifactsDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    // 每条语句都必须以 ';' 结束：node:sqlite 的 exec 靠分号切分多条语句。
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS experiments (',
      '  id TEXT PRIMARY KEY,',
      '  title TEXT NOT NULL,',
      '  category TEXT NOT NULL DEFAULT "",',
      '  status TEXT NOT NULL DEFAULT "draft",',
      '  task_snapshot TEXT NOT NULL,',
      '  task_hash TEXT NOT NULL,',
      '  output_policy TEXT NOT NULL,',
      '  preview_policy TEXT NOT NULL,',
      '  version INTEGER NOT NULL DEFAULT 1,',
      '  created_at INTEGER NOT NULL,',
      '  updated_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE IF NOT EXISTS attempts (',
      '  id TEXT PRIMARY KEY,',
      '  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,',
      '  candidate_slot INTEGER NOT NULL,',
      '  attempt_no INTEGER NOT NULL DEFAULT 1,',
      '  recipe_snapshot TEXT NOT NULL,',
      '  requested_config TEXT NOT NULL,',
      '  resolved_config TEXT,',
      '  status TEXT NOT NULL,',
      '  parent_attempt_id TEXT,',
      '  created_at INTEGER NOT NULL,',
      '  updated_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE IF NOT EXISTS receipts (',
      '  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,',
      '  queued_at INTEGER,',
      '  started_at INTEGER,',
      '  first_event_at INTEGER,',
      '  first_text_at INTEGER,',
      '  finished_at INTEGER,',
      '  finish_reason TEXT,',
      '  error_code TEXT,',
      '  error_message TEXT,',
      '  error_status INTEGER,',
      '  usage TEXT,',
      '  observed_requests INTEGER',
      ');',
      'CREATE TABLE IF NOT EXISTS artifacts (',
      '  id TEXT PRIMARY KEY,',
      '  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,',
      '  raw_text_hash TEXT NOT NULL,',
      '  html_hash TEXT,',
      '  extraction_version TEXT,',
      '  extraction_mode TEXT,',
      '  extraction_range TEXT,',
      '  extraction_status TEXT NOT NULL,',
      '  extraction_warnings TEXT,',
      '  raw_path TEXT NOT NULL,',
      '  html_path TEXT,',
      '  bytes INTEGER NOT NULL DEFAULT 0,',
      '  created_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE IF NOT EXISTS votes (',
      '  experiment_id TEXT PRIMARY KEY REFERENCES experiments(id) ON DELETE CASCADE,',
      '  anonymous_mapping TEXT NOT NULL,',
      '  choice TEXT NOT NULL,',
      '  tags TEXT,',
      '  note TEXT,',
      '  created_at INTEGER NOT NULL,',
      '  revealed_at INTEGER',
      ');',
      // 配方是独立对象（PRD 4.1 / F19）：每个版本一行，**只追加、不覆盖**。
      // latest_version 只是"当前指向哪一版"的指针，历史版本仍在 recipe_versions 里可读。
      'CREATE TABLE IF NOT EXISTS recipes (',
      '  id TEXT PRIMARY KEY,',
      '  name TEXT NOT NULL,',
      '  note TEXT,',
      '  latest_version INTEGER NOT NULL DEFAULT 1,',
      '  created_at INTEGER NOT NULL,',
      '  updated_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE IF NOT EXISTS recipe_versions (',
      '  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,',
      '  version INTEGER NOT NULL,',
      '  content_hash TEXT NOT NULL,',
      '  snapshot TEXT NOT NULL,',
      '  note TEXT,',
      '  source TEXT,',
      '  created_at INTEGER NOT NULL,',
      '  PRIMARY KEY (recipe_id, version)',
      ');',
      // 截图记录（A23）：成功与失败都要落盘，"截图失败有明确记录"不能只在界面上一闪而过。
      'CREATE TABLE IF NOT EXISTS screenshots (',
      '  id TEXT PRIMARY KEY,',
      '  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,',
      '  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,',
      '  viewport TEXT NOT NULL,',
      '  status TEXT NOT NULL,',
      '  reason TEXT,',
      '  duration_ms INTEGER,',
      '  detail TEXT,',
      '  created_at INTEGER NOT NULL',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_attempts_experiment ON attempts(experiment_id);',
      'CREATE INDEX IF NOT EXISTS idx_screenshots_experiment ON screenshots(experiment_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_recipe_versions_recipe ON recipe_versions(recipe_id, version DESC);',
      'CREATE INDEX IF NOT EXISTS idx_experiments_updated ON experiments(updated_at DESC);',
    ].join('\n'));

    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    const from = row ? Number(row.value) : 0;
    if (from > SCHEMA_VERSION) {
      // 拒绝打开时必须先释放句柄，否则调用方连删除目录都做不到，且在 Windows 上
      // 会留下一个占用文件的僵尸连接。
      this.close();
      throw new Error('数据目录由更新版本的 HTML Arena 写入（schema ' + row.value + ' > ' + SCHEMA_VERSION + '），请升级插件后再打开');
    }
    // 迁移结果如实留在实例上，供宿主启动日志说明"这个目录被改过什么"。
    this.migratedFrom = from === 0 ? null : (from < SCHEMA_VERSION ? from : null);
    if (from < SCHEMA_VERSION) {
      this.#migrateFrom(from);
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(SCHEMA_VERSION));
    }
  }

  /**
   * 增量迁移。表由上面的 CREATE TABLE IF NOT EXISTS 补齐，这里只处理"已存在的表要加列"。
   * 迁移必须是**幂等**的：反复启动不会报错，也不会丢数据。
   */
  #migrateFrom(from) {
    if (from < 2) {
      // 老库里的 attempts 没有配方引用列。加列不改动任何已有行（值为 null）。
      this.#ensureColumn('attempts', 'recipe_id', 'recipe_id TEXT');
      this.#ensureColumn('attempts', 'recipe_version', 'recipe_version INTEGER');
    }
  }

  /** 表里没有这一列才加（SQLite 没有 ADD COLUMN IF NOT EXISTS）。 */
  #ensureColumn(table, column, ddl) {
    const cols = this.db.prepare('PRAGMA table_info(' + table + ')').all();
    if (!cols.some((c) => c.name === column)) this.db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl + ';');
  }

  /** 数据目录里的文件路径必须由对象 ID 推导，且必须留在 artifacts 目录内。 */
  #artifactPath(id, kind) {
    const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '');
    if (safe.length === 0) throw new Error('非法的对象 ID');
    const p = join(this.artifactsDir, safe + '.' + kind);
    const norm = resolve(p);
    if (!norm.startsWith(this.artifactsDir + sep)) throw new Error('路径越界被拒绝');
    return norm;
  }

  /** 写入原始正文（不可变）。返回 hash 与字节数。 */
  async writeRaw(id, text) {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(text, 'utf8').digest('hex');
    const p = this.#artifactPath(id, 'raw.txt');
    writeFileSync(p, text, 'utf8');
    return { hash, path: p, bytes: Buffer.byteLength(text, 'utf8') };
  }

  /**
   * 写入推理文本（F06：原始正文与推理信息分开保存）。
   * 只保存服务实际返回且允许展示的内容；服务没返回就写空串。
   */
  async writeReasoning(id, reasoning) {
    const p = this.#artifactPath(id, 'reasoning.txt');
    writeFileSync(p, reasoning, 'utf8');
    return { path: p, bytes: Buffer.byteLength(reasoning, 'utf8') };
  }

  readReasoning(id) { return readFileSync(this.#artifactPath(id, 'reasoning.txt'), 'utf8'); }
  hasReasoning(id) { return existsSync(this.#artifactPath(id, 'reasoning.txt')); }

  /** 写入提取出的 HTML（派生作品）。 */
  async writeHtml(id, html) {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(html, 'utf8').digest('hex');
    const p = this.#artifactPath(id, 'html');
    writeFileSync(p, html, 'utf8');
    return { hash, path: p, bytes: Buffer.byteLength(html, 'utf8') };
  }

  /**
   * 生成过程中定期落盘的**部分输出**（A09：宿主被杀时不至于什么都留不下）。
   *
   * 与 raw.txt 的关系：raw 是"跑完之后那一次的完整正文"，只写一次、不可变；
   * partial 是"进程还活着时，最近一次刷盘的尾部正文"，跑完就会被删掉。
   * 两者路径不同，所以不存在"部分内容把最终正文覆盖掉"的情况。
   */
  writePartial(id, text, { truncated = false } = {}) {
    const p = this.#artifactPath(id, 'partial.txt');
    writeFileSync(p, text, 'utf8');
    writeFileSync(this.#artifactPath(id, 'partial.json'), JSON.stringify({
      at: Date.now(), chars: text.length, truncated: Boolean(truncated),
    }), 'utf8');
    return { path: p, chars: text.length, truncated: Boolean(truncated) };
  }

  hasPartial(id) { return existsSync(this.#artifactPath(id, 'partial.txt')); }

  readPartial(id) { return readFileSync(this.#artifactPath(id, 'partial.txt'), 'utf8'); }

  /** 部分输出的元信息（没有就返回 null）—— 界面据此说清"这是中断前收到的多少字符"。 */
  partialInfo(id) {
    if (!this.hasPartial(id)) return null;
    let meta = { at: null, chars: null, truncated: null };
    try { meta = JSON.parse(readFileSync(this.#artifactPath(id, 'partial.json'), 'utf8')); } catch { /* 元信息坏了也不影响正文 */ }
    let bytes = 0;
    try { bytes = statSync(this.#artifactPath(id, 'partial.txt')).size; } catch { bytes = 0; }
    return { chars: meta.chars, at: meta.at, truncated: meta.truncated, bytes };
  }

  removePartial(id) {
    for (const kind of ['partial.txt', 'partial.json']) {
      try { rmSync(this.#artifactPath(id, kind), { force: true }); } catch { /* 不存在就算了 */ }
    }
  }

  readRaw(id) { return readFileSync(this.#artifactPath(id, 'raw.txt'), 'utf8'); }
  readHtml(id) { return readFileSync(this.#artifactPath(id, 'html'), 'utf8'); }
  hasHtml(id) { return existsSync(this.#artifactPath(id, 'html')); }

  createExperiment({ title, category, taskSnapshot, taskHash, outputPolicy, previewPolicy }) {
    const id = newId('exp');
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO experiments (id,title,category,status,task_snapshot,task_hash,output_policy,preview_policy,version,created_at,updated_at)'
      + ' VALUES (?,?,?,?,?,?,?,?,1,?,?)',
    ).run(id, title, category || '', 'draft', JSON.stringify(taskSnapshot), taskHash,
      JSON.stringify(outputPolicy), JSON.stringify(previewPolicy), now, now);
    return this.getExperiment(id);
  }

  getExperiment(id) {
    const r = this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
    return r ? mapExperiment(r) : null;
  }

  listExperiments({ search, category, limit = 100 } = {}) {
    let sql = 'SELECT * FROM experiments';
    const where = [];
    const args = [];
    if (search) { where.push('title LIKE ?'); args.push('%' + search + '%'); }
    if (category) { where.push('category = ?'); args.push(category); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    args.push(limit);
    return this.db.prepare(sql).all(...args).map(mapExperiment);
  }

  touchExperiment(id) {
    this.db.prepare('UPDATE experiments SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  setExperimentStatus(id, status) {
    this.db.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  deleteExperiment(id) {
    // 先删文件，再删记录。配方是独立对象，不随实验删除（PRD 4.1）。
    //
    // 按 **attempt** 收集文件，而不是按 artifacts 表：被中断的尝试往往还没有 artifact 行，
    // 但它可能有 partial 文件（部分输出）。按 artifacts 收集会漏掉这些文件。
    const attempts = this.db.prepare('SELECT id FROM attempts WHERE experiment_id = ?').all(id);
    this.db.prepare('DELETE FROM experiments WHERE id = ?').run(id);
    for (const a of attempts) {
      for (const kind of ['raw.txt', 'html', 'reasoning.txt', 'partial.txt', 'partial.json']) {
        try { rmSync(this.#artifactPath(a.id, kind), { force: true }); } catch { /* 文件缺失不影响删除 */ }
      }
    }
  }

  /**
   * 建一次尝试。
   *
   * recipeSnapshot 是**本次调用实际发出去的那份配置的深拷贝**（F19：本轮继续引用启动时快照）。
   * recipeId / recipeVersion 只是"它从哪个配方的哪一版复制过来"的溯源链接；
   * 配方后来改了，也不会回写到这里 —— 历史由快照本身保证，不靠引用。
   */
  createAttempt({ experimentId, candidateSlot, attemptNo, recipeSnapshot, requestedConfig, resolvedConfig, parentAttemptId, recipeId = null, recipeVersion = null }) {
    const id = newId('att');
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO attempts (id,experiment_id,candidate_slot,attempt_no,recipe_snapshot,requested_config,resolved_config,status,parent_attempt_id,created_at,updated_at,recipe_id,recipe_version)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, experimentId, candidateSlot, attemptNo, JSON.stringify(recipeSnapshot),
      JSON.stringify(requestedConfig), resolvedConfig ? JSON.stringify(resolvedConfig) : null,
      'queued', parentAttemptId || null, now, now,
      recipeId ?? null, Number.isInteger(recipeVersion) ? recipeVersion : null);
    this.db.prepare('INSERT INTO receipts (attempt_id,queued_at) VALUES (?,?)').run(id, now);
    return id;
  }

  updateAttemptStatus(id, status) {
    this.db.prepare('UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  stampReceipt(id, field, value) {
    const allowed = new Set(['started_at', 'first_event_at', 'first_text_at', 'finished_at']);
    if (!allowed.has(field)) throw new Error('不允许写入的收据字段：' + field);
    this.db.prepare('UPDATE receipts SET ' + field + ' = ? WHERE attempt_id = ?').run(value, id);
  }

  finishReceipt(id, { finishReason, errorCode, errorMessage, errorStatus, usage, observedRequests }) {
    this.db.prepare(
      'UPDATE receipts SET finished_at=?, finish_reason=?, error_code=?, error_message=?, error_status=?, usage=?, observed_requests=? WHERE attempt_id=?',
    ).run(Date.now(), finishReason ?? null, errorCode ?? null, errorMessage ?? null,
      errorStatus ?? null, usage ? JSON.stringify(usage) : null, observedRequests ?? null, id);
  }

  getAttempt(id) {
    const r = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
    if (!r) return null;
    const receipt = this.db.prepare('SELECT * FROM receipts WHERE attempt_id = ?').get(id);
    const artifact = this.db.prepare('SELECT * FROM artifacts WHERE attempt_id = ?').get(id);
    return { ...mapAttempt(r), receipt: receipt ? mapReceipt(receipt) : null, artifact: artifact ? mapArtifact(artifact) : null };
  }

  listAttempts(experimentId) {
    const rows = this.db.prepare('SELECT * FROM attempts WHERE experiment_id = ? ORDER BY candidate_slot ASC, attempt_no ASC').all(experimentId);
    return rows.map((r) => {
      const receipt = this.db.prepare('SELECT * FROM receipts WHERE attempt_id = ?').get(r.id);
      const artifact = this.db.prepare('SELECT * FROM artifacts WHERE attempt_id = ?').get(r.id);
      return { ...mapAttempt(r), receipt: receipt ? mapReceipt(receipt) : null, artifact: artifact ? mapArtifact(artifact) : null };
    });
  }

  createArtifact({ id, attemptId, rawHash, htmlHash, extractionVersion, extractionMode, extractionRange, extractionStatus, extractionWarnings, rawPath, htmlPath, bytes }) {
    this.db.prepare(
      'INSERT INTO artifacts (id,attempt_id,raw_text_hash,html_hash,extraction_version,extraction_mode,extraction_range,extraction_status,extraction_warnings,raw_path,html_path,bytes,created_at)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, attemptId, rawHash, htmlHash ?? null, extractionVersion ?? null, extractionMode ?? null,
      extractionRange ? JSON.stringify(extractionRange) : null, extractionStatus,
      extractionWarnings ? JSON.stringify(extractionWarnings) : null, rawPath, htmlPath ?? null, bytes ?? 0, Date.now());
  }

  updateArtifactExtraction(id, { htmlHash, extractionVersion, extractionMode, extractionRange, extractionStatus, extractionWarnings, htmlPath }) {
    this.db.prepare(
      'UPDATE artifacts SET html_hash=?, extraction_version=?, extraction_mode=?, extraction_range=?, extraction_status=?, extraction_warnings=?, html_path=? WHERE id=?',
    ).run(htmlHash ?? null, extractionVersion ?? null, extractionMode ?? null,
      extractionRange ? JSON.stringify(extractionRange) : null, extractionStatus,
      extractionWarnings ? JSON.stringify(extractionWarnings) : null, htmlPath ?? null, id);
  }

  saveVote({ experimentId, anonymousMapping, choice, tags, note }) {
    this.db.prepare(
      'INSERT INTO votes (experiment_id,anonymous_mapping,choice,tags,note,created_at) VALUES (?,?,?,?,?,?)'
      + ' ON CONFLICT(experiment_id) DO UPDATE SET anonymous_mapping=excluded.anonymous_mapping, choice=excluded.choice, tags=excluded.tags, note=excluded.note',
    ).run(experimentId, JSON.stringify(anonymousMapping), choice, tags ? JSON.stringify(tags) : null, note ?? null, Date.now());
  }

  getVote(experimentId) {
    const r = this.db.prepare('SELECT * FROM votes WHERE experiment_id = ?').get(experimentId);
    return r ? mapVote(r) : null;
  }

  revealVote(experimentId) {
    this.db.prepare('UPDATE votes SET revealed_at = ? WHERE experiment_id = ? AND revealed_at IS NULL').run(Date.now(), experimentId);
  }

  // ── 配方对象与版本（F19：每次修改生成版本，历史配方不被覆盖） ──────────────
  //
  // 三条不可让步的性质（对应 A03 的"历史配方不被覆盖"）：
  //  ① 已写入的版本行**只读**：没有任何 UPDATE recipe_versions 的路径；
  //  ② 每个版本自带 content_hash，同一份内容重复保存不会多出一个版本（如实回 unchanged）；
  //  ③ attempt 保存的是快照本身，不依赖 recipes 表 —— 删掉配方也不影响历史实验。

  /** 新建配方，内容作为第 1 版。 */
  createRecipe({ name, note, snapshot, source }) {
    const id = newId('rcp');
    const now = Date.now();
    const content = normalizeRecipeContent(snapshot);
    this.db.prepare('INSERT INTO recipes (id,name,note,latest_version,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, String(name ?? '未命名配方').slice(0, 200), note ? String(note).slice(0, 2000) : null, 1, now, now);
    this.db.prepare('INSERT INTO recipe_versions (recipe_id,version,content_hash,snapshot,note,source,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, 1, recipeHash(content), JSON.stringify(content), note ? String(note).slice(0, 2000) : null,
        source ? String(source).slice(0, 200) : null, now);
    return this.getRecipe(id);
  }

  /**
   * 追加一个新版本。**绝不覆盖已有版本**；内容与最新版完全相同时不新增，返回 unchanged。
   * @returns {{ok: boolean, reason?: string, unchanged?: boolean, version?: number, contentHash?: string, recipe?: object}}
   */
  addRecipeVersion(recipeId, { snapshot, note, source }) {
    const recipe = this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
    if (!recipe) return { ok: false, reason: '找不到这个配方' };
    const content = normalizeRecipeContent(snapshot);
    const hash = recipeHash(content);
    const latest = this.db.prepare('SELECT * FROM recipe_versions WHERE recipe_id = ? AND version = ?')
      .get(recipeId, recipe.latest_version);
    if (latest && latest.content_hash === hash) {
      // 内容一模一样：不制造一个没有区别的版本，但如实告诉调用方"没有变化"。
      return { ok: true, unchanged: true, version: recipe.latest_version, contentHash: hash, recipe: this.getRecipe(recipeId) };
    }
    const next = Number(recipe.latest_version) + 1;
    const now = Date.now();
    this.db.prepare('INSERT INTO recipe_versions (recipe_id,version,content_hash,snapshot,note,source,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(recipeId, next, hash, JSON.stringify(content), note ? String(note).slice(0, 2000) : null,
        source ? String(source).slice(0, 200) : null, now);
    this.db.prepare('UPDATE recipes SET latest_version = ?, updated_at = ? WHERE id = ?').run(next, now, recipeId);
    return { ok: true, unchanged: false, version: next, contentHash: hash, recipe: this.getRecipe(recipeId) };
  }

  /** 改名字/说明不算"配方内容"变化，但也要留痕：只改元信息，不动任何版本行。 */
  updateRecipeMeta(recipeId, { name, note }) {
    const recipe = this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
    if (!recipe) return { ok: false, reason: '找不到这个配方' };
    this.db.prepare('UPDATE recipes SET name = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(name === undefined ? recipe.name : String(name).slice(0, 200),
        note === undefined ? recipe.note : (note === null ? null : String(note).slice(0, 2000)),
        Date.now(), recipeId);
    return { ok: true, recipe: this.getRecipe(recipeId) };
  }

  listRecipes({ search } = {}) {
    let sql = 'SELECT * FROM recipes';
    const args = [];
    if (search) { sql += ' WHERE name LIKE ?'; args.push('%' + search + '%'); }
    sql += ' ORDER BY updated_at DESC LIMIT 200';
    return this.db.prepare(sql).all(...args).map((r) => ({
      ...mapRecipe(r),
      versionCount: this.db.prepare('SELECT COUNT(*) AS n FROM recipe_versions WHERE recipe_id = ?').get(r.id).n,
    }));
  }

  /** 取一个配方：元信息 + 全部版本（含每版快照与 hash）。 */
  getRecipe(id) {
    const r = this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
    if (!r) return null;
    const versions = this.db.prepare('SELECT * FROM recipe_versions WHERE recipe_id = ? ORDER BY version DESC').all(id)
      .map(mapRecipeVersion);
    return { ...mapRecipe(r), versions };
  }

  /** 取指定版本（不存在返回 null，不猜）。 */
  getRecipeVersion(id, version) {
    const r = this.db.prepare('SELECT * FROM recipe_versions WHERE recipe_id = ? AND version = ?').get(id, version);
    return r ? mapRecipeVersion(r) : null;
  }

  deleteRecipe(id) {
    const r = this.db.prepare('SELECT id FROM recipes WHERE id = ?').get(id);
    if (!r) return { ok: false, reason: '找不到这个配方' };
    // 只删配方对象本身：历史实验的 recipe_snapshot 是快照，不受影响（F19）。
    this.db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
    return { ok: true };
  }

  // ── 截图记录（A23：成功与失败都要有明确记录） ─────────────────────────────

  recordScreenshot({ experimentId, attemptId, viewport, status, reason, durationMs, detail }) {
    const id = newId('shot');
    this.db.prepare(
      'INSERT INTO screenshots (id,experiment_id,attempt_id,viewport,status,reason,duration_ms,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(id, experimentId, attemptId, String(viewport ?? 'desktop'), String(status ?? 'unknown'),
      reason ? String(reason).slice(0, 2000) : null,
      Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      detail ? JSON.stringify(detail) : null, Date.now());
    return this.getScreenshot(id);
  }

  getScreenshot(id) {
    const r = this.db.prepare('SELECT * FROM screenshots WHERE id = ?').get(id);
    return r ? mapScreenshot(r) : null;
  }

  listScreenshots(experimentId, limit = 50) {
    return this.db.prepare('SELECT * FROM screenshots WHERE experiment_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(experimentId, limit).map(mapScreenshot);
  }

  // ── 重启恢复（A09） ──────────────────────────────────────────────────────

  /**
   * 把上一次进程留下的"没跑完"的尝试标成 interrupted：
   * running（正在跑）与 queued（还在排队）都算 —— 它们的执行者已经随进程一起消失了。
   *
   * 这里**只改状态**：不新建 attempt、不重新发起调用（不自动重付费），
   * 也不伪造 finished_at / 用量。已收到的正文与作品保持原样可读。
   * @returns {{count: number, items: {id: string, previous: string}[]}}
   */
  markUnfinishedAsInterrupted() {
    const rows = this.db.prepare("SELECT id, status FROM attempts WHERE status IN ('running','queued')").all();
    const items = [];
    for (const r of rows) {
      this.db.prepare('UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?').run('interrupted', Date.now(), r.id);
      // 只在没有更准确的原因时补一条人能读懂的解释；不覆盖已有的真实错误。
      const receipt = this.db.prepare('SELECT error_code FROM receipts WHERE attempt_id = ?').get(r.id);
      if (receipt && !receipt.error_code) {
        // 如实说明"留下了什么"：有定期落盘的部分输出就说清楚有多少字符，没有就不假装有。
        const part = this.partialInfo(r.id);
        const what = part
          ? '中断前已落盘的部分输出还在（' + part.chars + ' 字符'
            + (part.truncated ? '，只保留了尾部' : '') + '），可以下载。'
          : '这次尝试还没来得及产出可保存的正文。';
        this.db.prepare('UPDATE receipts SET error_code = ?, error_message = ? WHERE attempt_id = ?')
          .run('INTERRUPTED', '这次尝试在宿主重启时还没跑完（上一状态：' + r.status + '）。' + what
            + '它不会自动重跑，也不会重新计费。', r.id);
      }
      items.push({ id: r.id, previous: r.status });
    }
    return { count: items.length, items };
  }

  close() { try { this.db.close(); } catch { /* 已关闭 */ } }
}

function mapRecipe(r) {
  return {
    id: r.id, name: r.name, note: r.note,
    latestVersion: r.latest_version, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapRecipeVersion(r) {
  return {
    recipeId: r.recipe_id, version: r.version, contentHash: r.content_hash,
    snapshot: JSON.parse(r.snapshot), note: r.note, source: r.source, createdAt: r.created_at,
  };
}

function mapScreenshot(r) {
  return {
    id: r.id, experimentId: r.experiment_id, attemptId: r.attempt_id, viewport: r.viewport,
    status: r.status, reason: r.reason, durationMs: r.duration_ms,
    detail: r.detail ? JSON.parse(r.detail) : null, createdAt: r.created_at,
  };
}

function mapExperiment(r) {
  return {
    id: r.id, title: r.title, category: r.category, status: r.status,
    taskSnapshot: JSON.parse(r.task_snapshot), taskHash: r.task_hash,
    outputPolicy: JSON.parse(r.output_policy), previewPolicy: JSON.parse(r.preview_policy),
    version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapAttempt(r) {
  return {
    id: r.id, experimentId: r.experiment_id, candidateSlot: r.candidate_slot, attemptNo: r.attempt_no,
    recipeSnapshot: JSON.parse(r.recipe_snapshot), requestedConfig: JSON.parse(r.requested_config),
    resolvedConfig: r.resolved_config ? JSON.parse(r.resolved_config) : null,
    status: r.status, parentAttemptId: r.parent_attempt_id,
    // 溯源：这一轮是从哪个配方的哪一版复制过来的（老数据为 null）
    recipeId: r.recipe_id ?? null, recipeVersion: r.recipe_version ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapReceipt(r) {
  return {
    queuedAt: r.queued_at, startedAt: r.started_at, firstEventAt: r.first_event_at, firstTextAt: r.first_text_at,
    finishedAt: r.finished_at, finishReason: r.finish_reason,
    errorCode: r.error_code, errorMessage: r.error_message, errorStatus: r.error_status,
    usage: r.usage ? JSON.parse(r.usage) : null, observedRequests: r.observed_requests,
  };
}

function mapArtifact(r) {
  return {
    id: r.id, attemptId: r.attempt_id, rawTextHash: r.raw_text_hash, htmlHash: r.html_hash,
    extractionVersion: r.extraction_version, extractionMode: r.extraction_mode,
    extractionRange: r.extraction_range ? JSON.parse(r.extraction_range) : null,
    extractionStatus: r.extraction_status,
    extractionWarnings: r.extraction_warnings ? JSON.parse(r.extraction_warnings) : null,
    bytes: r.bytes, createdAt: r.created_at,
  };
}

function mapVote(r) {
  return {
    experimentId: r.experiment_id, anonymousMapping: JSON.parse(r.anonymous_mapping),
    choice: r.choice, tags: r.tags ? JSON.parse(r.tags) : null, note: r.note,
    createdAt: r.created_at, revealedAt: r.revealed_at,
  };
}
