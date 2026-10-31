/**
 * host.js — fnOS 桌面壳（Trim App）桥接
 *
 * fnOS 的微应用（micro_app=true）以 iframe 形式嵌在桌面壳里，壳通过
 * postMessage / flutter_inappwebview 暴露一组能力：
 *   openFileManager(path)  打开文件管理器并定位到 path（目录）
 *   openFile(path)         用默认程序打开文件
 *   showFileDetails(...)   显示文件详情
 *   openApp / openCustomApp / setTitle / getPlatformConfig ...
 *
 * 必须走壳提供的桥接，直接用 window.open('/#/app/files?path=...') 是无效的：
 * 桌面壳的 hash 路由不会被新标签页解释成"打开文件管理器到某目录"。
 *
 * 这里按 fnOS 官方 SDK（web-app.js，TrimApp）的协议实现一个极简版本：
 *   1. 移动端（User-Agent 带 FNAppType）：window.flutter_inappwebview.callHandler
 *   2. 桌面端 iframe：Penpal 握手（SYN → SYN-ACK → ACK）后调用方法
 *   3. 扩展宿主（trimjs-extension-host）：postMessage request/response
 *
 * 所有能力都做了可用性探测，单独在浏览器里打开时自动降级。
 */

const DEBUG = false;
const log = (...a) => { if (DEBUG) console.log('[trtree/host]', ...a); };

const FN_UA_RE = /FNOS\/([\d.]+)|FNAppType\/(\w+)|FNAppVer\/([\d.]+)/g;

/** 解析 User-Agent 里的 fnOS 标记 */
export function fnUaInfo(ua = navigator.userAgent || '') {
  const out = {};
  FN_UA_RE.lastIndex = 0;
  let m;
  while ((m = FN_UA_RE.exec(ua)) !== null) {
    if (m[1]) out.fnOSVersion = m[1];
    if (m[2]) out.fnAppType = m[2];
    if (m[3]) out.fnAppVersion = m[3];
  }
  return out;
}

/** 是否运行在 fnOS 移动端壳（flutter_inappwebview）里 */
function isMobileHost() {
  return !!fnUaInfo().fnAppVersion;
}

/* ------------------------------------------------------------------ */
/* Penpal 风格握手（桌面端 iframe）                                     */
/* ------------------------------------------------------------------ */

const P = { Call: 'call', Reply: 'reply', Syn: 'syn', SynAck: 'synAck', Ack: 'ack' };

let seq = 0;
const nextId = () => ++seq;

/**
 * 和父窗口握手，成功后返回 { methods }。
 * 超时或父窗口无响应则 reject。
 */
function connectParent({ timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || window.parent === window) {
      reject(new Error('not in iframe'));
      return;
    }
    let done = false;
    const pending = new Map();
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      reject(new Error('handshake timeout'));
    }, timeout);

    function settle(fn, arg) {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      fn(arg);
    }

    function onMsg(ev) {
      const d = ev.data;
      if (!d || typeof d !== 'object') return;

      // 1) 握手应答
      if (!done && d.penpal === P.SynAck && ev.source === window.parent) {
        const { id, appName, methodNames = [] } = d;
        // 回复 ACK，并把本端方法表通告给父窗口
        window.parent.postMessage({ penpal: P.Ack, methodNames: [], config: {} }, '*');
        log('connected', { id, appName, methodNames });

        const methods = {};
        for (const name of methodNames) {
          methods[name] = (...args) => new Promise((res, rej) => {
            const mid = nextId();
            pending.set(mid, { res, rej });
            window.parent.postMessage({ penpal: P.Call, id: mid, methodName: name, args }, '*');
          });
        }
        // 记录 app 身份，供 UI 判定管理员
        window.__trtreeHost = { id, appName, methods };
        settle(resolve, { id, appName, methods });
        return;
      }

      // 2) 方法调用应答
      if (d.penpal === P.Reply && ev.source === window.parent) {
        const cb = pending.get(d.id);
        if (!cb) return;
        pending.delete(d.id);
        if (d.returnValueIsError) {
          const err = new Error((d.returnValue && d.returnValue.message) || 'host error');
          Object.assign(err, d.returnValue);
          cb.rej(err);
        } else {
          cb.res(d.returnValue);
        }
      }
    }

    window.addEventListener('message', onMsg);
    // 发起握手
    window.parent.postMessage({ penpal: P.Syn }, '*');
  });
}

/* ------------------------------------------------------------------ */
/* 扩展宿主（trimjs-extension-host）                                    */
/* ------------------------------------------------------------------ */

const EXT_HOST = 'trimjs-extension-host';

function extRequest(method, params, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = `trtree-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMsg);
      reject(new Error(`extension host timeout: ${method}`));
    }, timeoutMs);
    function onMsg(ev) {
      const d = ev.data;
      if (!d || d.source !== EXT_HOST || d.kind !== 'response' || d.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      if (d.payload && d.payload.ok) resolve(d.payload.result);
      else reject(new Error((d.payload && d.payload.error && d.payload.error.message) || 'host error'));
    }
    window.addEventListener('message', onMsg);
    window.postMessage({
      source: EXT_HOST,
      version: 1,
      kind: 'request',
      requestId,
      payload: { method, params },
    }, '*');
  });
}

/* ------------------------------------------------------------------ */
/* 移动端（flutter_inappwebview）                                       */
/* ------------------------------------------------------------------ */

function callFlutter(method, ...args) {
  const bridge = window.flutter_inappwebview;
  if (!bridge || typeof bridge.callHandler !== 'function') {
    return Promise.reject(new Error('flutter bridge unavailable'));
  }
  return bridge.callHandler(method, ...args).then((raw) => {
    if (!raw) return null;
    try {
      const outer = JSON.parse(raw);
      return outer && outer.result ? JSON.parse(outer.result) : outer;
    } catch (e) {
      return null;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                             */
/* ------------------------------------------------------------------ */

let connectorPromise = null;

/** 惰性建立与宿主（桌面壳 / 扩展宿主 / 移动端）的连接 */
function connect() {
  if (connectorPromise) return connectorPromise;
  connectorPromise = (async () => {
    const ua = fnUaInfo();
    if (ua.fnAppVersion) {
      return { kind: 'mobile', call: (m, ...a) => callFlutter(m, ...a) };
    }
    try {
      const { appName, methods } = await connectParent({ timeout: 1500 });
      return { kind: 'parent', appName, call: (m, ...a) => (methods[m] ? methods[m](...a) : Promise.reject(new Error(`no method ${m}`))) };
    } catch (e) {
      log('parent unavailable:', e.message);
    }
    try {
      await extRequest('handshake', { debug: false }, { timeoutMs: 1200 });
      return { kind: 'extension', call: (m, p) => extRequest(m, p) };
    } catch (e) {
      log('extension host unavailable:', e.message);
    }
    return null;
  })();
  return connectorPromise;
}

/** 当前是否运行在 fnOS 壳内（能调用宿主能力） */
export async function hostAvailable() {
  return !!(await connect());
}

/**
 * 打开文件管理器并定位到某个目录（fnOS 原生行为）。
 *
 * 第二个参数 { isAdmin }：
 *   - false（默认）：普通"我的文件 / 共享目录"视角，界面和权限与用户平时一致
 *   - true：管理员的"全部文件"视角，只在目标目录普通用户看不见时才需要
 *             （别人的共享目录 volN/<其他uid>/、团队文件 volN/@team/、系统目录）
 *
 * 桌面壳只有在 isAdmin=true 时才走 AllFileManager（all-files），否则走
 * FileManager（my-files / other-files）。
 */
export async function openFileManager(path, opts = {}) {
  const host = await connect();
  if (!host) throw new Error('HOST_UNAVAILABLE');
  const isAdmin = opts.isAdmin === true;
  const args = { isAdmin };

  if (host.kind === 'parent') {
    return host.call('openFileManager', path, args);
  }
  if (host.kind === 'extension') {
    try {
      return await host.call('openFileManager', path, args);
    } catch (e) {
      // 扩展宿主只暴露无参版本时退化为 openFileManagerApp
      return host.call('openFileManagerApp');
    }
  }
  // 移动端：openFileManager 需要 appApi >= v1.0，老版本退化为 openFile
  try {
    return await host.call('openFileManager', path);
  } catch (e) {
    return host.call('openFile', path);
  }
}

/** 用系统默认程序打开单个文件 */
export async function openFile(path) {
  const host = await connect();
  if (!host) throw new Error('HOST_UNAVAILABLE');
  return host.call('openFile', path);
}

/** 显示文件详情面板（可选能力） */
export async function showFileDetails(paths, options = {}) {
  const host = await connect();
  if (!host) throw new Error('HOST_UNAVAILABLE');
  return host.call('showFileDetails', paths, options);
}

export default { hostAvailable, openFileManager, openFile, showFileDetails, fnUaInfo };
