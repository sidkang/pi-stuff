/**
 * Minimal CDP client - no puppeteer, no hangs
 */

export function consumeLocalFlag(argv = process.argv) {
  let local = false;
  for (let i = argv.length - 1; i >= 2; i--) {
    if (argv[i] === "--local") {
      argv.splice(i, 1);
      local = true;
    }
  }
  return local;
}

export const localMode = consumeLocalFlag();

export function resolveConnection(env = process.env, forceLocal = localMode) {
  const endpoint = env.CDP_ENDPOINT?.trim();
  if (endpoint && !forceLocal) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("CDP_ENDPOINT is not a valid URL");
    }

    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      throw new Error("CDP_ENDPOINT must use http:, https:, ws:, or wss:");
    }

    if (url.protocol === "http:" || url.protocol === "https:") {
      const path = url.pathname.replace(/\/$/, "");
      if (!path.endsWith("/json/version")) {
        url.pathname = `${path}/json/version`;
      } else {
        url.pathname = path;
      }
    }

    return {
      external: true,
      url: url.href,
      apiKey: env.CDP_API_KEY?.trim() || null,
    };
  }

  const host = env.BROWSER_DEBUG_HOST || "localhost";
  const port = Number(env.BROWSER_DEBUG_PORT || 9222);
  return {
    external: false,
    url: `http://${host}:${port}/json/version`,
    port,
  };
}

function exceptionMessage(result) {
  return (
    result.exceptionDetails.exception?.description || result.exceptionDetails.text
  );
}

function remoteObjectValue(remoteObject) {
  if (!remoteObject) return undefined;
  if ("value" in remoteObject) return remoteObject.value;

  switch (remoteObject.unserializableValue) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
  }

  if (remoteObject.type === "bigint" && remoteObject.unserializableValue) {
    return BigInt(remoteObject.unserializableValue.slice(0, -1));
  }

  return undefined;
}

function connectWebSocket(webSocketDebuggerUrl, timeout, apiKey = null) {
  return new Promise((resolve, reject) => {
    const ws = apiKey
      ? new WebSocket(webSocketDebuggerUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
      : new WebSocket(webSocketDebuggerUrl);
    let settled = false;
    const connectTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error("WebSocket connect timeout"));
    }, timeout);

    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      resolve(new CDP(ws));
    });
    ws.addEventListener("error", (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      reject(event.error || new Error("WebSocket connection failed"));
    });
  });
}

async function discoverWebSocket(connection, signal) {
  const attempts = connection.apiKey
    ? [
        { Authorization: `Bearer ${connection.apiKey}` },
        { "X-API-Key": connection.apiKey },
      ]
    : [{}];

  for (let i = 0; i < attempts.length; i++) {
    const response = await fetch(connection.url, {
      headers: attempts[i],
      signal,
    });
    if (
      !response.ok &&
      (response.status === 401 || response.status === 403) &&
      i + 1 < attempts.length
    ) {
      continue;
    }
    if (!response.ok) {
      throw new Error(`CDP endpoint returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (body?.webSocketDebuggerUrl) {
      return body.webSocketDebuggerUrl;
    }
    if (typeof body?.cdp_url === "string") {
      const endpointUrl = new URL(connection.url);
      const cdpUrl = new URL(body.cdp_url, `${endpointUrl.origin}/`);
      if (!cdpUrl.pathname.endsWith("/json/version")) {
        cdpUrl.pathname = `${cdpUrl.pathname.replace(/\/$/, "")}/json/version`;
      }
      const versionResponse = await fetch(cdpUrl, {
        headers: cdpUrl.origin === endpointUrl.origin ? attempts[i] : {},
        signal,
      });
      if (!versionResponse.ok) {
        throw new Error(`CDP version endpoint returned HTTP ${versionResponse.status}`);
      }
      const version = await versionResponse.json();
      if (version?.webSocketDebuggerUrl) {
        return version.webSocketDebuggerUrl;
      }
    }
    throw new Error("CDP endpoint returned no webSocketDebuggerUrl");
  }
}

export async function connect(timeout = 5000) {
  let connection;
  try {
    connection = resolveConnection();
  } catch {
    throw new Error(
      "Could not connect to CDP_ENDPOINT. Ask the user before retrying with --local.",
    );
  }

  if (connection.url.startsWith("ws:") || connection.url.startsWith("wss:")) {
    try {
      return await connectWebSocket(connection.url, timeout, connection.apiKey);
    } catch {
      throw new Error(
        "Could not connect to CDP_ENDPOINT. Ask the user before retrying with --local.",
      );
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const webSocketDebuggerUrl = await discoverWebSocket(
      connection,
      controller.signal,
    );
    clearTimeout(timeoutId);
    return await connectWebSocket(
      webSocketDebuggerUrl,
      timeout,
      connection.apiKey,
    );
  } catch (e) {
    clearTimeout(timeoutId);
    if (connection.external) {
      throw new Error(
        "Could not connect to CDP_ENDPOINT. Ask the user before retrying with --local.",
      );
    }
    if (e.name === "AbortError") {
      throw new Error(
        `Connection timeout - is Chrome running with --remote-debugging-port=${connection.port}?`,
      );
    }
    throw e;
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.callbacks = new Map();
    this.sessions = new Map();
    this.eventHandlers = new Map();

    ws.addEventListener("message", (event) => {
      const data = event.data;
      const text = typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : ArrayBuffer.isView(data)
            ? new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
            : String(data);
      const msg = JSON.parse(text);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.result);
        }
        return;
      }

      if (msg.method) {
        this.emit(msg.method, msg.params || {}, msg.sessionId || null);
      }
    });
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set());
    }
    this.eventHandlers.get(method).add(handler);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    const handlers = this.eventHandlers.get(method);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.eventHandlers.delete(method);
    }
  }

  emit(method, params, sessionId) {
    const handlers = this.eventHandlers.get(method);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(params, sessionId);
      } catch {
        // Ignore handler errors to keep CDP session alive.
      }
    }
  }

  send(method, params = {}, sessionId = null, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const msgId = ++this.id;
      const msg = { id: msgId, method, params };
      if (sessionId) msg.sessionId = sessionId;

      const timeoutId = setTimeout(() => {
        this.callbacks.delete(msgId);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);

      this.callbacks.set(msgId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      });

      this.ws.send(JSON.stringify(msg));
    });
  }

  async getPages() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page");
  }

  async attachToPage(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return sessionId;
  }

  async evaluate(sessionId, expression, timeout = 30000) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
      timeout
    );

    if (result.exceptionDetails) {
      throw new Error(exceptionMessage(result));
    }
    return result.result?.value;
  }

  async evaluateRepl(sessionId, expression, timeout = 30000) {
    const objectGroup = `agent-eval-${Date.now()}-${Math.random()}`;

    try {
      const result = await this.send(
        "Runtime.evaluate",
        {
          expression,
          objectGroup,
          returnByValue: false,
          replMode: true,
        },
        sessionId,
        timeout
      );

      if (result.exceptionDetails) {
        throw new Error(exceptionMessage(result));
      }

      let remoteObject = result.result;
      if (remoteObject?.subtype === "promise" && remoteObject.objectId) {
        const awaited = await this.send(
          "Runtime.awaitPromise",
          {
            promiseObjectId: remoteObject.objectId,
            returnByValue: true,
          },
          sessionId,
          timeout
        );

        if (awaited.exceptionDetails) {
          throw new Error(exceptionMessage(awaited));
        }

        remoteObject = awaited.result;
      } else if (remoteObject?.objectId) {
        const cloned = await this.send(
          "Runtime.callFunctionOn",
          {
            objectId: remoteObject.objectId,
            functionDeclaration: "function() { return this; }",
            returnByValue: true,
          },
          sessionId,
          timeout
        );

        if (cloned.exceptionDetails) {
          throw new Error(exceptionMessage(cloned));
        }

        remoteObject = cloned.result;
      }

      return remoteObjectValue(remoteObject);
    } finally {
      await this.send(
        "Runtime.releaseObjectGroup",
        { objectGroup },
        sessionId,
        1000,
      ).catch(() => {});
    }
  }

  async screenshot(sessionId, timeout = 10000) {
    const { data } = await this.send(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
      timeout
    );
    return Buffer.from(data, "base64");
  }

  async navigate(sessionId, url, timeout = 30000) {
    await this.send("Page.navigate", { url }, sessionId, timeout);
  }

  async getFrameTree(sessionId) {
    const { frameTree } = await this.send("Page.getFrameTree", {}, sessionId);
    return frameTree;
  }

  async evaluateInFrame(sessionId, frameId, expression, timeout = 30000) {
    // Create isolated world for the frame
    const { executionContextId } = await this.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "cdp-eval" },
      sessionId
    );

    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        contextId: executionContextId,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
      timeout
    );

    if (result.exceptionDetails) {
      throw new Error(exceptionMessage(result));
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}
