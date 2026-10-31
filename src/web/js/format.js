/**
 * format.js — 数值 / 容量 / 时间 / 扩展名分类 与少量共享 DOM 工具
 * 无依赖，纯 ES module。
 */

const NUMBER_FMT = new Intl.NumberFormat('zh-CN');

/** 千分位整数 */
export function formatNumber(n) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '—';
  return NUMBER_FMT.format(Math.round(Number(n)));
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/** 1024 进制容量，1–2 位小数：3.8 TB / 412 GB / 12.4 MB */
export function formatBytes(n, forceDigits) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '—';
  let v = Number(n);
  if (v <= 0) return '0 B';
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  let digits;
  if (typeof forceDigits === 'number') digits = forceDigits;
  else if (v >= 100) digits = 0;
  else if (v >= 10) digits = 1;
  else digits = 2;
  let s = v.toFixed(digits);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s + ' ' + BYTE_UNITS[i];
}

/** 0.428 -> "42.8%" */
export function formatPercent(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return '—';
  const p = Number(ratio) * 100;
  if (!Number.isFinite(p)) return '—';
  const d = p >= 99.95 ? 0 : digits;
  return p.toFixed(d) + '%';
}

export function ratio(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0 || p <= 0) return 0;
  return Math.min(1, p / t);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Unix 毫秒 -> "2025-10-28 01:23" */
export function formatTime(ms, withSeconds = false) {
  if (!ms || !Number.isFinite(Number(ms))) return '—';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  const base = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

export function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 4 天前 / 2025-01-02 */
export function formatRelative(ms, now = Date.now()) {
  if (!ms || !Number.isFinite(Number(ms))) return '—';
  const diff = Math.max(0, now - Number(ms));
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatDate(ms);
}

/** 12.3 s / 1 分 23 秒 / 2 小时 5 分 */
export function formatDuration(ms) {
  if (!ms || !Number.isFinite(Number(ms)) || ms < 0) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3600000) {
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return s >= 60 ? `${m + 1} 分` : `${m} 分 ${s} 秒`;
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function extLabel(ext) {
  if (!ext) return '无扩展名';
  return '.' + ext;
}

/* ------------------------------------------------------------------ */
/* 扩展名分类与配色                                                     */
/* ------------------------------------------------------------------ */

export const EXT_GROUPS = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm2ts', 'webm', 'rmvb', 'm4v', 'mpg', 'mpeg'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'bmp', 'tiff', 'tif', 'svg'],
  audio: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'ape', 'dsd', 'dsf', 'wma', 'opus'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'zst', 'tgz', 'tbz', 'cab'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'epub', 'csv', 'rtf', 'odt'],
  code: ['js', 'mjs', 'ts', 'go', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'json', 'yml', 'yaml', 'sh', 'sql', 'rs', 'rb', 'php', 'html', 'css', 'xml', 'toml'],
};

export const GROUP_COLORS = {
  video: '#ec4899',
  image: '#10b981',
  audio: '#f59e0b',
  archive: '#8b5cf6',
  doc: '#3b82f6',
  code: '#06b6d4',
  dir: '#334e7d',
  other: '#64748b',
};

const EXT_TO_GROUP = (() => {
  const map = new Map();
  for (const [group, exts] of Object.entries(EXT_GROUPS)) {
    for (const e of exts) map.set(e, group);
  }
  return map;
})();

export function extGroup(ext) {
  if (!ext) return 'other';
  return EXT_TO_GROUP.get(String(ext).toLowerCase()) || 'other';
}

export function groupColor(group) {
  return GROUP_COLORS[group] || GROUP_COLORS.other;
}

/** 节点颜色：目录统一藏蓝，文件按扩展名分类 */
export function colorForExt(ext, type) {
  if (type === 'dir') return GROUP_COLORS.dir;
  if (type === 'link' || type === 'other') return GROUP_COLORS.other;
  return groupColor(extGroup(ext));
}

/** FNV-1a 字符串散列（用于同类色块轻微明度抖动） */
export function hashString(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 调整十六进制颜色明度，f=1 原色 */
export function shade(hex, f) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

/* ------------------------------------------------------------------ */
/* 共享轻量 DOM 工具（统一走 textContent，避免 XSS）                    */
/* ------------------------------------------------------------------ */

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 用 index.html 中的 SVG sprite（#i-<name>）创建图标。
 * 只接受固定图标名，不拼接用户数据。
 */
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

export function debounce(fn, ms) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 目录/文件类型 -> sprite 图标名 */
export function iconForType(node) {
  if (!node) return 'file';
  if (node.type === 'dir') return node.mount ? 'drive' : 'folder';
  if (node.type === 'link') return 'link';
  return 'file';
}

/** 扫描状态中文文案 */
export function statusText(status) {
  switch (status) {
    case 'running': return '扫描中';
    case 'done': return '已完成';
    case 'cancelled': return '已取消';
    case 'error': return '失败';
    default: return '未知';
  }
}
