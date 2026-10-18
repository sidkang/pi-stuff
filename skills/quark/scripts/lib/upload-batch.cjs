'use strict';

/**
 * Duplicate-safe resumable upload batches for the Quark CLI.
 * Prevents accidental re-upload of confirmed successes. Does not claim
 * server-side exactly-once delivery or fix SDK ACK timeouts.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const MANIFEST_VERSION = 1;
const DEFAULT_PROGRESS_INTERVAL_MS = 1000;

function defaultBatchRoot() {
  if (process.env.QUARK_UPLOAD_BATCH_DIR) return path.resolve(process.env.QUARK_UPLOAD_BATCH_DIR);
  return path.join(os.homedir(), '.config', 'quark', 'upload-batches');
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function stableId(parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function batchIdFor(now = Date.now()) {
  const d = new Date(now);
  const stamp = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
    'T',
    String(d.getUTCHours()).padStart(2, '0'),
    String(d.getUTCMinutes()).padStart(2, '0'),
    String(d.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  return `upload-batch-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function hashFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let bytesRead;
    // eslint-disable-next-line no-cond-assign
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isAlivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function createStore(rootDir = defaultBatchRoot()) {
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true });

  function batchDir(batchId) {
    return path.join(root, batchId);
  }

  function manifestPath(batchId) {
    return path.join(batchDir(batchId), 'manifest.json');
  }

  function eventsPath(batchId) {
    return path.join(batchDir(batchId), 'events.jsonl');
  }

  function lockPath(batchId) {
    return path.join(batchDir(batchId), 'runner.lock');
  }

  function resolutionLockPath(identityKey) {
    return path.join(root, `.resolve-${identityKey}.lock`);
  }

  function listBatchIds() {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory() && fs.existsSync(manifestPath(name));
      } catch {
        return false;
      }
    });
  }

  function load(batchId) {
    return readJson(manifestPath(batchId));
  }

  function save(manifest) {
    const next = { ...manifest, updatedAt: nowIso() };
    atomicWriteJson(manifestPath(next.batchId), next);
    return next;
  }

  function emit(batchId, type, data = {}) {
    appendJsonl(eventsPath(batchId), { at: nowIso(), type, ...data });
  }

  function acquireExclusiveLock(file, {
    liveMessage,
    staleMessage,
    corruptMessage,
    racedMessage,
    liveCode = 'BATCH_LOCKED',
    meta = {},
  }) {
    if (fs.existsSync(file)) {
      let existing = null;
      try {
        existing = readJson(file);
      } catch {
        existing = null;
      }
      if (existing && isAlivePid(existing.pid)) {
        const error = new Error(liveMessage(existing));
        error.code = liveCode;
        Object.assign(error, meta, { pid: existing.pid, lockPath: file });
        throw error;
      }
      const stale = new Error(existing ? staleMessage(existing, file) : corruptMessage(file));
      stale.code = 'STALE_LOCK';
      Object.assign(stale, meta, { lockPath: file, pid: existing?.pid });
      throw stale;
    }
    const nonce = crypto.randomBytes(8).toString('hex');
    const payload = { pid: process.pid, nonce, startedAt: nowIso(), hostname: os.hostname() };
    const tmp = `${file}.${process.pid}.${nonce}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      if (error && error.code === 'EEXIST') {
        let again = null;
        try { again = readJson(file); } catch { again = null; }
        if (again && isAlivePid(again.pid)) {
          const locked = new Error(liveMessage(again));
          locked.code = liveCode;
          Object.assign(locked, meta, { pid: again.pid, lockPath: file });
          throw locked;
        }
        const raced = new Error(racedMessage(file));
        raced.code = 'STALE_LOCK';
        Object.assign(raced, meta, { lockPath: file });
        throw raced;
      }
      throw error;
    }
    try { fs.unlinkSync(tmp); } catch {}
    return {
      nonce,
      release() {
        try {
          const current = readJson(file);
          if (current.pid === process.pid && current.nonce === nonce) fs.unlinkSync(file);
        } catch {
          // Do not unlink a lock we cannot prove we still own.
        }
      },
    };
  }

  function acquireLock(batchId) {
    const dir = batchDir(batchId);
    fs.mkdirSync(dir, { recursive: true });
    const file = lockPath(batchId);
    return acquireExclusiveLock(file, {
      liveCode: 'BATCH_LOCKED',
      meta: { batchId },
      liveMessage: (existing) => `batch ${batchId} already has a live runner (pid ${existing.pid})`,
      staleMessage: (existing, lockFile) =>
        `batch ${batchId} has a stale runner lock (pid ${existing.pid}). Confirm no runner is active, then remove ${lockFile} before retrying.`,
      corruptMessage: (lockFile) =>
        `batch ${batchId} has a corrupt runner lock at ${lockFile}. Confirm no runner is active, then remove it before retrying.`,
      racedMessage: (lockFile) =>
        `batch ${batchId} lock appeared during acquire (possibly stale at ${lockFile}). Confirm no runner is active, then remove the lock before retrying.`,
    });
  }

  function acquireResolutionLock({ userId, sourceRoots, parentFidRequested }) {
    fs.mkdirSync(root, { recursive: true });
    const identityKey = resolutionIdentityKey({ userId, sourceRoots, parentFidRequested });
    const file = resolutionLockPath(identityKey);
    return acquireExclusiveLock(file, {
      liveCode: 'RESOLUTION_LOCKED',
      meta: { identityKey },
      liveMessage: (existing) =>
        `upload identity ${identityKey} is already being resolved (pid ${existing.pid})`,
      staleMessage: (existing, lockFile) =>
        `upload identity ${identityKey} has a stale resolution lock (pid ${existing.pid}). Confirm no resolver is active, then remove ${lockFile} before retrying.`,
      corruptMessage: (lockFile) =>
        `upload identity ${identityKey} has a corrupt resolution lock at ${lockFile}. Confirm no resolver is active, then remove it before retrying.`,
      racedMessage: (lockFile) =>
        `upload identity ${identityKey} resolution lock appeared during acquire (possibly stale at ${lockFile}). Confirm no resolver is active, then remove the lock before retrying.`,
    });
  }

  return {
    root,
    batchDir,
    manifestPath,
    eventsPath,
    listBatchIds,
    load,
    save,
    emit,
    acquireLock,
    acquireResolutionLock,
  };
}

function resolutionIdentityKey({ userId, sourceRoots, parentFidRequested }) {
  const roots = (sourceRoots || []).map((p) => path.resolve(p)).sort().join('\n');
  const parent = parentFidRequested == null || parentFidRequested === '' ? '' : String(parentFidRequested);
  return crypto.createHash('sha256').update([String(userId), roots, parent].join('\0')).digest('hex').slice(0, 16);
}

function walkFiles(rootPath) {
  const absoluteRoot = path.resolve(rootPath);
  const stat = fs.statSync(absoluteRoot);
  /** @type {{ absolutePath: string, relativePath: string, size: number, mtimeMs: number, rootPath: string }[]} */
  const files = [];

  function walk(current, relativeDir) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const abs = path.join(current, entry.name);
      const rel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        const st = fs.statSync(abs);
        files.push({
          absolutePath: abs,
          relativePath: rel.split(path.sep).join('/'),
          size: st.size,
          mtimeMs: Math.trunc(st.mtimeMs),
          contentDigest: hashFileSync(abs),
          rootPath: absoluteRoot,
        });
      }
    }
  }

  if (stat.isFile()) {
    files.push({
      absolutePath: absoluteRoot,
      relativePath: path.basename(absoluteRoot),
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      contentDigest: hashFileSync(absoluteRoot),
      rootPath: path.dirname(absoluteRoot),
      singleFile: true,
    });
  } else if (stat.isDirectory()) {
    walk(absoluteRoot, path.basename(absoluteRoot));
  } else {
    throw Object.assign(new Error(`unsupported path: ${absoluteRoot}`), { code: 'INVALID_SOURCE' });
  }
  return files;
}

function buildInventory(sourcePaths) {
  const resolvedRoots = [...new Set(sourcePaths.map((p) => path.resolve(p)))];
  for (const root of resolvedRoots) {
    if (!fs.existsSync(root)) {
      throw Object.assign(new Error(`source path does not exist: ${root}`), { code: 'SOURCE_MISSING' });
    }
  }
  const files = [];
  const seen = new Set();
  for (const root of resolvedRoots) {
    for (const file of walkFiles(root)) {
      if (seen.has(file.absolutePath)) continue;
      seen.add(file.absolutePath);
      files.push(file);
    }
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { sourceRoots: resolvedRoots, files };
}

function dirKeysForFile(relativePath) {
  const parts = relativePath.split('/');
  if (parts.length <= 1) return [];
  const dirs = [];
  for (let i = 0; i < parts.length - 1; i++) {
    dirs.push(parts.slice(0, i + 1).join('/'));
  }
  return dirs;
}

function createManifest({ inventory, userId, parentFid, now = Date.now() }) {
  const batchId = batchIdFor(now);
  const dirs = {};
  for (const file of inventory.files) {
    for (const key of dirKeysForFile(file.relativePath)) {
      if (!dirs[key]) dirs[key] = { key, status: 'pending', fid: null, error: null };
    }
  }
  return {
    version: MANIFEST_VERSION,
    batchId,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    account: { userId: String(userId) },
    sourceRoots: inventory.sourceRoots,
    parentFidRequested: parentFid == null || parentFid === '' ? null : String(parentFid),
    parentFidPinned: parentFid == null || parentFid === '' ? null : String(parentFid),
    status: 'pending',
    dirs,
    files: inventory.files.map((file) => ({
      id: stableId([file.absolutePath, String(file.size), String(file.mtimeMs), file.contentDigest || '']),
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      contentDigest: file.contentDigest || null,
      parentDirKey: dirKeysForFile(file.relativePath).at(-1) || null,
      status: 'pending',
      recordId: null,
      remoteFid: null,
      previousRemoteFid: null,
      instantUpload: false,
      error: null,
      needsReconciliation: false,
      updatedAt: nowIso(now),
    })),
  };
}

function sameSourceIdentity(file, disk) {
  if (file.absolutePath !== disk.absolutePath) return false;
  if (file.size !== disk.size || file.mtimeMs !== disk.mtimeMs) return false;
  // Size+mtime alone are not proof: equal-length edits with restored mtime must still rehash.
  if (!file.contentDigest || !disk.contentDigest) return false;
  return file.contentDigest === disk.contentDigest;
}

function hasBoundUploadEffect(file) {
  return !!(
    file.recordId
    || file.remoteFid
    || file.status === 'uploading'
    || file.needsReconciliation
    || file.status === 'needs-reconciliation'
  );
}

function clearBoundSourceObservation(file) {
  file.boundSourceChanged = false;
  file.observedSize = null;
  file.observedMtimeMs = null;
  file.observedContentDigest = null;
}

function markBoundSourceChanged(file, disk) {
  file.observedSize = disk.size;
  file.observedMtimeMs = disk.mtimeMs;
  file.observedContentDigest = disk.contentDigest;
  file.boundSourceChanged = true;
  file.status = 'needs-reconciliation';
  file.needsReconciliation = true;
  const previousError = file.error && file.error.code !== 'SOURCE_CHANGED_WHILE_BOUND'
    ? file.error
    : file.error?.previousError || null;
  file.error = {
    code: 'SOURCE_CHANGED_WHILE_BOUND',
    message: `source bytes changed while upload effect evidence exists (recordId/remoteFid/unknown outcome); refusing automatic restore/create. Inspect ${file.absolutePath} and reconcile manually.`,
    previousError,
  };
  file.updatedAt = nowIso();
}

function refreshSourceState(manifest) {
  const warnings = [];
  for (const file of manifest.files) {
    if (!fs.existsSync(file.absolutePath)) {
      if (file.status === 'success') {
        warnings.push({ fileId: file.id, code: 'SOURCE_MISSING_AFTER_SUCCESS', path: file.absolutePath });
        continue;
      }
      if (hasBoundUploadEffect(file)) {
        file.boundSourceChanged = true;
        file.status = 'needs-reconciliation';
        file.needsReconciliation = true;
        const previousError = file.error && file.error.code !== 'SOURCE_MISSING_WHILE_BOUND'
          ? file.error
          : file.error?.previousError || null;
        file.error = {
          code: 'SOURCE_MISSING_WHILE_BOUND',
          message: `source missing while upload effect evidence exists; refusing automatic restore/create: ${file.absolutePath}`,
          previousError,
        };
        file.updatedAt = nowIso();
        warnings.push({ fileId: file.id, code: 'SOURCE_MISSING_WHILE_BOUND', path: file.absolutePath });
        continue;
      }
      file.status = 'failed';
      file.error = { code: 'SOURCE_MISSING', message: `source missing: ${file.absolutePath}` };
      continue;
    }
    const st = fs.statSync(file.absolutePath);
    const disk = {
      absolutePath: file.absolutePath,
      size: st.size,
      mtimeMs: Math.trunc(st.mtimeMs),
      contentDigest: hashFileSync(file.absolutePath),
    };
    if (file.status === 'success' && !sameSourceIdentity(file, disk)) {
      if (file.remoteFid) file.previousRemoteFid = file.remoteFid;
      file.status = 'pending';
      file.recordId = null;
      file.remoteFid = null;
      file.instantUpload = false;
      file.needsReconciliation = false;
      file.error = null;
      clearBoundSourceObservation(file);
      file.size = disk.size;
      file.mtimeMs = disk.mtimeMs;
      file.contentDigest = disk.contentDigest;
      file.id = stableId([file.absolutePath, String(file.size), String(file.mtimeMs), file.contentDigest || '']);
      warnings.push({ fileId: file.id, code: 'SOURCE_CHANGED', path: file.absolutePath });
    } else if (file.status === 'success') {
      // Keep digest fresh when identity matches.
      file.contentDigest = disk.contentDigest;
      clearBoundSourceObservation(file);
    } else if (!sameSourceIdentity(file, disk) && hasBoundUploadEffect(file)) {
      // Preserve original digest/path/task/FID evidence across repeated commands.
      markBoundSourceChanged(file, disk);
      warnings.push({
        fileId: file.id,
        code: 'SOURCE_CHANGED_WHILE_BOUND',
        path: file.absolutePath,
        recordId: file.recordId || null,
        remoteFid: file.remoteFid || null,
      });
    } else if (!sameSourceIdentity(file, disk)) {
      // Unbound pending/failed rows may adopt the current source identity.
      file.size = disk.size;
      file.mtimeMs = disk.mtimeMs;
      file.contentDigest = disk.contentDigest;
      clearBoundSourceObservation(file);
    } else {
      // Identity still matches the bound evidence; clear any prior mutation observation.
      if (file.boundSourceChanged) {
        const previousError = file.error?.previousError || null;
        clearBoundSourceObservation(file);
        if (file.error?.code === 'SOURCE_CHANGED_WHILE_BOUND') {
          file.error = previousError;
          if (!previousError && (file.needsReconciliation || file.status === 'needs-reconciliation') && !file.recordId && !file.remoteFid) {
            file.needsReconciliation = false;
            if (file.status === 'needs-reconciliation') file.status = 'pending';
          } else if (!previousError && file.recordId && (file.needsReconciliation || file.status === 'needs-reconciliation')) {
            // Keep unknown-outcome reconciliation, but drop the mutation wrapper.
            file.error = {
              code: 'UNKNOWN_OUTCOME',
              message: 'source identity restored; existing record still needs reconciliation before restore/create',
            };
          }
        }
      }
      file.contentDigest = disk.contentDigest;
    }
  }
  return warnings;
}

function findMatchingBatches(store, { userId, sourceRoots, parentFidRequested }) {
  const wantedRoots = sourceRoots.map((p) => path.resolve(p)).sort().join('\n');
  const wantedParent = parentFidRequested == null || parentFidRequested === '' ? null : String(parentFidRequested);
  const matches = [];
  for (const id of store.listBatchIds()) {
    const manifest = store.load(id);
    if (String(manifest.account?.userId) !== String(userId)) continue;
    const roots = (manifest.sourceRoots || []).map((p) => path.resolve(p)).sort().join('\n');
    if (roots !== wantedRoots) continue;
    const parent = manifest.parentFidRequested == null ? null : String(manifest.parentFidRequested);
    if (parent !== wantedParent) continue;
    matches.push(manifest);
  }
  matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return matches;
}

function summarize(manifest) {
  const counts = {
    total: manifest.files.length,
    pending: 0,
    uploading: 0,
    success: 0,
    failed: 0,
    needsReconciliation: 0,
  };
  for (const file of manifest.files) {
    if (file.needsReconciliation || file.status === 'needs-reconciliation') counts.needsReconciliation++;
    else if (file.status === 'success') counts.success++;
    else if (file.status === 'failed') counts.failed++;
    else if (file.status === 'uploading') counts.uploading++;
    else counts.pending++;
  }
  return counts;
}

function deriveBatchStatus(manifest) {
  const counts = summarize(manifest);
  if (counts.needsReconciliation > 0) return 'needs-reconciliation';
  if (counts.failed > 0 && counts.success + counts.failed === counts.total) return 'partial';
  if (counts.failed > 0) return 'partial';
  if (counts.success === counts.total && counts.total > 0) return 'completed';
  if (counts.uploading > 0 || counts.pending > 0) return 'running';
  return manifest.status || 'pending';
}

function createProgressGate(intervalMs = DEFAULT_PROGRESS_INTERVAL_MS, nowFn = () => Date.now()) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    allow(force = false) {
      const now = nowFn();
      if (!force && now - last < intervalMs) return false;
      last = now;
      return true;
    },
  };
}

function assertAccount(manifest, userId) {
  if (String(manifest.account?.userId) !== String(userId)) {
    throw Object.assign(
      new Error(`batch ${manifest.batchId} belongs to user ${manifest.account?.userId}, current user is ${userId}`),
      { code: 'ACCOUNT_MISMATCH', batchId: manifest.batchId },
    );
  }
}

function parentFidForDir(manifest, dirKey) {
  if (!dirKey) return manifest.parentFidPinned;
  const parts = dirKey.split('/');
  if (parts.length === 1) return manifest.parentFidPinned;
  const parentKey = parts.slice(0, -1).join('/');
  const parent = manifest.dirs[parentKey];
  return parent?.fid || null;
}

async function ensureDirectories(manifest, service, store) {
  const keys = Object.keys(manifest.dirs).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const key of keys) {
    const dir = manifest.dirs[key];
    if (dir.status === 'created' && dir.fid) continue;
    if (dir.status === 'creating') {
      dir.status = 'needs-reconciliation';
      dir.error = {
        code: 'DIR_CREATE_AMBIGUOUS',
        message: `directory ${key} was creating when interrupted; refuse to create a duplicate. Inspect remote parent and set dirs['${key}'].fid manually or pass evidence via reconcile.`,
      };
      manifest.status = 'needs-reconciliation';
      store.save(manifest);
      store.emit(manifest.batchId, 'dir_needs_reconciliation', { key });
      throw Object.assign(new Error(dir.error.message), { code: 'DIR_CREATE_AMBIGUOUS', batchId: manifest.batchId, dirKey: key });
    }
    if (dir.status === 'needs-reconciliation') {
      throw Object.assign(new Error(dir.error?.message || `directory ${key} needs reconciliation`), {
        code: 'DIR_NEEDS_RECONCILIATION',
        batchId: manifest.batchId,
        dirKey: key,
      });
    }

    const parentFid = parentFidForDir(manifest, key);
    if (manifest.parentFidRequested && !parentFid && key.includes('/')) {
      // Nested dir under an unresolved parent requested fid should not happen once roots are pinned.
    }
    if (manifest.parentFidPinned == null && manifest.parentFidRequested == null && key.split('/').length > 1) {
      // Nested under a root folder that must be created first; root folder parent may be service default (undefined).
    }

    const name = key.split('/').at(-1);
    dir.status = 'creating';
    dir.error = null;
    store.save(manifest);
    store.emit(manifest.batchId, 'dir_creating', { key, parentFid: parentFid || null, name });

    let result;
    try {
      result = await service.createFolder({ dirPath: name, parentFid: parentFid || undefined });
    } catch (error) {
      // Intent already persisted as creating. Transport/ACK failure may mean the remote
      // folder exists; never classify this as a definite retryable failure.
      dir.status = 'needs-reconciliation';
      dir.error = {
        code: 'DIR_CREATE_AMBIGUOUS',
        message: `createFolder for ${key} threw after create intent; refuse to recreate. Inspect remote parent and set dirs['${key}'].fid manually or via reconcile. Cause: ${error.message || String(error)}`,
        cause: error.message || String(error),
      };
      manifest.status = 'needs-reconciliation';
      store.save(manifest);
      store.emit(manifest.batchId, 'dir_needs_reconciliation', { key, cause: dir.error.cause });
      throw Object.assign(new Error(dir.error.message), {
        code: 'DIR_CREATE_AMBIGUOUS',
        batchId: manifest.batchId,
        dirKey: key,
      });
    }

    if (!result || !result.fid) {
      dir.status = 'needs-reconciliation';
      dir.error = {
        code: 'DIR_CREATE_NO_FID',
        message: `createFolder for ${key} returned no fid; refuse to guess parent/root`,
      };
      manifest.status = 'needs-reconciliation';
      store.save(manifest);
      throw Object.assign(new Error(dir.error.message), { code: 'DIR_CREATE_NO_FID', batchId: manifest.batchId, dirKey: key });
    }

    dir.fid = String(result.fid);
    dir.status = 'created';
    store.save(manifest);
    store.emit(manifest.batchId, 'dir_created', { key, fid: dir.fid });

    // Pin actual service-default parent from a top-level directory as soon as evidenced.
    if (!key.includes('/') && manifest.parentFidPinned == null) {
      const pinned = await tryPinParentFromFid(manifest, service, store, dir.fid, { source: 'dir', key });
      if (!pinned && manifest.parentFidRequested == null) {
        // Discovery failure is deferred to the end-of-batch boundary so nested work can still finish
        // with durable dir FIDs; completion still fails closed if pin remains missing.
        store.emit(manifest.batchId, 'parent_fid_pin_pending', { fromDirKey: key, fid: dir.fid });
      }
    }
  }
}

function resolveFileParentFid(manifest, file) {
  if (!file.parentDirKey) return manifest.parentFidPinned || undefined;
  const dir = manifest.dirs[file.parentDirKey];
  if (!dir?.fid) {
    throw Object.assign(new Error(`missing pinned fid for directory ${file.parentDirKey}`), {
      code: 'DIR_FID_MISSING',
      dirKey: file.parentDirKey,
    });
  }
  return dir.fid;
}

async function tryPinParentFromFid(manifest, service, store, remoteFid, meta = {}) {
  if (manifest.parentFidPinned != null) return true;
  if (!remoteFid || typeof service.getFileInfo !== 'function') return false;
  let info;
  try {
    info = await service.getFileInfo(remoteFid);
  } catch (error) {
    store.emit(manifest.batchId, 'parent_fid_pin_failed', {
      fromRemoteFid: remoteFid,
      message: error.message || String(error),
      ...meta,
    });
    return false;
  }
  const parent = info?.parent_fid || info?.parentFid || info?.pdir_fid || null;
  if (!parent) {
    store.emit(manifest.batchId, 'parent_fid_pin_failed', {
      fromRemoteFid: remoteFid,
      message: 'getFileInfo returned no parent_fid',
      ...meta,
    });
    return false;
  }
  manifest.parentFidPinned = String(parent);
  store.save(manifest);
  store.emit(manifest.batchId, 'parent_fid_pinned', {
    parentFid: manifest.parentFidPinned,
    fromRemoteFid: remoteFid,
    ...meta,
  });
  return true;
}

async function ensureParentPinned(manifest, service, store) {
  if (manifest.parentFidPinned != null) return true;
  if (manifest.parentFidRequested != null) {
    manifest.parentFidPinned = String(manifest.parentFidRequested);
    store.save(manifest);
    store.emit(manifest.batchId, 'parent_fid_pinned', {
      parentFid: manifest.parentFidPinned,
      source: 'requested',
    });
    return true;
  }

  for (const key of Object.keys(manifest.dirs).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    if (key.includes('/')) continue;
    const dir = manifest.dirs[key];
    if (!dir?.fid) continue;
    if (await tryPinParentFromFid(manifest, service, store, dir.fid, { source: 'dir', key })) return true;
  }

  for (const file of manifest.files) {
    // Only direct children of the batch parent reveal the actual default target.
    if (file.parentDirKey || !file.remoteFid) continue;
    if (await tryPinParentFromFid(manifest, service, store, file.remoteFid, {
      source: 'file',
      fileId: file.id,
    })) return true;
  }

  return false;
}

async function reconcileFile(manifest, file, service) {
  if (file.boundSourceChanged || (file.observedContentDigest && file.observedContentDigest !== file.contentDigest)) {
    return {
      ok: false,
      status: 'needs-reconciliation',
      reason: 'source_changed_while_bound',
      message: 'Source bytes changed while effect evidence exists; refusing to mark the new bytes uploaded from an old remote FID.',
    };
  }
  if (!file.remoteFid) {
    return {
      ok: false,
      status: 'needs-reconciliation',
      reason: 'no_remote_fid',
      message: 'No remote FID is recorded. Automatic reconcile is unavailable without directory-listing proof; inspect upload status evidence and resolve manually.',
    };
  }
  if (typeof service.getFileInfo !== 'function') {
    return {
      ok: false,
      status: 'needs-reconciliation',
      reason: 'no_get_file_info',
      message: 'Service cannot getFileInfo; automatic reconcile unavailable.',
    };
  }
  const info = await service.getFileInfo(file.remoteFid);
  if (!info) {
    return {
      ok: false,
      status: 'needs-reconciliation',
      reason: 'remote_missing',
      message: `getFileInfo(${file.remoteFid}) found nothing; refusing to re-upload automatically`,
    };
  }
  const remoteSize = Number(info.size ?? info.file_size ?? NaN);
  const remoteName = info.filename || info.file_name || info.fileName || null;
  if (Number.isFinite(remoteSize) && remoteSize !== file.size) {
    return {
      ok: false,
      status: 'needs-reconciliation',
      reason: 'size_mismatch',
      message: `remote size ${remoteSize} != local ${file.size}`,
      info,
    };
  }
  // Name+size alone are not proof for discovery; here FID came from our own success record.
  return {
    ok: true,
    status: 'success',
    info,
    remoteName,
  };
}

async function reconcileBatch(manifest, service, store, { fileIds = null } = {}) {
  assertAccount(manifest, (await service.getAccount()).userId);
  // Direct reconciliation must bind remote evidence to the current source too.
  const sourceWarnings = refreshSourceState(manifest);
  manifest.status = deriveBatchStatus(manifest);
  store.save(manifest);
  for (const warning of sourceWarnings) store.emit(manifest.batchId, 'source_warning', warning);
  const targets = manifest.files.filter((file) => {
    if (fileIds && !fileIds.includes(file.id)) return false;
    return file.needsReconciliation || file.status === 'needs-reconciliation' || file.status === 'uploading';
  });
  const results = [];
  for (const file of targets) {
    const result = await reconcileFile(manifest, file, service);
    results.push({ fileId: file.id, relativePath: file.relativePath, ...result });
    if (result.ok) {
      file.status = 'success';
      file.needsReconciliation = false;
      file.error = null;
      file.updatedAt = nowIso();
      store.emit(manifest.batchId, 'file_reconciled_success', { fileId: file.id, remoteFid: file.remoteFid });
    } else {
      file.status = 'needs-reconciliation';
      file.needsReconciliation = true;
      file.error = { code: result.reason, message: result.message };
      file.updatedAt = nowIso();
      store.emit(manifest.batchId, 'file_reconcile_blocked', { fileId: file.id, reason: result.reason });
    }
    store.save(manifest);
  }

  for (const key of Object.keys(manifest.dirs)) {
    const dir = manifest.dirs[key];
    if (dir.status !== 'needs-reconciliation' && dir.status !== 'creating') continue;
    if (dir.fid && typeof service.getFileInfo === 'function') {
      const info = await service.getFileInfo(dir.fid);
      if (info) {
        dir.status = 'created';
        dir.error = null;
        store.save(manifest);
        store.emit(manifest.batchId, 'dir_reconciled', { key, fid: dir.fid });
        continue;
      }
    }
    results.push({
      dirKey: key,
      ok: false,
      status: 'needs-reconciliation',
      reason: 'dir_ambiguous',
      message: dir.error?.message || 'Directory create outcome is ambiguous; automatic recreate is disabled',
    });
  }

  manifest.status = deriveBatchStatus(manifest);
  store.save(manifest);
  return { manifest, results, boundary: RECONCILE_BOUNDARY };
}

const RECONCILE_BOUNDARY = {
  automatic: 'Only getFileInfo(remoteFid) for FIDs already recorded by this batch is used as proof.',
  notAutomatic: [
    'No remote directory listing API is wired for safe name/size discovery.',
    'name+size alone is not proof of identity.',
    'Files/dirs marked needs-reconciliation without a remote FID are not resubmitted automatically.',
    'instantUpload/hashMatched is not treated as cross-batch deduplication.',
  ],
};

function markInflightNeedsReconciliation(manifest, reason) {
  for (const file of manifest.files) {
    if (file.status === 'uploading' || (file.status === 'pending' && file.recordId)) {
      file.status = 'needs-reconciliation';
      file.needsReconciliation = true;
      file.error = { code: reason.code || 'UNKNOWN_OUTCOME', message: reason.message || String(reason) };
      file.updatedAt = nowIso();
    }
  }
  for (const key of Object.keys(manifest.dirs)) {
    const dir = manifest.dirs[key];
    if (dir.status === 'creating') {
      dir.status = 'needs-reconciliation';
      dir.error = { code: 'DIR_CREATE_AMBIGUOUS', message: reason.message || String(reason) };
    }
  }
  manifest.status = 'needs-reconciliation';
}

async function runBatch(manifest, service, store, options = {}) {
  const account = await service.getAccount();
  if (!account?.userId) {
    throw Object.assign(new Error('missing account userId'), { code: 'AUTH_REQUIRED' });
  }
  assertAccount(manifest, account.userId);

  const lock = store.acquireLock(manifest.batchId);
  const progressGate = createProgressGate(options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS, options.now);
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  const emit = (type, data) => {
    store.emit(manifest.batchId, type, data);
    onEvent({ type, batchId: manifest.batchId, ...data });
  };

  try {
    const sourceWarnings = refreshSourceState(manifest);
    for (const warning of sourceWarnings) emit('source_warning', warning);

    manifest.status = 'running';
    store.save(manifest);
    emit('batch_running', { counts: summarize(manifest) });

    await service.ensureReady?.();
    await ensureDirectories(manifest, service, store);

    // Crash window: marked uploading before createTasks returned a recordId.
    for (const file of manifest.files) {
      if (file.status === 'uploading' && !file.recordId) {
        file.status = 'needs-reconciliation';
        file.needsReconciliation = true;
        file.error = {
          code: 'UPLOAD_CRASH_BEFORE_RECORD',
          message: 'process interrupted after upload intent and before recordId; refusing automatic resubmit',
        };
        file.updatedAt = nowIso();
        emit('file_crash_before_record', { fileId: file.id, relativePath: file.relativePath });
      }
    }
    store.save(manifest);

    // Bound source mutations and needs-reconciliation without recordId/remoteFid cannot be resumed/created.
    const blockedHard = manifest.files.filter((file) => {
      if (file.boundSourceChanged) return true;
      const needs = file.needsReconciliation || file.status === 'needs-reconciliation';
      return needs && !file.recordId && !file.remoteFid;
    });
    if (blockedHard.length && !options.continueWithBlocked) {
      manifest.status = 'needs-reconciliation';
      store.save(manifest);
      emit('batch_blocked_reconciliation', { count: blockedHard.length });
      return {
        manifest,
        counts: summarize(manifest),
        exitCode: 2,
        code: 'NEEDS_RECONCILIATION',
        message: `${blockedHard.length} file(s) need reconciliation before further upload`,
        reconcileBoundary: RECONCILE_BOUNDARY,
      };
    }

    const pending = manifest.files.filter((file) => {
      if (file.boundSourceChanged) {
        // Source mutation while bound to an effect: never restore/create automatically.
        return false;
      }
      if (file.status === 'success' && !file.needsReconciliation) return false;
      if (file.remoteFid && (file.needsReconciliation || file.status === 'needs-reconciliation')) {
        // Leave FID-backed ambiguity to reconcile; do not resubmit.
        return false;
      }
      if (file.status === 'failed' && options.retryFailed === false) return false;
      if (file.needsReconciliation || file.status === 'needs-reconciliation') {
        // Safe path: resume an existing task id only.
        return !!file.recordId;
      }
      return file.status === 'pending' || file.status === 'failed' || file.status === 'uploading';
    });

    const listeners = {
      onProgress(info) {
        if (!progressGate.allow()) return;
        emit('progress', {
          recordId: info.recordId,
          fileName: info.fileName,
          uploadSize: info.uploadSize,
          fileSize: info.fileSize,
        });
      },
      onSuccess(info) {
        // Bind only by durable recordId. Basename matching can cross-wire same-name files.
        const file = manifest.files.find((row) => row.recordId && row.recordId === info.recordId);
        if (!file) return;
        if (!info.fileId) {
          file.status = 'needs-reconciliation';
          file.needsReconciliation = true;
          file.error = {
            code: 'SUCCESS_WITHOUT_REMOTE_FID',
            message: 'upload success callback lacked remote fileId; refusing to mark durable success',
          };
          file.updatedAt = nowIso();
          store.save(manifest);
          emit('file_success_missing_fid', {
            fileId: file.id,
            relativePath: file.relativePath,
            recordId: file.recordId,
          });
          return;
        }
        file.status = 'success';
        file.needsReconciliation = false;
        file.remoteFid = String(info.fileId);
        file.instantUpload = !!info.hashMatched;
        file.error = null;
        file.updatedAt = nowIso();
        store.save(manifest);
        emit('file_success', {
          fileId: file.id,
          relativePath: file.relativePath,
          recordId: file.recordId,
          remoteFid: file.remoteFid,
          instantUpload: file.instantUpload,
        });
      },
      onFailure(info) {
        const file = manifest.files.find((row) => row.recordId && row.recordId === info.recordId);
        if (!file) return;
        file.status = 'failed';
        file.needsReconciliation = false;
        file.error = { code: info.errorCode || 'UPLOAD_FAILED', message: info.errorMessage || 'upload failed' };
        file.updatedAt = nowIso();
        store.save(manifest);
        emit('file_failed', {
          fileId: file.id,
          relativePath: file.relativePath,
          recordId: file.recordId,
          error: file.error,
        });
      },
    };

    await service.bindListeners?.(listeners);

    // Resume tasks with known record IDs first.
    for (const file of pending) {
      if (!file.recordId) continue;
      if (file.status === 'success') continue;
      file.status = 'uploading';
      file.needsReconciliation = false;
      store.save(manifest);
      emit('file_resume', { fileId: file.id, recordId: file.recordId, relativePath: file.relativePath });
      const fileRef = service.createFileReference(file.absolutePath);
      const restored = await service.restoreTask(file.recordId, fileRef);
      if (!restored?.success) {
        file.status = 'needs-reconciliation';
        file.needsReconciliation = true;
        file.error = {
          code: 'RESUME_FAILED',
          message: restored?.error || 'restoreTask failed; refusing automatic fresh upload of unknown outcome',
        };
        store.save(manifest);
        emit('file_resume_failed', { fileId: file.id, recordId: file.recordId, error: file.error });
      }
    }

    const toCreate = pending.filter((file) => !file.recordId && file.status !== 'needs-reconciliation' && !file.needsReconciliation);
    if (toCreate.length) {
      const taskInputs = toCreate.map((file) => {
        const parentFid = resolveFileParentFid(manifest, file);
        return {
          file,
          input: {
            file: service.createFileReference(file.absolutePath),
            fileName: path.basename(file.absolutePath),
            ...(parentFid ? { pdirFid: parentFid } : {}),
          },
        };
      });

      // Persist uploading intent before createTask returns record IDs.
      for (const row of taskInputs) {
        row.file.status = 'uploading';
        row.file.error = null;
        row.file.updatedAt = nowIso();
      }
      store.save(manifest);

      let created;
      try {
        created = await service.createTasks(taskInputs.map((row) => row.input));
      } catch (error) {
        markInflightNeedsReconciliation(manifest, {
          code: 'CREATE_TASKS_UNKNOWN',
          message: error.message || String(error),
        });
        store.save(manifest);
        emit('create_tasks_failed', { message: error.message || String(error) });
        throw error;
      }

      for (let i = 0; i < taskInputs.length; i++) {
        const record = created[i] || {};
        const file = taskInputs[i].file;
        if (!record.recordId) {
          file.status = 'needs-reconciliation';
          file.needsReconciliation = true;
          file.error = { code: 'MISSING_RECORD_ID', message: 'createTasks returned no recordId' };
        } else {
          file.recordId = String(record.recordId);
        }
        file.updatedAt = nowIso();
      }
      store.save(manifest);
      emit('tasks_created', {
        count: taskInputs.length,
        recordIds: taskInputs.map((row) => row.file.recordId),
      });
    }

    try {
      if (typeof service.start === 'function') {
        await service.start();
      }
      if (typeof service.waitForIdle === 'function') {
        await service.waitForIdle();
      }
    } catch (error) {
      markInflightNeedsReconciliation(manifest, {
        code: error.code || 'UPLOAD_UNKNOWN_OUTCOME',
        message: error.message || String(error),
      });
      store.save(manifest);
      emit('batch_unknown_outcome', { message: error.message || String(error), code: error.code });
      // Still attempt durable parent pin before returning so evidence is preserved.
      if (manifest.parentFidRequested == null && manifest.parentFidPinned == null) {
        await ensureParentPinned(manifest, service, store);
      }
      return {
        manifest,
        counts: summarize(manifest),
        exitCode: 2,
        code: 'NEEDS_RECONCILIATION',
        message: error.message || String(error),
        reconcileBoundary: RECONCILE_BOUNDARY,
      };
    }

    const stillUploading = manifest.files.some((file) => file.status === 'uploading');
    if (stillUploading) {
      markInflightNeedsReconciliation(manifest, {
        code: 'STILL_INFLIGHT',
        message: 'upload idle returned while files still marked uploading',
      });
    }

    if (manifest.parentFidRequested == null) {
      const pinned = await ensureParentPinned(manifest, service, store);
      if (!pinned && manifest.parentFidPinned == null) {
        const hasEvidence = manifest.files.some((file) => file.status === 'success' || file.remoteFid)
          || Object.values(manifest.dirs).some((dir) => dir.fid);
        if (hasEvidence) {
          manifest.status = 'needs-reconciliation';
          store.save(manifest);
          emit('parent_fid_unpinned', {
            message: 'omitted destination requires durable actual parent FID; discovery failed',
          });
          return {
            manifest,
            counts: summarize(manifest),
            exitCode: 2,
            code: 'NEEDS_RECONCILIATION',
            message: 'could not pin actual remote parent FID for omitted --parent-fid; refuse to treat batch as complete',
            reconcileBoundary: RECONCILE_BOUNDARY,
          };
        }
      }
    } else if (manifest.parentFidPinned == null) {
      manifest.parentFidPinned = String(manifest.parentFidRequested);
      store.save(manifest);
    }

    manifest.status = deriveBatchStatus(manifest);
    store.save(manifest);
    emit('batch_finished', { status: manifest.status, counts: summarize(manifest) });

    const counts = summarize(manifest);
    let exitCode = 0;
    let code = 'OK';
    let message = 'upload batch completed';
    if (counts.needsReconciliation > 0) {
      exitCode = 2;
      code = 'NEEDS_RECONCILIATION';
      message = 'upload batch stopped with files needing reconciliation';
    } else if (counts.failed > 0) {
      exitCode = 1;
      code = 'PARTIAL_FAILURE';
      message = 'upload batch finished with failures';
    }
    return { manifest, counts, exitCode, code, message, reconcileBoundary: RECONCILE_BOUNDARY };
  } finally {
    lock.release();
  }
}

function normalizeParentFid(parentFid) {
  return parentFid == null || parentFid === '' ? null : String(parentFid);
}

function sameSourceRoots(a, b) {
  const left = (a || []).map((p) => path.resolve(p)).sort().join('\n');
  const right = (b || []).map((p) => path.resolve(p)).sort().join('\n');
  return left === right;
}

async function resolveBatchForUpload(store, service, {
  paths,
  parentFid,
  batchId,
  newBatch = false,
}) {
  const account = await service.getAccount();
  if (!account?.userId) {
    throw Object.assign(new Error('login required before upload'), { code: 'AUTH_REQUIRED' });
  }
  const inventory = buildInventory(paths);
  if (inventory.files.length === 0) {
    throw Object.assign(new Error('no files found to upload'), { code: 'EMPTY_SOURCE' });
  }

  if (batchId) {
    // Serialize explicit-ID selection with same-identity match/create.
    const provisional = store.load(batchId);
    assertAccount(provisional, account.userId);
    const lock = store.acquireResolutionLock({
      userId: account.userId,
      sourceRoots: provisional.sourceRoots,
      parentFidRequested: provisional.parentFidRequested,
    });
    try {
      const manifest = store.load(batchId);
      assertAccount(manifest, account.userId);
      if (!sameSourceRoots(manifest.sourceRoots, inventory.sourceRoots)) {
        throw Object.assign(
          new Error(`batch ${batchId} source roots do not match supplied paths`),
          {
            code: 'BATCH_SOURCE_MISMATCH',
            batchId,
            manifestSourceRoots: manifest.sourceRoots,
            suppliedSourceRoots: inventory.sourceRoots,
          },
        );
      }
      const suppliedParent = normalizeParentFid(parentFid);
      // Omitted --parent-fid with --batch-id means "use the manifest target".
      if (suppliedParent != null) {
        const expected = normalizeParentFid(manifest.parentFidRequested);
        if (suppliedParent !== expected) {
          throw Object.assign(
            new Error(`batch ${batchId} parent FID ${expected || '(default)'} does not match supplied --parent-fid ${suppliedParent}`),
            {
              code: 'BATCH_TARGET_MISMATCH',
              batchId,
              parentFidRequested: expected,
              parentFidSupplied: suppliedParent,
            },
          );
        }
      }
      return { manifest, inventory, created: false };
    } finally {
      lock.release();
    }
  }

  const lock = store.acquireResolutionLock({
    userId: account.userId,
    sourceRoots: inventory.sourceRoots,
    parentFidRequested: parentFid,
  });
  try {
    const matches = findMatchingBatches(store, {
      userId: account.userId,
      sourceRoots: inventory.sourceRoots,
      parentFidRequested: parentFid,
    });

    const open = matches.filter((m) => m.status !== 'completed');

    // Never silently bypass open/ambiguous/unknown batches with --new-batch.
    if (open.length === 1 && !newBatch) {
      return { manifest: open[0], inventory, created: false };
    }
    if (open.length > 1) {
      throw Object.assign(
        new Error(`ambiguous open batches: ${open.map((m) => m.batchId).join(', ')}. Pass --batch-id to continue one of them.`),
        { code: 'AMBIGUOUS_BATCH', batchIds: open.map((m) => m.batchId) },
      );
    }
    if (open.length === 1 && newBatch) {
      throw Object.assign(
        new Error(`matching open batch ${open[0].batchId} exists (${open[0].status}). Pass --batch-id ${open[0].batchId} to continue; --new-batch cannot bypass incomplete/unknown batches.`),
        { code: 'OPEN_BATCH_EXISTS', batchId: open[0].batchId, batchIds: [open[0].batchId] },
      );
    }

    if (matches.length === 1 && matches[0].status === 'completed' && !newBatch) {
      throw Object.assign(
        new Error(`matching completed batch ${matches[0].batchId} exists. Re-run with --batch-id to inspect or --new-batch to upload again.`),
        { code: 'COMPLETED_BATCH_EXISTS', batchId: matches[0].batchId },
      );
    }

    // --new-batch is reserved for intentional re-upload after a completed match (or no match).
    const manifest = createManifest({
      inventory,
      userId: account.userId,
      parentFid,
    });
    store.save(manifest);
    store.emit(manifest.batchId, 'batch_created', {
      sourceRoots: manifest.sourceRoots,
      fileCount: manifest.files.length,
      parentFidRequested: manifest.parentFidRequested,
      newBatch: !!newBatch,
      supersededCompletedBatchId: matches[0]?.status === 'completed' ? matches[0].batchId : null,
    });
    return { manifest, inventory, created: true };
  } finally {
    lock.release();
  }
}

module.exports = {
  MANIFEST_VERSION,
  RECONCILE_BOUNDARY,
  defaultBatchRoot,
  createStore,
  buildInventory,
  createManifest,
  findMatchingBatches,
  summarize,
  deriveBatchStatus,
  createProgressGate,
  resolveBatchForUpload,
  runBatch,
  reconcileBatch,
  refreshSourceState,
  markInflightNeedsReconciliation,
  ensureParentPinned,
  hashFileSync,
  atomicWriteJson,
  assertAccount,
  resolutionIdentityKey,
};
