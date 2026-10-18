'use strict';

/**
 * CLI wiring for duplicate-safe upload batches.
 * Keeps SDK listeners/task APIs inside a small adapter; orchestration lives in upload-batch.cjs.
 */

const path = require('node:path');
const {
  createStore,
  resolveBatchForUpload,
  runBatch,
  reconcileBatch,
  summarize,
  deriveBatchStatus,
  RECONCILE_BOUNDARY,
  assertAccount,
} = require('./upload-batch.cjs');

function createSdkService(host) {
  const {
    getManager,
    initUpload,
    initBrowser,
    FileAdapter,
    getAccount,
    detectAgent,
  } = host;

  let manager = null;
  let settle = null;
  let listeners = null;
  let activeRecordIds = new Set();

  function upload() {
    if (!manager?.upload) throw new Error('upload manager unavailable');
    return manager.upload;
  }

  function browser() {
    if (!manager?.fileBrowser) throw new Error('file browser unavailable');
    return manager.fileBrowser;
  }

  return {
    async getAccount() {
      const account = await getAccount();
      if (!account?.userId) return null;
      return { userId: String(account.userId) };
    },

    async ensureReady() {
      manager = await getManager();
      await initUpload(manager, {
        onProgress(info) {
          settle?.noteProgress?.();
          listeners?.onProgress?.(info);
        },
        onSuccess(info) {
          settle?.noteProgress?.();
          listeners?.onSuccess?.(info);
          activeRecordIds.delete(info.recordId);
          maybeSettle();
        },
        onFailure(info) {
          settle?.noteProgress?.();
          listeners?.onFailure?.(info);
          activeRecordIds.delete(info.recordId);
          maybeSettle();
        },
        onCancel() {
          settle?.noteProgress?.();
          maybeSettle();
        },
      });
      await initBrowser(manager);
    },

    async bindListeners(next) {
      listeners = next;
    },

    createFileReference(filePath) {
      return new FileAdapter().createFileReference(filePath);
    },

    async createFolder({ dirPath, parentFid }) {
      const result = await browser().createFolder({
        dirPath,
        ...(parentFid ? { parentFid } : {}),
      });
      if (result.status !== 0 || !result.data?.fid) {
        const error = new Error(result.agent_msg || result.error_info || 'createFolder failed');
        error.code = result.errno || 'DIR_CREATE_FAILED';
        throw error;
      }
      return { fid: String(result.data.fid) };
    },

    async createTasks(inputs) {
      const agentId = detectAgent?.();
      const payload = inputs.map((item) => ({
        ...item,
        ...(agentId ? { agentId } : {}),
      }));
      const result = await upload().createTask(payload);
      if (result.status !== 0) {
        const error = new Error(result.error_info || 'createTask failed');
        error.code = result.errno || 'CREATE_TASK_FAILED';
        throw error;
      }
      const rows = result.data || [];
      for (const row of rows) {
        if (row.recordId) activeRecordIds.add(row.recordId);
      }
      return rows.map((row) => ({
        recordId: row.recordId,
        fileName: row.fileName,
        fileSize: row.fileSize,
      }));
    },

    async restoreTask(recordId, fileRef) {
      const result = await upload().restoreTask(recordId, fileRef);
      if (result.status !== 0 || !result.data?.success) {
        return { success: false, error: result.data?.error || result.error_info || 'restore failed' };
      }
      activeRecordIds.add(recordId);
      return { success: true };
    },

    async start() {
      // Bundled SDK UploadManager.start() is process-global: it drains every pending
      // (uploadState===0) task in the shared queue. There is no recordId-scoped start API.
      // Only launch when this batch selected concrete IDs, and refuse if foreign pending
      // tasks would also be started. Create the settle waiter only after checks pass so a
      // refused start cannot leave a dangling poller/rejection.
      if (activeRecordIds.size === 0) {
        settle = createSettleWaiter({
          getActiveIds: () => activeRecordIds,
          getUpload: () => upload(),
          stallTimeoutMs: host.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
          pollIntervalMs: host.pollIntervalMs ?? 500,
          onStall(error) {
            settle?.fail(error);
          },
        });
        settle.check();
        return;
      }

      const listed = await upload().queryAllTask();
      const rows = listed?.data || [];
      const foreignPending = rows.filter((row) => {
        if (!row?.recordId) return false;
        if (activeRecordIds.has(row.recordId)) return false;
        return Number(row.uploadState) === 0;
      });
      if (foreignPending.length) {
        const error = new Error(
          `refusing global upload().start(): ${foreignPending.length} foreign pending SDK task(s) would be launched alongside this batch`,
        );
        error.code = 'FOREIGN_UPLOAD_TASKS';
        error.foreignRecordIds = foreignPending.map((row) => String(row.recordId));
        error.activeRecordIds = [...activeRecordIds];
        throw error;
      }

      upload().start();
      settle = createSettleWaiter({
        getActiveIds: () => activeRecordIds,
        getUpload: () => upload(),
        // Bounded liveness: unresolved active records without terminal SDK state fail closed.
        stallTimeoutMs: host.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
        pollIntervalMs: host.pollIntervalMs ?? 500,
        onStall(error) {
          settle?.fail(error);
        },
      });
    },

    async waitForIdle() {
      if (!settle) return;
      await settle.promise;
    },

    async getFileInfo(fid) {
      const result = await browser().getFileInfo(fid, { fetchFullPath: true });
      if (result.status !== 0 || !result.data) return null;
      return result.data;
    },

    async pauseAll() {
      if (manager?.upload?.pauseAllTask) await manager.upload.pauseAllTask();
    },
  };

  function maybeSettle() {
    settle?.check();
  }
}

const DEFAULT_STALL_TIMEOUT_MS = 120_000;

/** In-process test-only service override. Not selectable via process environment. */
let testServiceFactory = null;

function setUploadBatchServiceFactoryForTests(factory) {
  testServiceFactory = typeof factory === 'function' ? factory : null;
}

function createSettleWaiter({
  getActiveIds,
  getUpload,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  pollIntervalMs = 500,
  onStall = null,
  now = () => Date.now(),
}) {
  let resolved = false;
  let rejectFn;
  let resolveFn;
  const startedAt = now();
  let lastProgressAt = startedAt;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  function finishFail(error) {
    if (resolved) return;
    resolved = true;
    clearInterval(timer);
    const err = error instanceof Error ? error : new Error(String(error));
    if (!err.code) err.code = 'UPLOAD_UNKNOWN_OUTCOME';
    if (typeof onStall === 'function' && (err.code === 'ACK_TIMEOUT' || err.code === 'UPLOAD_STALL_TIMEOUT')) {
      try { onStall(err); } catch {}
    }
    rejectFn(err);
  }

  async function check() {
    if (resolved) return;
    try {
      const active = getActiveIds();
      if (active.size === 0) {
        resolved = true;
        resolveFn();
        return;
      }
      const all = (await getUpload().queryAllTask()).data || [];
      const byId = new Map(all.map((row) => [row.recordId, row]));
      let sawTerminal = false;
      for (const recordId of [...active]) {
        const row = byId.get(recordId);
        if (!row) continue;
        if (row.uploadState === 4 || row.uploadState === 5 || row.uploadState === 6) {
          active.delete(recordId);
          sawTerminal = true;
        }
      }
      if (sawTerminal) lastProgressAt = now();
      if (active.size === 0) {
        resolved = true;
        resolveFn();
        return;
      }
      const stallMs = Number.isFinite(stallTimeoutMs) ? stallTimeoutMs : DEFAULT_STALL_TIMEOUT_MS;
      if (stallMs > 0 && now() - lastProgressAt >= stallMs) {
        const error = new Error(
          `upload stall timeout after ${stallMs}ms with ${active.size} active record(s) and no terminal SDK state; treating as unknown outcome`,
        );
        error.code = 'ACK_TIMEOUT';
        error.activeRecordIds = [...active];
        finishFail(error);
      }
    } catch (error) {
      finishFail(error);
    }
  }

  const timer = setInterval(() => {
    check().catch((error) => finishFail(error));
  }, Math.max(10, Number(pollIntervalMs) || 500));

  const wrapped = {
    promise: promise.finally(() => clearInterval(timer)),
    check,
    noteProgress() {
      lastProgressAt = now();
    },
    fail(error) {
      finishFail(error);
    },
  };
  return wrapped;
}

function createUploadBatchService(host) {
  if (testServiceFactory) return testServiceFactory(host);
  return createSdkService(host);
}

function writeResult(ctx, payload) {
  ctx.output.flushResult(payload);
}

function attachUploadCommand(command, host) {
  command
    .argument('[paths...]', '本地文件/文件夹路径列表')
    .option('--file-path <path>', '本地文件路径（向后兼容，推荐直接传参）')
    .option('--parent-fid <fid>', '目标目录')
    .option('--batch-id <id>', '继续指定上传批次（普通重试应优先用此或自动匹配）')
    .option('--new-batch', '显式新建批次（不会在存在歧义时静默新建）')
    .action(async (paths, options) => {
      await runUploadAction(host, paths, options);
    });
}

function attachUploadBatchSubcommands(parent, host) {
  const O = host.O;

  parent.addCommand(
    new O('status')
      .description('查看上传批次状态与证据')
      .option('--batch-id <id>', '批次 ID')
      .action(async (options) => {
        await runStatusAction(host, options);
      }),
  );

  parent.addCommand(
    new O('batches')
      .description('列出本地上传批次')
      .action(async () => {
        await runBatchesAction(host);
      }),
  );

  parent.addCommand(
    new O('reconcile')
      .description('对 needs-reconciliation 条目做只读/有限自动核对（仅已记录 remote FID）')
      .requiredOption('--batch-id <id>', '批次 ID')
      .action(async (options) => {
        await runReconcileAction(host, options);
      }),
  );
}

function resolvePaths(host, paths, filePath) {
  return host.resolvePaths(paths, filePath);
}

function buildUploadResultData(store, latest, counts) {
  return {
    batchId: latest.batchId,
    status: latest.status,
    counts,
    fids: latest.files.filter((f) => f.remoteFid).map((f) => f.remoteFid),
    successCount: counts.success,
    needsReconciliation: counts.needsReconciliation,
    parentFidPinned: latest.parentFidPinned,
    reconcileBoundary: RECONCILE_BOUNDARY,
    manifestPath: store.manifestPath(latest.batchId),
    eventsPath: store.eventsPath(latest.batchId),
  };
}

async function runUploadAction(host, paths, options) {
  const ctx = host.context();
  const resolved = resolvePaths(host, paths, options.filePath);
  const store = createStore(host.batchRoot?.() || undefined);
  const service = createUploadBatchService(host);

  let resolvedBatch;
  try {
    resolvedBatch = await resolveBatchForUpload(store, service, {
      paths: resolved,
      parentFid: options.parentFid,
      batchId: options.batchId,
      newBatch: !!options.newBatch,
    });
  } catch (error) {
    failClosed(host, ctx, error);
    return;
  }

  const { manifest, created } = resolvedBatch;
  ctx.output.info(`${created ? '创建' : '继续'}上传批次: ${manifest.batchId}`);
  ctx.output.info(`文件数: ${manifest.files.length}`);
  if (manifest.parentFidRequested) ctx.output.info(`目标目录 FID: ${manifest.parentFidRequested}`);
  else ctx.output.info('未指定 --parent-fid，使用服务默认位置，并在获知后钉住实际父目录');

  const result = await runBatch(manifest, service, store, {
    onEvent(event) {
      if (event.type === 'progress') {
        writeResult(ctx, {
          type: 'progress',
          action: 'upload',
          msg: 'uploading',
          data: {
            batchId: manifest.batchId,
            recordId: event.recordId,
            current: event.uploadSize,
            total: event.fileSize,
          },
        });
        return;
      }
      if (event.type === 'file_success') {
        writeResult(ctx, {
          type: 'list',
          action: 'upload',
          code: 0,
          msg: '上传成功',
          data: {
            batchId: manifest.batchId,
            fileId: event.remoteFid,
            recordId: event.recordId,
            fileName: path.basename(event.relativePath),
            relativePath: event.relativePath,
            instantUpload: event.instantUpload,
          },
        });
        return;
      }
      if (event.type === 'file_failed') {
        writeResult(ctx, {
          type: 'list',
          action: 'upload',
          code: event.error?.code || -1,
          msg: event.error?.message || '上传失败',
          data: {
            batchId: manifest.batchId,
            recordId: event.recordId,
            relativePath: event.relativePath,
          },
        });
      }
    },
  });

  const latest = store.load(manifest.batchId);
  const counts = result.counts || summarize(latest);
  const data = buildUploadResultData(store, latest, counts);

  if (result.exitCode !== 0) {
    // Single final result: throw complete CliError and let the top-level handler emit once.
    throw new host.CliError(
      'upload',
      result.exitCode === 2 ? -206 : -204,
      result.message,
      result.exitCode === 2 ? 2 : 1,
      data,
    );
  }

  writeResult(ctx, {
    type: 'result',
    action: 'upload',
    code: 0,
    msg: result.message,
    data,
  });
}

async function requireCurrentAccount(host) {
  const service = createUploadBatchService(host);
  const account = await service.getAccount();
  if (!account?.userId) {
    throw Object.assign(new Error('missing account userId'), { code: 'AUTH_REQUIRED' });
  }
  return { service, account, userId: String(account.userId) };
}

function listAccountBatchIds(store, userId) {
  return store.listBatchIds().filter((id) => {
    try {
      const manifest = store.load(id);
      return String(manifest.account?.userId) === String(userId);
    } catch {
      return false;
    }
  });
}

async function runStatusAction(host, options) {
  const ctx = host.context();
  const store = createStore(host.batchRoot?.() || undefined);
  let userId;
  try {
    ({ userId } = await requireCurrentAccount(host));
  } catch (error) {
    failClosed(host, ctx, error);
    return;
  }
  if (!options.batchId) {
    const ids = listAccountBatchIds(store, userId);
    if (ids.length === 0) {
      ctx.finish('upload status', { batches: [], totalCount: 0, accountUserId: userId });
      return;
    }
    if (ids.length > 1) {
      failClosed(host, ctx, Object.assign(new Error('multiple batches exist for current account; pass --batch-id'), {
        code: 'BATCH_ID_REQUIRED',
        batchIds: ids,
      }));
      return;
    }
    options.batchId = ids[0];
  }
  const manifest = store.load(options.batchId);
  try {
    assertAccount(manifest, userId);
  } catch (error) {
    failClosed(host, ctx, error);
    return;
  }
  manifest.status = deriveBatchStatus(manifest);
  writeResult(ctx, {
    type: 'result',
    action: 'upload status',
    code: 0,
    msg: 'ok',
    data: {
      batchId: manifest.batchId,
      status: manifest.status,
      accountUserId: manifest.account?.userId,
      sourceRoots: manifest.sourceRoots,
      parentFidRequested: manifest.parentFidRequested,
      parentFidPinned: manifest.parentFidPinned,
      counts: summarize(manifest),
      files: manifest.files.map((file) => ({
        id: file.id,
        relativePath: file.relativePath,
        size: file.size,
        status: file.status,
        needsReconciliation: !!file.needsReconciliation,
        recordId: file.recordId,
        remoteFid: file.remoteFid,
        error: file.error,
      })),
      dirs: manifest.dirs,
      reconcileBoundary: RECONCILE_BOUNDARY,
      manifestPath: store.manifestPath(manifest.batchId),
      eventsPath: store.eventsPath(manifest.batchId),
    },
  });
  ctx.finish('upload status', { batchId: manifest.batchId, status: manifest.status, counts: summarize(manifest) });
}

async function runBatchesAction(host) {
  const ctx = host.context();
  const store = createStore(host.batchRoot?.() || undefined);
  let userId;
  try {
    ({ userId } = await requireCurrentAccount(host));
  } catch (error) {
    failClosed(host, ctx, error);
    return;
  }
  const batches = listAccountBatchIds(store, userId).map((id) => {
    const manifest = store.load(id);
    return {
      batchId: id,
      status: deriveBatchStatus(manifest),
      updatedAt: manifest.updatedAt,
      userId: manifest.account?.userId,
      sourceRoots: manifest.sourceRoots,
      parentFidRequested: manifest.parentFidRequested,
      parentFidPinned: manifest.parentFidPinned,
      counts: summarize(manifest),
    };
  });
  for (const row of batches) {
    writeResult(ctx, { type: 'list', action: 'upload batches', code: 0, msg: '', data: row });
  }
  ctx.finish('upload batches', { totalCount: batches.length, batches, accountUserId: userId });
}

async function runReconcileAction(host, options) {
  const ctx = host.context();
  const store = createStore(host.batchRoot?.() || undefined);
  const manifest = store.load(options.batchId);
  let service;
  try {
    let userId;
    ({ service, userId } = await requireCurrentAccount(host));
    assertAccount(manifest, userId);
  } catch (error) {
    failClosed(host, ctx, error);
    return;
  }
  await service.ensureReady?.();
  const result = await reconcileBatch(manifest, service, store);
  const data = {
    batchId: result.manifest.batchId,
    status: result.manifest.status,
    results: result.results,
    counts: summarize(result.manifest),
    reconcileBoundary: result.boundary,
    manifestPath: store.manifestPath(result.manifest.batchId),
  };
  if (result.manifest.status === 'needs-reconciliation') {
    throw new host.CliError(
      'upload reconcile',
      -206,
      'reconciliation incomplete; see results and boundary',
      2,
      data,
    );
  }
  writeResult(ctx, {
    type: 'result',
    action: 'upload reconcile',
    code: 0,
    msg: 'reconciliation finished',
    data,
  });
  ctx.finish('upload reconcile', { batchId: result.manifest.batchId, status: result.manifest.status });
}

function failClosed(host, ctx, error) {
  const code = error.code || 'UPLOAD_BATCH_ERROR';
  const numeric = code === 'NEEDS_RECONCILIATION'
    || code === 'DIR_CREATE_AMBIGUOUS'
    || code === 'DIR_NEEDS_RECONCILIATION'
    || code === 'AMBIGUOUS_BATCH'
    || code === 'OPEN_BATCH_EXISTS'
    || code === 'COMPLETED_BATCH_EXISTS'
    || code === 'STALE_LOCK'
    || code === 'FOREIGN_UPLOAD_TASKS'
    || code === 'ACCOUNT_MISMATCH'
    ? -206
    : code === 'AUTH_REQUIRED'
      ? -112
      : -204;
  // Do not flush a result here; the top-level CliError handler emits the sole final result.
  throw new host.CliError(
    'upload',
    numeric,
    error.message || String(error),
    numeric === -206 ? 2 : 1,
    {
      errorCode: code,
      batchId: error.batchId,
      batchIds: error.batchIds,
      dirKey: error.dirKey,
      lockPath: error.lockPath,
      manifestSourceRoots: error.manifestSourceRoots,
      suppliedSourceRoots: error.suppliedSourceRoots,
      parentFidRequested: error.parentFidRequested,
      parentFidSupplied: error.parentFidSupplied,
      reconcileBoundary: RECONCILE_BOUNDARY,
    },
  );
}

function createHostFromBundle(globals) {
  const {
    F,
    Bt,
    ot,
    It,
    T,
    A,
    JA,
    O,
    G,
  } = globals;
  return {
    O,
    CliError: G,
    context: () => T(),
    resolvePaths: (paths, filePath) => JA(paths, filePath),
    getManager: async () => F(),
    initUpload: async (manager, listeners) => Bt(manager, listeners),
    initBrowser: async (manager) => ot(manager),
    FileAdapter: It,
    getAccount: async () => A.getAccount(),
    detectAgent: () => A.detectAgent?.(),
    batchRoot: () => process.env.QUARK_UPLOAD_BATCH_DIR || undefined,
  };
}

module.exports = {
  attachUploadCommand,
  attachUploadBatchSubcommands,
  createHostFromBundle,
  createSdkService,
  createUploadBatchService,
  createSettleWaiter,
  setUploadBatchServiceFactoryForTests,
  DEFAULT_STALL_TIMEOUT_MS,
  runUploadAction,
  runStatusAction,
  runBatchesAction,
  runReconcileAction,
};
