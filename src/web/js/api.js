/**
 * api.js — 后端 API 封装（统一超时、错误信息、轮询）
 * 相对路径 'api/'：本地开发为 /api/，fnOS 网关下为 /app/trtree/api/。
 */

const DEFAULT_TIMEOUT = 15000;
const API_BASE = 'api/';

function qs(params) {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {string} path 相对 API 根路径，如 'volumes'
 * @param {Object} opts { method, body, params, timeout }
 */
export async function request(path, opts = {}) {
  const { method = 'GET', body, params, timeout = DEFAULT_TIMEOUT, raw = false } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { Accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(API_BASE + path + qs(params), {
      method,
      headers,
      body: payload,
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new ApiError('请求超时（15 秒）', 0, null);
    }
    throw new ApiError('网络请求失败：' + (err && err.message ? err.message : '未知错误'), 0, null);
  }
  clearTimeout(timer);

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText || ''}`.trim();
    let data = null;
    try {
      data = await res.json();
      if (data && data.error) msg = data.error;
    } catch (_) { /* 非 JSON 错误体 */ }
    throw new ApiError(msg, res.status, data);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch (err) {
    throw new ApiError('响应解析失败', res.status, null);
  }
}

export const api = {
  base: API_BASE,

  health() {
    return request('health', { timeout: 5000 });
  },

  context() {
    return request('context');
  },

  volumes() {
    return request('volumes');
  },

  browse(path) {
    return request('browse', { params: { path } });
  },

  createScan(path, oneFilesystem = true) {
    return request('scans', { method: 'POST', body: { path, oneFilesystem } });
  },

  listScans() {
    return request('scans');
  },

  getScan(id) {
    return request('scans/' + encodeURIComponent(id));
  },

  progress(id) {
    return request('scans/' + encodeURIComponent(id) + '/progress', { timeout: 10000 });
  },

  cancelScan(id) {
    return request('scans/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {} });
  },

  deleteScan(id) {
    return request('scans/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  tree(id, params = {}) {
    return request('scans/' + encodeURIComponent(id) + '/tree', { params });
  },

  /** 嵌套 treemap 数据（WizTree 式子块）：node / budget / area */
  treemap(id, params = {}) {
    return request('scans/' + encodeURIComponent(id) + '/treemap', { params, timeout: 30000 });
  },

  children(id, params = {}) {
    return request('scans/' + encodeURIComponent(id) + '/children', { params });
  },

  search(id, params = {}) {
    return request('scans/' + encodeURIComponent(id) + '/search', { params });
  },

  top(id, limit = 200) {
    return request('scans/' + encodeURIComponent(id) + '/top', { params: { limit } });
  },

  extensions(id) {
    return request('scans/' + encodeURIComponent(id) + '/extensions');
  },

  errors(id, params = {}) {
    return request('scans/' + encodeURIComponent(id) + '/errors', { params });
  },

  locate(id, node) {
    return request('scans/' + encodeURIComponent(id) + '/locate', { params: { node } });
  },

  /** 条目所在目录的 fnOS 文件管理器深链 */
  openNode(id, node) {
    return request('scans/' + encodeURIComponent(id) + '/open', { params: { node } });
  },

  /** 永久删除条目（后端返回后扫描结果即失效） */
  deleteNode(id, node) {
    return request('scans/' + encodeURIComponent(id) + '/nodes', { method: 'DELETE', params: { node }, timeout: 60000 });
  },

  exportUrl(id, format = 'csv', kind = 'all', sort = 'size') {
    return API_BASE + 'scans/' + encodeURIComponent(id) + '/export' + qs({ format, kind, sort });
  },

  exportJsonUrl(id) {
    return API_BASE + 'scans/' + encodeURIComponent(id) + '/export.json';
  },
};

export default api;
