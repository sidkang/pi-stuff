import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('.', import.meta.url));
const cli = join(root, 'scripts/quark-drive.cjs');
const {
  createStore,
  resolveBatchForUpload,
  runBatch,
  reconcileBatch,
  summarize,
  createProgressGate,
  hashFileSync,
  resolutionIdentityKey,
} = require('./scripts/lib/upload-batch.cjs');
const {
  createSdkService,
  createSettleWaiter,
  setUploadBatchServiceFactoryForTests,
  runUploadAction,
  runStatusAction,
  runBatchesAction,
  runReconcileAction,
} = require('./scripts/lib/upload-batch-cli.cjs');

class TestCliError extends Error {
  constructor(action, errorCode, message, exitCode, data) {
    super(message);
    this.action = action;
    this.errorCode = errorCode;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'quark-batch-'));
  const folder = join(dir, 'folder');
  mkdirSync(join(folder, 'nested'), { recursive: true });
  writeFileSync(join(folder, 'a.txt'), 'alpha');
  writeFileSync(join(folder, 'b.txt'), 'bravo');
  writeFileSync(join(folder, 'nested', 'c.txt'), 'charlie');
  return { dir, folder, batchRoot: join(dir, 'batches') };
}

function createFakeService(options = {}) {
  const account = options.account || { userId: 'user-1' };
  const remote = new Map(options.remoteEntries || []);
  const createdFolders = [];
  const createdTasks = [];
  const restored = [];
  let taskSeq = 0;
  let listeners = null;
  let failAckFor = new Set(options.ackTimeoutFiles || []);
  let failCreateFolders = options.failCreateFolders || new Set();
  let throwAfterCreateFolders = options.throwAfterCreateFolders || new Set();
  const fileByRecord = new Map();

  const service = {
    remote,
    createdFolders,
    createdTasks,
    restored,
    fileByRecord,
    async getAccount() {
      if (options.authError) throw Object.assign(new Error('auth failed'), { code: 'AUTH_REQUIRED' });
      return account;
    },
    async ensureReady() {},
    async bindListeners(next) {
      listeners = next;
    },
    createFileReference(filePath) {
      return { path: filePath };
    },
    async createFolder({ dirPath, parentFid }) {
      const key = `${parentFid || 'default'}:${dirPath}`;
      if (failCreateFolders.has(dirPath) || failCreateFolders.has(key)) {
        return { fid: null };
      }
      const fid = `dir-${createdFolders.length + 1}`;
      createdFolders.push({ dirPath, parentFid: parentFid || null, fid });
      remote.set(fid, { filename: dirPath, size: 0, parent_fid: parentFid || 'root-default' });
      if (throwAfterCreateFolders.has(dirPath) || throwAfterCreateFolders.has(key)) {
        throwAfterCreateFolders.delete(dirPath);
        throwAfterCreateFolders.delete(key);
        const error = new Error(`transport lost after createFolder ${dirPath}`);
        error.code = 'TRANSPORT_AFTER_CREATE';
        throw error;
      }
      return { fid };
    },
    async createTasks(inputs) {
      const rows = [];
      for (const input of inputs) {
        taskSeq += 1;
        const recordId = `rec-${taskSeq}`;
        const row = { recordId, fileName: input.fileName, fileSize: 0, pdirFid: input.pdirFid || null, file: input.file };
        createdTasks.push(row);
        fileByRecord.set(recordId, row);
        rows.push(row);
      }
      return rows;
    },
    async restoreTask(recordId, fileRef) {
      restored.push({ recordId, fileRef });
      if (options.failRestore?.has(recordId)) return { success: false, error: 'cannot restore' };
      if (!fileByRecord.has(recordId)) {
        fileByRecord.set(recordId, { recordId, file: fileRef, fileName: basename(fileRef.path) });
      }
      return { success: true };
    },
    start() {
      let settle;
      service._idle = new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
      queueMicrotask(() => drive(settle));
    },
    async waitForIdle() {
      await service._idle;
    },
    async getFileInfo(fid) {
      return remote.get(fid) || null;
    },
  };

  function drive(settle) {
    try {
      const pending = [...fileByRecord.values()].filter((row) => !row._done);
      let ackError = null;
      for (const row of pending) {
        const name = row.fileName || basename(row.file.path);
        listeners?.onProgress?.({
          recordId: row.recordId,
          fileName: name,
          uploadSize: 1,
          fileSize: 2,
        });
        listeners?.onProgress?.({
          recordId: row.recordId,
          fileName: name,
          uploadSize: 2,
          fileSize: 2,
        });
        if (failAckFor.has(name) || failAckFor.has(row.file.path)) {
          row._done = 'ack';
          ackError = new Error(`ACK timeout for ${name}`);
          ackError.code = 'ACK_TIMEOUT';
          // No success/failure callback: models unknown remote outcome.
          failAckFor.delete(name);
          failAckFor.delete(row.file.path);
          continue;
        }
        if (options.failFiles?.has(name)) {
          row._done = 'fail';
          listeners?.onFailure?.({
            recordId: row.recordId,
            errorCode: 32000,
            errorMessage: `failed ${name}`,
          });
          continue;
        }
        const fid = `fid-${row.recordId}`;
        remote.set(fid, {
          filename: name,
          size: readFileSync(row.file.path).length,
          parent_fid: row.pdirFid || 'root-default',
        });
        row._done = 'ok';
        listeners?.onSuccess?.({
          recordId: row.recordId,
          fileId: fid,
          fileName: name,
          fileSize: remote.get(fid).size,
          hashMatched: !!options.instantUploadNames?.has(name),
        });
      }
      if (ackError) settle.reject(ackError);
      else settle.resolve();
    } catch (error) {
      settle.reject(error);
    }
  }

  service._idle = Promise.resolve();
  return service;
}

test('partial successes survive ACK timeout and are not recreated on resume', async () => {
  const { folder, batchRoot } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService({
    ackTimeoutFiles: new Set(['b.txt']),
  });

  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });

  const first = await runBatch(manifest, service, store, { progressIntervalMs: 0 });
  assert.equal(first.code, 'NEEDS_RECONCILIATION');
  assert.equal(service.createdTasks.length, 3);
  const afterFirst = store.load(manifest.batchId);
  const success = afterFirst.files.filter((f) => f.status === 'success');
  const unknown = afterFirst.files.filter((f) => f.needsReconciliation || f.status === 'needs-reconciliation');
  assert.ok(success.length >= 1);
  assert.ok(unknown.length >= 1);
  const createdBefore = service.createdTasks.map((t) => t.recordId);

  // Repeat same upload command semantics: resolve existing batch, run again.
  const service2 = createFakeService({
    account: { userId: 'user-1' },
    remoteEntries: [...service.remote.entries()],
  });
  // Preserve record map for resume of non-success files by seeding restore IDs only.
  for (const file of afterFirst.files) {
    if (file.recordId) {
      service2.fileByRecord.set(file.recordId, {
        recordId: file.recordId,
        fileName: basename(file.absolutePath),
        file: { path: file.absolutePath },
        pdirFid: 'parent-1',
        _done: file.status === 'success' ? 'ok' : undefined,
      });
    }
  }

  const resolved = await resolveBatchForUpload(store, service2, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  assert.equal(resolved.created, false);
  assert.equal(resolved.manifest.batchId, manifest.batchId);

  const second = await runBatch(resolved.manifest, service2, store, { progressIntervalMs: 0 });
  assert.equal(service2.createdTasks.length, 0);
  assert.ok(service2.restored.length >= 1);
  const afterSecond = store.load(manifest.batchId);
  for (const file of afterSecond.files) {
    if (file.status === 'success') {
      assert.ok(file.remoteFid);
    }
  }
  // No second createTasks for previously successful files.
  assert.deepEqual(createdBefore, service.createdTasks.map((t) => t.recordId));
  assert.ok(second.counts.success >= success.length);
});

test('source change and account/target isolation', async () => {
  const { folder, batchRoot } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService();
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  await runBatch(manifest, service, store, { progressIntervalMs: 0 });
  const completed = store.load(manifest.batchId);
  assert.equal(completed.status, 'completed');

  // Target isolation: same source, different parent => new batch only with --new-batch semantics after no open match.
  const otherParent = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-2',
    newBatch: true,
  });
  assert.equal(otherParent.created, true);
  assert.notEqual(otherParent.manifest.batchId, manifest.batchId);

  // Account isolation
  const otherUser = createFakeService({ account: { userId: 'user-2' } });
  await assert.rejects(
    () => resolveBatchForUpload(store, otherUser, { paths: [folder], parentFid: 'parent-1', batchId: manifest.batchId }),
    /belongs to user/,
  );

  // Source change on a success should reopen that file as pending when running again with --new-batch false / explicit batch id
  const changed = completed.files.find((f) => f.relativePath.endsWith('a.txt'));
  writeFileSync(changed.absolutePath, 'ALPHA-CHANGED');
  const st = require('node:fs').statSync(changed.absolutePath);
  utimesSync(changed.absolutePath, st.atime, new Date(st.mtimeMs + 5000));

  const resumed = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
    batchId: manifest.batchId,
  });
  const before = summarize(store.load(manifest.batchId));
  const serviceRerun = createFakeService();
  // Seed nothing; runBatch refreshSourceState will mark changed success -> pending and create new task.
  const result = await runBatch(resumed.manifest, serviceRerun, store, { progressIntervalMs: 0 });
  assert.ok(serviceRerun.createdTasks.some((t) => t.fileName === 'a.txt'));
  assert.equal(result.exitCode === 0 || result.counts.success >= before.success, true);
});

test('nested directories pin FIDs and refuse ambiguous recreate', async () => {
  const { folder, batchRoot } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService();
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  await runBatch(manifest, service, store, { progressIntervalMs: 0 });
  const latest = store.load(manifest.batchId);
  assert.ok(latest.dirs['folder']?.fid);
  assert.ok(latest.dirs['folder/nested']?.fid);
  assert.equal(latest.dirs['folder'].status, 'created');
  assert.deepEqual(
    service.createdFolders.map((d) => d.dirPath),
    ['folder', 'nested'],
  );

  // Simulate crash during creating
  latest.dirs['folder/nested'].status = 'creating';
  latest.dirs['folder/nested'].fid = null;
  store.save(latest);
  const service2 = createFakeService();
  const blocked = await runBatch(latest, service2, store, { progressIntervalMs: 0 }).catch((error) => error);
  assert.equal(blocked.code, 'DIR_CREATE_AMBIGUOUS');
  assert.equal(service2.createdFolders.length, 0);
});

test('same batch concurrent invocation fails closed on lock', async () => {
  const { folder, batchRoot } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService();
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  const lock = store.acquireLock(manifest.batchId);
  await assert.rejects(() => runBatch(manifest, service, store, { progressIntervalMs: 0 }), /live runner/);
  lock.release();
});

test('progress throttling emits about once per interval and final evidence remains', async () => {
  const gate = createProgressGate(1000, (() => {
    let t = 0;
    return () => {
      t += 400;
      return t;
    };
  })());
  assert.equal(gate.allow(), true);
  assert.equal(gate.allow(), false);
  assert.equal(gate.allow(), false);
  assert.equal(gate.allow(), true);

  const { folder, batchRoot } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService();
  const events = [];
  const { manifest } = await resolveBatchForUpload(store, service, { paths: [folder], parentFid: 'parent-1' });
  await runBatch(manifest, service, store, {
    progressIntervalMs: 10_000,
    onEvent: (event) => events.push(event.type),
  });
  const progressEvents = events.filter((type) => type === 'progress');
  assert.ok(progressEvents.length >= 1);
  assert.ok(progressEvents.length < 6);
  assert.ok(events.includes('batch_finished'));
  assert.ok(existsSync(store.eventsPath(manifest.batchId)));
  assert.ok(existsSync(store.manifestPath(manifest.batchId)));
});

test('reconcile uses remote FID info and refuses unknown without FID', async () => {
  const { folder, batchRoot } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService({ ackTimeoutFiles: new Set(['a.txt']) });
  const { manifest } = await resolveBatchForUpload(store, service, { paths: [folder], parentFid: 'parent-1' });
  await runBatch(manifest, service, store, { progressIntervalMs: 0 });
  const latest = store.load(manifest.batchId);
  const unknown = latest.files.find((f) => f.relativePath.endsWith('a.txt'));
  assert.equal(unknown.needsReconciliation || unknown.status === 'needs-reconciliation', true);
  assert.equal(unknown.remoteFid, null);

  const service2 = createFakeService({ remoteEntries: [...service.remote.entries()] });
  const result = await reconcileBatch(latest, service2, store);
  const row = result.results.find((r) => r.relativePath?.endsWith('a.txt'));
  assert.equal(row.ok, false);
  assert.match(row.message, /No remote FID|automatic reconcile/i);

  // File with remote FID can be confirmed.
  const success = latest.files.find((f) => f.status === 'success');
  success.status = 'needs-reconciliation';
  success.needsReconciliation = true;
  store.save(latest);
  const confirmed = await reconcileBatch(store.load(manifest.batchId), service2, store);
  const ok = confirmed.results.find((r) => r.fileId === success.id);
  assert.equal(ok.ok, true);
});

test('CLI help exposes batch flags and subcommands; docs examples still resolve', () => {
  for (const args of [
    ['upload', '--help'],
    ['upload', 'status', '--help'],
    ['upload', 'batches', '--help'],
    ['upload', 'reconcile', '--help'],
    ['upload', 'list', '--help'],
    ['login', '--help'],
  ]) {
    const output = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(output.status, 0, `${args.join(' ')}\n${output.stderr}`);
  }
  const uploadHelp = spawnSync(process.execPath, [cli, 'upload', '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.match(uploadHelp.stdout, /--batch-id/);
  assert.match(uploadHelp.stdout, /--new-batch/);
  assert.match(uploadHelp.stdout, /--parent-fid/);

  // Documented command examples from markdown keep resolving.
  const files = ['SKILL.md', ...require('node:fs').readdirSync(`${root}references`).filter((p) => p.endsWith('.md')).map((p) => `references/${p}`)];
  const commands = new Set();
  for (const file of files) {
    const text = readFileSync(`${root}${file}`, 'utf8');
    for (const match of text.matchAll(/\.\/scripts\/quark-drive\.cjs ([^\n]+)/g)) {
      const tokens = match[1].trim().split(/\s+/);
      if (tokens[0] === '<command>') continue;
      const command = tokens.slice(0, ['list', 'resume', 'delete', 'status', 'batches', 'reconcile'].includes(tokens[1]) ? 2 : 1);
      const flags = [...match[1].matchAll(/--[a-z-]+/g)].map((m) => m[0]);
      commands.add(JSON.stringify({ command, flags }));
    }
  }
  for (const entry of commands) {
    const { command, flags } = JSON.parse(entry);
    const output = spawnSync('./scripts/quark-drive.cjs', [...command, '--help'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(output.status, 0, output.stderr || output.stdout);
    assert.match(output.stdout, new RegExp(`Usage: quark-drive ${command.join(' ')}`));
    for (const flag of flags) assert.ok(output.stdout.includes(flag), `${command.join(' ')} lacks ${flag}`);
  }
});

test('in-process CLI seam: resume does not duplicate successes and emits one final result', async () => {
  const { folder, batchRoot } = makeTree();
  const results = [];
  const host = {
    CliError: TestCliError,
    context: () => ({
      output: {
        info() {},
        flushResult(row) { results.push(row); },
      },
    }),
    resolvePaths: (paths) => paths.map((p) => require('node:path').resolve(p)),
    batchRoot: () => batchRoot,
  };

  const shared = { service: null, created: 0 };
  setUploadBatchServiceFactoryForTests(() => {
    if (!shared.service) {
      shared.service = createFakeService({
        account: { userId: 'cli-user' },
        ackTimeoutFiles: new Set(['b.txt']),
      });
      const originalCreate = shared.service.createTasks.bind(shared.service);
      shared.service.createTasks = async (inputs) => {
        const rows = await originalCreate(inputs);
        shared.created += rows.length;
        return rows;
      };
    }
    return shared.service;
  });

  try {
    await assert.rejects(
      () => runUploadAction(host, [folder], { parentFid: 'parent-cli' }),
      (error) => error instanceof TestCliError && error.exitCode === 2,
    );
    const firstCreates = shared.created;
    assert.ok(firstCreates >= 1);
    assert.equal(results.filter((row) => row.type === 'result').length, 0, 'nonzero path must not flush result before CliError');
    assert.ok(results.some((row) => row.type === 'list' && row.code === 0));

    // Second attempt continues same batch via factory-backed service identity reset for restore.
    const afterFirst = createStore(batchRoot);
    const ids = afterFirst.listBatchIds();
    assert.equal(ids.length, 1);
    const manifest = afterFirst.load(ids[0]);
    const service2 = createFakeService({
      account: { userId: 'cli-user' },
      remoteEntries: [...shared.service.remote.entries()],
    });
    for (const file of manifest.files) {
      if (file.recordId) {
        service2.fileByRecord.set(file.recordId, {
          recordId: file.recordId,
          fileName: basename(file.absolutePath),
          file: { path: file.absolutePath },
          pdirFid: 'parent-cli',
          _done: file.status === 'success' ? 'ok' : undefined,
        });
      }
    }
    setUploadBatchServiceFactoryForTests(() => service2);
    results.length = 0;
    const beforeCreates = service2.createdTasks.length;
    let secondError = null;
    try {
      await runUploadAction(host, [folder], { parentFid: 'parent-cli' });
    } catch (error) {
      secondError = error;
      assert.ok(error instanceof TestCliError);
    }
    assert.equal(service2.createdTasks.length, beforeCreates, 'successful files must not be created twice');
    const finalResults = results.filter((row) => row.type === 'result');
    if (secondError) {
      // Nonzero path: CliError carries the only final payload; action must not have flushed result.
      assert.equal(finalResults.length, 0);
      assert.ok(secondError.data?.batchId);
    } else {
      // Completed resume: exactly one success result.
      assert.equal(finalResults.length, 1);
      assert.equal(finalResults[0].code, 0);
    }
  } finally {
    setUploadBatchServiceFactoryForTests(null);
    rmSync(join(folder, '..'), { recursive: true, force: true });
  }
});

test('--batch-id rejects source or target mismatch', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const other = join(dir, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'x.txt'), 'x');
  const store = createStore(batchRoot);
  const service = createFakeService();
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });

  await assert.rejects(
    () => resolveBatchForUpload(store, service, {
      paths: [other],
      parentFid: 'parent-1',
      batchId: manifest.batchId,
    }),
    /source roots do not match/,
  );

  await assert.rejects(
    () => resolveBatchForUpload(store, service, {
      paths: [folder],
      parentFid: 'parent-OTHER',
      batchId: manifest.batchId,
    }),
    /does not match supplied --parent-fid/,
  );

  // Omitted parent with --batch-id keeps the manifest target.
  const ok = await resolveBatchForUpload(store, service, {
    paths: [folder],
    batchId: manifest.batchId,
  });
  assert.equal(ok.manifest.batchId, manifest.batchId);
  rmSync(dir, { recursive: true, force: true });
});

test('--new-batch cannot bypass open or ambiguous batches', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService({
    ackTimeoutFiles: new Set(['a.txt']),
  });
  const first = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  await runBatch(first.manifest, service, store, { progressIntervalMs: 0 });
  const open = store.load(first.manifest.batchId);
  assert.notEqual(open.status, 'completed');

  await assert.rejects(
    () => resolveBatchForUpload(store, service, {
      paths: [folder],
      parentFid: 'parent-1',
      newBatch: true,
    }),
    /cannot bypass incomplete|OPEN_BATCH|open batch/,
  );

  // Fabricate a second open match to hit ambiguity even with --new-batch.
  const second = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-2',
    newBatch: true,
  });
  second.manifest.status = 'needs-reconciliation';
  // Force same identity as first for matching: rewrite source/parent to collide.
  second.manifest.parentFidRequested = 'parent-1';
  second.manifest.parentFidPinned = 'parent-1';
  store.save(second.manifest);

  await assert.rejects(
    () => resolveBatchForUpload(store, service, {
      paths: [folder],
      parentFid: 'parent-1',
      newBatch: true,
    }),
    /ambiguous open batches/,
  );

  // Completed re-upload escape still works.
  const doneStore = createStore(join(dir, 'done-batches'));
  const doneService = createFakeService();
  const done = await resolveBatchForUpload(doneStore, doneService, {
    paths: [folder],
    parentFid: 'parent-9',
  });
  await runBatch(done.manifest, doneService, doneStore, { progressIntervalMs: 0 });
  assert.equal(doneStore.load(done.manifest.batchId).status, 'completed');
  const fresh = await resolveBatchForUpload(doneStore, doneService, {
    paths: [folder],
    parentFid: 'parent-9',
    newBatch: true,
  });
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.manifest.batchId, done.manifest.batchId);
  rmSync(dir, { recursive: true, force: true });
});

test('equal-size restored-mtime content change is not skipped', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService();
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  await runBatch(manifest, service, store, { progressIntervalMs: 0 });
  const completed = store.load(manifest.batchId);
  assert.equal(completed.status, 'completed');
  const target = completed.files.find((f) => f.relativePath.endsWith('a.txt'));
  const previousDigest = target.contentDigest;
  const previousFid = target.remoteFid;
  const st = require('node:fs').statSync(target.absolutePath);
  // Same length, restore original mtime after rewrite.
  writeFileSync(target.absolutePath, 'ALPHX');
  utimesSync(target.absolutePath, st.atime, st.mtime);
  assert.notEqual(hashFileSync(target.absolutePath), previousDigest);

  const resumed = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
    batchId: manifest.batchId,
  });
  const rerunService = createFakeService();
  await runBatch(resumed.manifest, rerunService, store, { progressIntervalMs: 0 });
  const latest = store.load(manifest.batchId);
  const changed = latest.files.find((f) => f.relativePath.endsWith('a.txt'));
  assert.ok(rerunService.createdTasks.some((t) => t.fileName === 'a.txt'));
  assert.equal(changed.previousRemoteFid, previousFid);
  assert.notEqual(changed.contentDigest, previousDigest);
  rmSync(dir, { recursive: true, force: true });
});

test('success without remote FID stays needs-reconciliation; omitted parent pin is awaited', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const store = createStore(batchRoot);
  const noFid = createFakeService();
  const bind = noFid.bindListeners.bind(noFid);
  noFid.bindListeners = async (next) => bind({
    onProgress: (info) => next.onProgress?.(info),
    onFailure: (info) => next.onFailure?.(info),
    onSuccess(info) {
      next.onSuccess?.({ ...info, fileId: undefined });
    },
  });

  const { manifest } = await resolveBatchForUpload(store, noFid, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  const result = await runBatch(manifest, noFid, store, { progressIntervalMs: 0 });
  assert.equal(result.code, 'NEEDS_RECONCILIATION');
  const latest = store.load(manifest.batchId);
  assert.equal(latest.files.filter((f) => f.status === 'success').length, 0);
  assert.ok(latest.files.some((f) => f.status === 'needs-reconciliation'));
  assert.ok(latest.files.every((f) => f.status !== 'success' || f.remoteFid));

  // Omitted parent must pin from top-level dir before completion.
  const store2 = createStore(join(dir, 'pin-batches'));
  const pinService = createFakeService();
  const pinned = await resolveBatchForUpload(store2, pinService, { paths: [folder] });
  assert.equal(pinned.manifest.parentFidPinned, null);
  const pinResult = await runBatch(pinned.manifest, pinService, store2, { progressIntervalMs: 0 });
  const afterPin = store2.load(pinned.manifest.batchId);
  assert.equal(afterPin.parentFidPinned, 'root-default');
  assert.equal(pinResult.exitCode, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('stale lock fails closed without automatic takeover', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService();
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  const lockFile = join(store.batchDir(manifest.batchId), 'runner.lock');
  mkdirSync(store.batchDir(manifest.batchId), { recursive: true });
  writeFileSync(lockFile, `${JSON.stringify({ pid: 999999, nonce: 'dead', startedAt: new Date().toISOString() })}\n`);
  await assert.rejects(
    () => runBatch(manifest, service, store, { progressIntervalMs: 0 }),
    (error) => error.code === 'STALE_LOCK',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('production SDK adapter stall timeout fails closed via createSettleWaiter', async () => {
  const active = new Set(['rec-1', 'rec-2']);
  const tasks = new Map([
    ['rec-1', { recordId: 'rec-1', uploadState: 4, fileName: 'a.txt', fileId: 'fid-1' }],
    ['rec-2', { recordId: 'rec-2', uploadState: 2, fileName: 'b.txt' }],
  ]);
  let now = 0;
  const waiter = createSettleWaiter({
    getActiveIds: () => active,
    getUpload: () => ({
      async queryAllTask() {
        return { data: [...tasks.values()] };
      },
    }),
    stallTimeoutMs: 40,
    now: () => now,
  });

  // First check should clear terminal rec-1 and keep rec-2.
  now = 10;
  await waiter.check();
  assert.equal(active.has('rec-1'), false);
  assert.equal(active.has('rec-2'), true);

  now = 100; // beyond stall window with no further terminal progress
  const pending = assert.rejects(() => waiter.promise, /stall timeout|ACK_TIMEOUT|unknown outcome/i);
  await waiter.check();
  await pending;
});

test('production createSdkService maps host manager and surfaces stall as waitForIdle rejection', async () => {
  const { folder, batchRoot, dir } = makeTree();
  let uploadListeners = null;
  const activeRecords = [];
  const host = {
    stallTimeoutMs: 60,
    pollIntervalMs: 20,
    getManager: async () => ({
      upload: {
        async createTask(inputs) {
          const rows = inputs.map((item, index) => {
            const recordId = `sdk-rec-${index + 1}`;
            activeRecords.push({ recordId, fileName: item.fileName, file: item.file, uploadState: 2 });
            return { recordId, fileName: item.fileName, fileSize: 1 };
          });
          return { status: 0, data: rows };
        },
        async restoreTask() { return { status: 0, data: { success: true } }; },
        start() {
          // Succeed first record via callback; leave the rest hanging in non-terminal state.
          const first = activeRecords[0];
          if (first) {
            uploadListeners?.onSuccess?.({
              recordId: first.recordId,
              fileId: `fid-${first.recordId}`,
              fileName: first.fileName,
              fileSize: 1,
              hashMatched: false,
            });
          }
        },
        async queryAllTask() {
          return {
            data: activeRecords.map((row, index) => ({
              recordId: row.recordId,
              uploadState: index === 0 ? 4 : 2,
              fileName: row.fileName,
            })),
          };
        },
        async pauseAllTask() {},
      },
      fileBrowser: {
        async createFolder({ dirPath, parentFid }) {
          return { status: 0, data: { fid: `dir-${dirPath}-${parentFid || 'default'}` } };
        },
        async getFileInfo(fid) {
          return { filename: fid, size: 0, parent_fid: 'parent-1' };
        },
      },
    }),
    initUpload: async (_manager, listeners) => { uploadListeners = listeners; },
    initBrowser: async () => {},
    FileAdapter: class {
      createFileReference(filePath) { return { path: filePath }; }
    },
    getAccount: async () => ({ userId: 'sdk-user' }),
    detectAgent: () => null,
  };

  const service = createSdkService(host);
  const store = createStore(batchRoot);
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  const result = await runBatch(manifest, service, store, { progressIntervalMs: 0 });
  assert.equal(result.code, 'NEEDS_RECONCILIATION');
  const latest = store.load(manifest.batchId);
  const successes = latest.files.filter((f) => f.status === 'success');
  assert.ok(successes.length >= 1, 'completed callback successes must be preserved');
  assert.ok(successes.every((f) => f.remoteFid));
  assert.ok(latest.files.some((f) => f.needsReconciliation || f.status === 'needs-reconciliation'));
  rmSync(dir, { recursive: true, force: true });
});

test('production adapter start is no-op for empty batch selection and refuses foreign pending tasks', async () => {
  let startCalls = 0;
  const queue = [
    { recordId: 'foreign-pending', uploadState: 0, fileName: 'other.bin' },
    { recordId: 'foreign-done', uploadState: 4, fileName: 'done.bin', fileId: 'fid-done' },
  ];
  const host = {
    stallTimeoutMs: 30,
    pollIntervalMs: 10,
    getManager: async () => ({
      upload: {
        async createTask(inputs) {
          const rows = inputs.map((item, index) => {
            const recordId = `batch-rec-${index + 1}`;
            queue.push({ recordId, uploadState: 0, fileName: item.fileName });
            return { recordId, fileName: item.fileName, fileSize: 1 };
          });
          return { status: 0, data: rows };
        },
        async restoreTask() { return { status: 0, data: { success: true } }; },
        start() { startCalls += 1; },
        async queryAllTask() { return { data: [...queue] }; },
        async pauseAllTask() {},
      },
      fileBrowser: {
        async createFolder({ dirPath, parentFid }) {
          return { status: 0, data: { fid: `dir-${dirPath}-${parentFid || 'default'}` } };
        },
        async getFileInfo(fid) {
          return { filename: fid, size: 0, parent_fid: 'parent-1' };
        },
      },
    }),
    initUpload: async () => {},
    initBrowser: async () => {},
    FileAdapter: class {
      createFileReference(filePath) { return { path: filePath }; }
    },
    getAccount: async () => ({ userId: 'sdk-user' }),
    detectAgent: () => null,
  };

  const service = createSdkService(host);
  await service.ensureReady();

  // Zero selected IDs: must not call global upload().start().
  await service.start();
  assert.equal(startCalls, 0);
  await service.waitForIdle();

  // Creating a batch task while a foreign pending task sits in the SDK queue must fail closed.
  const created = await service.createTasks([
    { file: { path: '/tmp/a.txt' }, fileName: 'a.txt', pdirFid: 'parent-1' },
  ]);
  assert.equal(created.length, 1);
  await assert.rejects(
    () => service.start(),
    (error) => error.code === 'FOREIGN_UPLOAD_TASKS'
      && Array.isArray(error.foreignRecordIds)
      && error.foreignRecordIds.includes('foreign-pending'),
  );
  assert.equal(startCalls, 0, 'global start must not run when foreign pending tasks exist');

  // After removing foreign pending, scoped batch start is allowed.
  const foreignIdx = queue.findIndex((row) => row.recordId === 'foreign-pending');
  queue.splice(foreignIdx, 1);
  await service.start();
  assert.equal(startCalls, 1);
  // Complete the selected task so the settle waiter does not leak after the test.
  for (const row of queue) {
    if (String(row.recordId).startsWith('batch-rec-')) row.uploadState = 4;
  }
  await service.waitForIdle();
});

test('production adapter runBatch with only successes never starts foreign pending SDK tasks', async () => {
  const { folder, batchRoot, dir } = makeTree();
  let startCalls = 0;
  const foreignQueue = [
    { recordId: 'foreign-pending', uploadState: 0, fileName: 'leak.bin' },
  ];
  const host = {
    stallTimeoutMs: 40,
    pollIntervalMs: 10,
    getManager: async () => ({
      upload: {
        async createTask() {
          throw new Error('createTask should not run when all files already succeeded');
        },
        async restoreTask() { return { status: 0, data: { success: true } }; },
        start() { startCalls += 1; },
        async queryAllTask() { return { data: [...foreignQueue] }; },
        async pauseAllTask() {},
      },
      fileBrowser: {
        async createFolder({ dirPath, parentFid }) {
          return { status: 0, data: { fid: `dir-${dirPath}-${parentFid || 'default'}` } };
        },
        async getFileInfo(fid) {
          return { filename: fid, size: 1, parent_fid: 'parent-1' };
        },
      },
    }),
    initUpload: async () => {},
    initBrowser: async () => {},
    FileAdapter: class {
      createFileReference(filePath) { return { path: filePath }; }
    },
    getAccount: async () => ({ userId: 'sdk-user' }),
    detectAgent: () => null,
  };

  const service = createSdkService(host);
  const store = createStore(batchRoot);
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  for (const file of manifest.files) {
    file.status = 'success';
    file.remoteFid = `fid-${file.id}`;
    file.recordId = `rec-${file.id}`;
    file.needsReconciliation = false;
    file.error = null;
  }
  manifest.status = 'completed';
  store.save(manifest);

  const result = await runBatch(manifest, service, store, { progressIntervalMs: 0 });
  assert.equal(result.exitCode, 0);
  assert.equal(startCalls, 0, 'completed batch must not call global upload().start()');
  rmSync(dir, { recursive: true, force: true });
});

test('status/batches/reconcile isolate by current account before SDK init', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const store = createStore(batchRoot);
  const owner = createFakeService({ account: { userId: 'owner-1' } });
  const { manifest } = await resolveBatchForUpload(store, owner, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  // Mark one file needing reconcile so reconcile path is exercised.
  manifest.files[0].status = 'needs-reconciliation';
  manifest.files[0].needsReconciliation = true;
  manifest.files[0].remoteFid = 'fid-owned';
  manifest.files[0].recordId = 'rec-owned';
  store.save(manifest);

  const results = [];
  let ensureReadyCalls = 0;
  const foreignHost = {
    CliError: TestCliError,
    context: () => ({
      output: {
        info() {},
        flushResult(row) { results.push(row); },
      },
      finish() {},
    }),
    batchRoot: () => batchRoot,
  };

  setUploadBatchServiceFactoryForTests(() => ({
    async getAccount() { return { userId: 'intruder-2' }; },
    async ensureReady() { ensureReadyCalls += 1; },
    async getFileInfo() { return { filename: 'x', size: 1 }; },
  }));

  try {
    await assert.rejects(
      () => runStatusAction(foreignHost, { batchId: manifest.batchId }),
      (error) => error instanceof TestCliError && error.data?.errorCode === 'ACCOUNT_MISMATCH',
    );

    results.length = 0;
    await runBatchesAction(foreignHost);
    const listed = results.filter((row) => row.type === 'list');
    assert.equal(listed.length, 0, 'foreign account must not see owner batches');

    ensureReadyCalls = 0;
    await assert.rejects(
      () => runReconcileAction(foreignHost, { batchId: manifest.batchId }),
      (error) => error instanceof TestCliError && error.data?.errorCode === 'ACCOUNT_MISMATCH',
    );
    assert.equal(ensureReadyCalls, 0, 'reconcile must assert account before ensureReady');

    // Same-account status still works.
    setUploadBatchServiceFactoryForTests(() => ({
      async getAccount() { return { userId: 'owner-1' }; },
      async ensureReady() { ensureReadyCalls += 1; },
      async getFileInfo(fid) {
        return { filename: 'a.txt', size: 5, fid };
      },
    }));
    results.length = 0;
    await runStatusAction(foreignHost, { batchId: manifest.batchId });
    assert.ok(results.some((row) => row.type === 'result' && row.data?.batchId === manifest.batchId));
  } finally {
    setUploadBatchServiceFactoryForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ACK-timeout then source mutate (same size/mtime) blocks restore/create across repeats', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService({ ackTimeoutFiles: new Set(['a.txt']) });
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  const first = await runBatch(manifest, service, store, { progressIntervalMs: 0 });
  assert.equal(first.code, 'NEEDS_RECONCILIATION');

  const afterAck = store.load(manifest.batchId);
  const target = afterAck.files.find((f) => f.relativePath.endsWith('a.txt'));
  assert.ok(target.recordId, 'ACK-timeout row must retain recordId evidence');
  assert.equal(target.needsReconciliation || target.status === 'needs-reconciliation', true);
  const originalDigest = target.contentDigest;
  const originalRecordId = target.recordId;
  const originalSize = target.size;
  const st = require('node:fs').statSync(target.absolutePath);
  // Same length, restored mtime — fingerprint must still detect mutation.
  writeFileSync(target.absolutePath, 'ALPHX');
  utimesSync(target.absolutePath, st.atime, st.mtime);
  assert.equal(require('node:fs').statSync(target.absolutePath).size, originalSize);
  assert.notEqual(hashFileSync(target.absolutePath), originalDigest);

  for (let round = 0; round < 2; round += 1) {
    const resumed = await resolveBatchForUpload(store, service, {
      paths: [folder],
      parentFid: 'parent-1',
      batchId: manifest.batchId,
    });
    const rerun = createFakeService();
    // Seed prior record mapping so a buggy restore path could succeed if attempted.
    rerun.fileByRecord.set(originalRecordId, {
      recordId: originalRecordId,
      fileName: 'a.txt',
      file: { path: target.absolutePath },
    });
    const result = await runBatch(resumed.manifest, rerun, store, { progressIntervalMs: 0 });
    assert.equal(result.code, 'NEEDS_RECONCILIATION');
    assert.equal(rerun.restored.length, 0, `round ${round}: must not restoreTask changed bytes`);
    assert.equal(rerun.createdTasks.length, 0, `round ${round}: must not create replacement task`);
    const latest = store.load(manifest.batchId);
    const row = latest.files.find((f) => f.relativePath.endsWith('a.txt'));
    assert.equal(row.contentDigest, originalDigest, 'original digest evidence must remain durable');
    assert.equal(row.recordId, originalRecordId);
    assert.equal(row.boundSourceChanged, true);
    assert.equal(row.status, 'needs-reconciliation');
  }

  // Reconcile must not mark new bytes uploaded just because an old remote FID exists.
  const withFid = store.load(manifest.batchId);
  const mutated = withFid.files.find((f) => f.relativePath.endsWith('a.txt'));
  mutated.remoteFid = 'fid-old-version';
  store.save(withFid);
  const reconcileService = createFakeService({
    remoteEntries: [['fid-old-version', { filename: 'a.txt', size: originalSize, parent_fid: 'parent-1' }]],
  });
  const reconciled = await reconcileBatch(store.load(manifest.batchId), reconcileService, store);
  const blocked = reconciled.results.find((r) => r.relativePath?.endsWith('a.txt'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'source_changed_while_bound');
  assert.notEqual(store.load(manifest.batchId).files.find((f) => f.relativePath.endsWith('a.txt')).status, 'success');
  rmSync(dir, { recursive: true, force: true });
});

test('direct reconcile rejects changed source before consulting its old remote FID', async () => {
  const { folder, batchRoot, dir } = makeTree();
  try {
    const store = createStore(batchRoot);
    const service = createFakeService();
    const { manifest } = await resolveBatchForUpload(store, service, {
      paths: [folder], parentFid: 'parent-1',
    });
    const target = manifest.files.find((file) => file.relativePath.endsWith('a.txt'));
    target.status = 'needs-reconciliation';
    target.needsReconciliation = true;
    target.recordId = 'record-original';
    target.remoteFid = 'fid-original';
    const originalDigest = target.contentDigest;
    store.save(manifest);
    const st = require('node:fs').statSync(target.absolutePath);
    writeFileSync(target.absolutePath, 'ALPHX');
    utimesSync(target.absolutePath, st.atime, st.mtime);
    let remoteChecks = 0;
    service.getFileInfo = async () => {
      remoteChecks += 1;
      return { filename: 'a.txt', size: target.size, parent_fid: 'parent-1' };
    };
    // No runBatch/refresh beforehand: this is the direct reconcile entry point.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await reconcileBatch(store.load(manifest.batchId), service, store);
      const blocked = result.results.find((row) => row.fileId === target.id);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.reason, 'source_changed_while_bound');
      const persisted = store.load(manifest.batchId).files.find((file) => file.id === target.id);
      assert.equal(persisted.status, 'needs-reconciliation');
      assert.equal(persisted.boundSourceChanged, true);
      assert.equal(persisted.contentDigest, originalDigest);
      assert.equal(persisted.recordId, 'record-original');
      assert.equal(persisted.remoteFid, 'fid-original');
    }
    assert.equal(remoteChecks, 0, 'old remote FID cannot prove changed local bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createFolder transport failure after remote create does not recreate on next run', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const store = createStore(batchRoot);
  const service = createFakeService({
    throwAfterCreateFolders: new Set(['nested']),
  });
  const { manifest } = await resolveBatchForUpload(store, service, {
    paths: [folder],
    parentFid: 'parent-1',
  });
  const first = await runBatch(manifest, service, store, { progressIntervalMs: 0 }).catch((error) => error);
  assert.equal(first.code, 'DIR_CREATE_AMBIGUOUS');
  assert.deepEqual(
    service.createdFolders.map((d) => d.dirPath),
    ['folder', 'nested'],
  );
  const afterFirst = store.load(manifest.batchId);
  assert.equal(afterFirst.dirs['folder'].status, 'created');
  assert.equal(afterFirst.dirs['folder/nested'].status, 'needs-reconciliation');
  assert.equal(afterFirst.dirs['folder/nested'].fid, null);

  const service2 = createFakeService();
  const second = await runBatch(store.load(manifest.batchId), service2, store, { progressIntervalMs: 0 }).catch((error) => error);
  assert.equal(second.code, 'DIR_NEEDS_RECONCILIATION');
  assert.equal(service2.createdFolders.length, 0, 'must not issue a second createFolder');
  assert.equal(store.load(manifest.batchId).dirs['folder/nested'].status, 'needs-reconciliation');
  rmSync(dir, { recursive: true, force: true });
});

test('identity resolution lock serializes first match/create across processes', async () => {
  const { folder, batchRoot, dir } = makeTree();
  const store = createStore(batchRoot);
  const lock = store.acquireResolutionLock({
    userId: 'user-1',
    sourceRoots: [folder],
    parentFidRequested: 'parent-1',
  });

  const childScript = `
    const { createStore, resolveBatchForUpload } = require(${JSON.stringify(join(root, 'scripts/lib/upload-batch.cjs'))});
    const store = createStore(${JSON.stringify(batchRoot)});
    const service = {
      async getAccount() { return { userId: 'user-1' }; },
    };
    resolveBatchForUpload(store, service, {
      paths: [${JSON.stringify(folder)}],
      parentFid: 'parent-1',
    }).then((resolved) => {
      process.stdout.write(JSON.stringify({ ok: true, created: resolved.created, batchId: resolved.manifest.batchId }));
    }).catch((error) => {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
      process.exitCode = 1;
    });
  `;
  const blocked = spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });
  const blockedPayload = JSON.parse(blocked.stdout || '{}');
  assert.equal(blockedPayload.ok, false);
  assert.ok(
    blockedPayload.code === 'RESOLUTION_LOCKED' || blockedPayload.code === 'BATCH_LOCKED',
    `expected resolution lock failure, got ${blockedPayload.code}: ${blockedPayload.message}`,
  );

  // Stale resolution lock must also fail closed (no auto-takeover).
  const lockFile = join(batchRoot, `.resolve-${resolutionIdentityKey({
    userId: 'user-1',
    sourceRoots: [folder],
    parentFidRequested: 'parent-1',
  })}.lock`);
  lock.release();
  writeFileSync(lockFile, `${JSON.stringify({ pid: 999999, nonce: 'dead', startedAt: new Date().toISOString() })}\n`);
  await assert.rejects(
    () => resolveBatchForUpload(store, createFakeService(), { paths: [folder], parentFid: 'parent-1' }),
    (error) => error.code === 'STALE_LOCK',
  );
  rmSync(lockFile, { force: true });

  // Contended multiprocess first upload: exactly one created manifest for the identity.
  const worker = `
    (async () => {
      const { createStore, resolveBatchForUpload } = require(${JSON.stringify(join(root, 'scripts/lib/upload-batch.cjs'))});
      const store = createStore(${JSON.stringify(batchRoot)});
      const service = { async getAccount() { return { userId: 'user-1' }; } };
      const started = Date.now();
      let lastError = null;
      while (Date.now() - started < 3000) {
        try {
          const resolved = await resolveBatchForUpload(store, service, {
            paths: [${JSON.stringify(folder)}],
            parentFid: 'parent-1',
          });
          process.stdout.write(JSON.stringify({ ok: true, created: resolved.created, batchId: resolved.manifest.batchId }));
          return;
        } catch (error) {
          lastError = error;
          if (error.code !== 'RESOLUTION_LOCKED' && error.code !== 'STALE_LOCK') {
            process.stdout.write(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
            process.exitCode = 1;
            return;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      process.stdout.write(JSON.stringify({ ok: false, code: lastError && lastError.code || 'TIMEOUT', message: lastError && lastError.message || 'timeout' }));
      process.exitCode = 1;
    })().catch((error) => {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
      process.exitCode = 1;
    });
  `;
  const payloads = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code, stdout, stderr, payload: JSON.parse(stdout || '{}') });
      } catch (error) {
        reject(new Error(`worker output parse failed (${code}): ${stdout} ${stderr}`));
      }
    });
  })));
  assert.ok(
    payloads.every((row) => row.payload.ok),
    `all workers should resolve after retry: ${JSON.stringify(payloads.map((row) => row.payload))}`,
  );
  const batchIds = new Set(payloads.map((row) => row.payload.batchId));
  assert.equal(batchIds.size, 1, 'all workers must share one batch identity');
  assert.equal(payloads.filter((row) => row.payload.created).length, 1, 'exactly one worker creates the manifest');
  assert.equal(store.listBatchIds().length, 1);
  rmSync(dir, { recursive: true, force: true });
});
