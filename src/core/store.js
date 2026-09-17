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
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

/** 数据 schema 版本。改变表结构时提升，并在 migrate() 里写迁移（验收 A29）。 */
export const SCHEMA_VERSION = 1;

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
      'CREATE INDEX IF NOT EXISTS idx_attempts_experiment ON attempts(experiment_id);',
      'CREATE INDEX IF NOT EXISTS idx_experiments_updated ON experiments(updated_at DESC);',
    ].join('\n'));

    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (!row) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    } else if (Number(row.value) > SCHEMA_VERSION) {
      // 拒绝打开时必须先释放句柄，否则调用方连删除目录都做不到，且在 Windows 上
      // 会留下一个占用文件的僵尸连接。
      this.close();
      throw new Error('数据目录由更新版本的 HTML Arena 写入（schema ' + row.value + ' > ' + SCHEMA_VERSION + '），请升级插件后再打开');
    }
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
    const arts = this.db.prepare('SELECT id FROM artifacts WHERE attempt_id IN (SELECT id FROM attempts WHERE experiment_id = ?)').all(id);
    this.db.prepare('DELETE FROM experiments WHERE id = ?').run(id);
    for (const a of arts) {
      for (const kind of ['raw.txt', 'html', 'reasoning.txt']) {
        try { rmSync(this.#artifactPath(a.id, kind), { force: true }); } catch { /* 文件缺失不影响删除 */ }
      }
    }
  }

  createAttempt({ experimentId, candidateSlot, attemptNo, recipeSnapshot, requestedConfig, resolvedConfig, parentAttemptId }) {
    const id = newId('att');
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO attempts (id,experiment_id,candidate_slot,attempt_no,recipe_snapshot,requested_config,resolved_config,status,parent_attempt_id,created_at,updated_at)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, experimentId, candidateSlot, attemptNo, JSON.stringify(recipeSnapshot),
      JSON.stringify(requestedConfig), resolvedConfig ? JSON.stringify(resolvedConfig) : null,
      'queued', parentAttemptId || null, now, now);
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

  close() { try { this.db.close(); } catch { /* 已关闭 */ } }
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
