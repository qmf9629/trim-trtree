/**
 * app.js — TrTree 应用入口：状态机、视图渲染、事件绑定、轮询、搜索/导出/目录选择
 *
 * 安全约束：所有来自后端的文件名 / 路径一律通过 textContent 或 createElement 写入，
 * 不拼接 innerHTML。
 */

import { api } from './api.js';
import { openFileManager as hostOpenFileManager, hostAvailable } from './host.js';
import { TreemapView } from './treemap.js';
import { VirtualTable } from './table.js';
import {
  el, clear, icon, formatBytes, formatNumber, formatPercent, formatTime,
  formatRelative, formatDuration, ratio, colorForKey, colorForExt,
  iconForType, statusText, debounce, clamp, extLabel,
} from './format.js';

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const dom = {
  app: $('app'),
  pathInput: $('path-input'),
  browseBtn: $('browse-btn'),
  scanBtn: $('scan-btn'),
  exportBtn: $('export-btn'),
  exportMenu: $('export-menu'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  homeBtn: $('home-btn'),
  brandHome: $('brand-home'),

  viewEmpty: $('view-empty'),
  volGrid: $('vol-grid'),
  volCount: $('vol-count'),
  recentList: $('recent-list'),

  viewScanning: $('view-scanning'),
  scanTarget: $('scan-target'),
  scanElapsed: $('scan-elapsed'),
  scanFilesBig: $('scan-files-big'),
  scanFiles: $('scan-files'),
  scanDirs: $('scan-dirs'),
  scanSize: $('scan-size'),
  scanTime: $('scan-time'),
  scanPath: $('scan-path'),
  scanHint: $('scan-hint'),
  cancelBtn: $('cancel-btn'),

  viewResult: $('view-result'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerClose: $('banner-close'),
  upBtn: $('up-btn'),
  crumbs: $('crumbs'),
  crumbSize: $('crumb-size'),
  sidebarToggle: $('sidebar-toggle'),
  tmTitle: $('tm-title'),
  tmMeta: $('tm-meta'),
  tmCount: $('tm-count'),
  treemap: $('treemap'),
  sidebar: $('sidebar'),
  nodeCard: $('node-card'),
  extSub: $('ext-sub'),
  extList: $('ext-list'),
  topChildren: $('top-children'),

  bottomPanel: $('bottom-panel'),
  panelResize: $('panel-resize'),
  tabs: $('tabs'),
  errorsBadge: $('errors-badge'),
  bottomCount: $('bottom-count'),
  collapseBtn: $('collapse-btn'),

  toolbarFiles: $('toolbar-files'),
  listQ: $('list-q'),
  listKind: $('list-kind'),
  listRefresh: $('list-refresh'),
  listSortNote: $('list-sort-note'),
  listCount: $('list-count'),
  toolbarTop: $('toolbar-top'),
  topRefresh: $('top-refresh'),
  topCount: $('top-count'),
  toolbarSearch: $('toolbar-search'),
  searchQ: $('search-q'),
  searchKind: $('search-kind'),
  searchMinSize: $('search-minsize'),
  searchCount: $('search-count'),
  toolbarErrors: $('toolbar-errors'),
  errorsRefresh: $('errors-refresh'),
  errorsCount: $('errors-count'),

  paneFiles: $('pane-files'),
  paneTop: $('pane-top'),
  paneSearch: $('pane-search'),
  paneErrors: $('pane-errors'),

  statusLeft: $('status-left'),
  statusRight: $('status-right'),

  confirm: $('confirm'),
  confirmPath: $('confirm-path'),
  confirmType: $('confirm-type'),
  confirmSize: $('confirm-size'),
  confirmAlloc: $('confirm-alloc'),
  confirmCount: $('confirm-count'),
  confirmStatus: $('confirm-status'),
  confirmCancel: $('confirm-cancel'),
  confirmDelete: $('confirm-delete'),

  viewError: $('view-error'),
  errorMessage: $('error-message'),
  errorBack: $('error-back'),
  errorRetry: $('error-retry'),

  picker: $('picker'),
  pickerCrumbs: $('picker-crumbs'),
  pickerPath: $('picker-path'),
  pickerGo: $('picker-go'),
  pickerRoots: $('picker-roots'),
  pickerList: $('picker-list'),
  pickerStatus: $('picker-status'),
  pickerCancel: $('picker-cancel'),
  pickerChoose: $('picker-choose'),

  toasts: $('toasts'),
};

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

function emptyGlobals() {
  return { ext: null, top: null, errors: null, extLoading: false, topLoading: false };
}

const state = {
  phase: 'empty', // empty | scanning | result | error
  demo: false,
  context: null,
  volumes: null,
  history: [],
  scanIndex: new Set(),
  scanIndexOk: false,
  roots: [],

  scanId: null,
  scan: null,
  loadSeq: 0,

  nodeId: 0,
  node: null,
  rootNode: null,
  ancestors: [],
  children: [],
  total: 0,
  truncated: false,
  selection: null,

  list: { q: '', kind: 'all', sort: 'size', dir: 'desc', total: 0, seq: 0 },
  tab: 'files',
  globals: emptyGlobals(),

  poll: { timer: 0, retries: 0 },
  panelHeight: 320,
  collapsed: false,

  search: { q: '', kind: 'all', min: 0, total: 0, truncated: false, seq: 0 },

  del: { open: false, node: null, busy: false },
  hostSupport: null,
  isAdmin: true,

  picker: {
    open: false, loading: false, error: null,
    current: '/', parent: null, dirs: [], roots: [], selected: null, seq: 0,
  },
};

let treemap = null;
const tables = { files: null, top: null, search: null, errors: null };

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function setText(node, text) {
  if (node) node.textContent = text === null || text === undefined ? '' : String(text);
}

function dotSep() {
  return el('span', 'sb-sep', '·');
}

function normalizePath(input) {
  if (!input) return '';
  let p = String(input).trim();
  if (!p) return '';
  if (!p.startsWith('/')) return p;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (!p) p = '/';
  return p;
}

function focusPathInput() {
  if (!dom.pathInput) return;
  dom.pathInput.focus();
  dom.pathInput.select();
}

function toast(message, type = 'info', timeout = 4000) {
  if (!dom.toasts) return;
  const t = el('div', 'toast ' + type);
  t.appendChild(icon(type === 'error' ? 'alert' : type === 'ok' ? 'check' : type === 'warn' ? 'alert' : 'info'));
  t.appendChild(el('span', '', message));
  dom.toasts.appendChild(t);
  while (dom.toasts.children.length > 4) dom.toasts.removeChild(dom.toasts.firstChild);
  window.setTimeout(() => removeToast(t), timeout);
}

function removeToast(t) {
  if (!t || !t.parentNode) return;
  t.classList.add('hide');
  window.setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
}

/** 带操作按钮的 toast（用于"结果已释放 → 重新分析"） */
function toastAction(message, actionLabel, handler, type = 'warn', timeout = 8000) {
  if (!dom.toasts) return;
  const t = el('div', 'toast action ' + type);
  t.appendChild(icon(type === 'error' || type === 'warn' ? 'alert' : 'info'));
  t.appendChild(el('span', 'toast-text', message));
  const btn = el('button', 'toast-action', actionLabel);
  btn.type = 'button';
  btn.addEventListener('click', () => {
    removeToast(t);
    try { handler(); } catch (_) { /* 忽略 */ }
  });
  t.appendChild(btn);
  dom.toasts.appendChild(t);
  while (dom.toasts.children.length > 4) dom.toasts.removeChild(dom.toasts.firstChild);
  window.setTimeout(() => removeToast(t), timeout);
}

async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      throw new Error('clipboard unavailable');
    }
    toast('路径已复制到剪贴板', 'ok', 2200);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('路径已复制到剪贴板', 'ok', 2200);
    } catch (err) {
      toast('复制失败，请手动选择路径文本', 'error', 3000);
    }
    document.body.removeChild(ta);
  }
}

function setStatus(mode, text) {
  if (!dom.statusPill) return;
  dom.statusPill.dataset.state = mode;
  setText(dom.statusText, text);
}

function setExportEnabled(enabled) {
  if (!dom.exportBtn) return;
  dom.exportBtn.disabled = !enabled;
}

function setScanButton(mode) {
  const btn = dom.scanBtn;
  if (!btn) return;
  clear(btn);
  if (mode === 'scanning') {
    btn.className = 'btn btn-danger';
    btn.appendChild(icon('stop'));
    btn.appendChild(el('span', 'scan-btn-text', '停止'));
    btn.title = '停止当前扫描';
  } else {
    btn.className = 'btn btn-primary';
    btn.appendChild(icon('play'));
    btn.appendChild(el('span', 'scan-btn-text', '扫描'));
    btn.title = '开始扫描（Enter）';
  }
}

function showView(name) {
  const map = {
    empty: dom.viewEmpty,
    scanning: dom.viewScanning,
    result: dom.viewResult,
    error: dom.viewError,
  };
  for (const [key, node] of Object.entries(map)) {
    if (node) node.hidden = key !== name;
  }
  if (dom.homeBtn) dom.homeBtn.disabled = name === 'empty';
}

/** 返回首页（概览页）；扫描进行中时任务继续，可稍后从"最近扫描"打开 */
function goHome() {
  const scanning = state.phase === 'scanning';
  showEmptyView();
  if (scanning) toast('扫描仍在后台进行，完成后可在"最近扫描"中打开结果', 'info', 5000);
}

function setInputsEnabled(enabled) {
  if (dom.pathInput) dom.pathInput.disabled = !enabled;
  if (dom.browseBtn) dom.browseBtn.disabled = !enabled;
}

function showBanner(text, type = 'warn') {
  if (!dom.banner) return;
  dom.banner.hidden = false;
  dom.banner.className = 'banner' + (type === 'error' ? ' error' : '');
  setText(dom.bannerText, text);
}

function hideBanner() {
  if (dom.banner) dom.banner.hidden = true;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init() {
  bindEvents();
  setScanButton('idle');

  try {
    const [ctx, vols, scanList] = await Promise.all([
      api.context(),
      api.volumes(),
      api.listScans().catch(() => null),
    ]);
    state.context = ctx || null;
    // 桌面壳的 openFileManager(path,{isAdmin}) 需要知道是否管理员
    state.isAdmin = !(ctx && ctx.isAdmin === false);
    state.volumes = vols || { volumes: [], roots: [], history: [] };
    state.history = Array.isArray(state.volumes.history) ? state.volumes.history : [];
    state.roots = Array.isArray(state.volumes.roots) ? state.volumes.roots : [];
    applyScanIndex(scanList);
    if (dom.pathInput && !dom.pathInput.value) {
      dom.pathInput.value = (state.roots[0] && state.roots[0].path) || '/vol1';
    }
    renderEmpty();
    if (ctx && ctx.isAdmin === false) {
      toast('当前账号不是管理员，部分目录可能无法读取', 'warn', 5200);
    }
  } catch (err) {
    state.volumes = { volumes: [], roots: [], history: [] };
    renderEmpty();
    setStatus('error', '服务不可用');
    toast('无法连接后端服务：' + err.message, 'error', 6500);
  }

  const params = new URLSearchParams(location.search);

  // 静态预览：仅用于截图 / 演示扫描中的界面
  if (params.get('view') === 'scanning') {
    startDemoScanning();
    return;
  }

  const scanId = params.get('scan');
  if (scanId) {
    await restoreScan(scanId, Number(params.get('node') || 0));
  }

  if (params.has('picker')) {
    const raw = params.get('picker');
    let p = (state.node && state.node.path) || dom.pathInput.value || '/';
    if (raw && raw !== '1') {
      try { p = decodeURIComponent(raw); } catch (_) { p = raw; }
    }
    window.setTimeout(() => openPicker(p), 40);
  }
}

async function restoreScan(scanId, nodeId) {
  let indexList = null;
  try { indexList = await api.listScans(); } catch (_) { indexList = null; }
  if (indexList) {
    applyScanIndex(indexList);
    const known = Array.isArray(indexList.scans) && indexList.scans.some((s) => s && s.id === scanId);
    if (!known) {
      const h = (state.history || []).find((x) => x && x.id === scanId);
      const p = h ? h.path : '';
      showEmptyView();
      if (p) toastAction(`扫描结果已释放：${p}`, '重新分析', () => startScan(p), 'warn', 9000);
      else toast('该扫描结果已释放，请重新扫描目录', 'warn', 5000);
      return;
    }
  }
  try {
    const scan = await api.getScan(scanId);
    state.demo = false;
    state.scanId = scan.id || scanId;
    state.scan = scan;
    state.globals = emptyGlobals();
    resetSearchState();
    if (scan.status === 'running') {
      enterScanning();
      startPolling();
      return;
    }
    if (scan.status === 'error') {
      showError(scan.error || '扫描任务失败');
      return;
    }
    enterResult();
    await loadTree(nodeId || 0, { push: false });
    if (scan.status === 'cancelled') {
      showBanner('扫描已取消，结果可能不完整', 'warn');
    }
  } catch (err) {
    toast('无法打开扫描结果：' + err.message, 'error', 6000);
    showEmptyView();
  }
}

/* ------------------------------------------------------------------ */
/* 空状态                                                              */
/* ------------------------------------------------------------------ */

function renderEmpty() {
  state.phase = 'empty';
  showView('empty');
  setStatus('idle', '就绪');
  setScanButton('idle');
  setExportEnabled(false);
  setInputsEnabled(true);
  hideBanner();

  const vols = (state.volumes && state.volumes.volumes) || [];
  const history = (state.volumes && state.volumes.history) || state.history || [];

  setText(dom.volCount, vols.length ? `${vols.length} 个可分析存储` : '');
  clear(dom.volGrid);

  if (!vols.length) {
    const empty = el('div', 'vol-card');
    const top = el('div', 'vol-top');
    const iconBox = el('span', 'vol-icon');
    iconBox.appendChild(icon('drive'));
    top.appendChild(iconBox);
    const titles = el('div', 'vol-titles');
    titles.appendChild(el('div', 'vol-label', '未发现可分析的存储空间'));
    titles.appendChild(el('div', 'vol-mount', '请检查后端权限，或手动输入路径分析'));
    top.appendChild(titles);
    empty.appendChild(top);
    const row = el('div', 'vol-foot');
    const browse = el('button', 'btn btn-ghost btn-sm', '浏览目录');
    browse.type = 'button';
    browse.addEventListener('click', () => openPicker('/'));
    row.appendChild(el('span', '', '仅显示真实块设备 / 网络文件系统'));
    row.appendChild(browse);
    empty.appendChild(row);
    dom.volGrid.appendChild(empty);
  } else {
    const sorted = vols.slice().sort((a, b) => (a.system ? 1 : 0) - (b.system ? 1 : 0));
    for (const v of sorted) dom.volGrid.appendChild(renderVolumeCard(v));
  }

  clear(dom.recentList);
  const groups = groupHistory(history);
  if (!groups.length) {
    dom.recentList.appendChild(el('div', 'recent-empty', '暂无扫描记录，选择上方存储空间开始分析'));
  } else {
    groups.slice(0, 5).forEach((g, i) => {
      dom.recentList.appendChild(renderRecentRow(g, i));
    });
  }
}

function renderVolumeCard(v) {
  const card = el('article', 'vol-card' + (v.system ? ' system' : ''));
  const total = Number(v.total) || 0;
  const used = Number(v.used) || 0;
  const free = Number.isFinite(Number(v.free)) ? Number(v.free) : Math.max(0, total - used);
  const pct = ratio(used, total);
  const level = pct >= 0.85 ? 'danger' : pct >= 0.7 ? 'warn' : '';

  const top = el('div', 'vol-top');
  const iconBox = el('span', 'vol-icon');
  iconBox.appendChild(icon(v.system ? 'server' : 'drive'));
  top.appendChild(iconBox);

  const titles = el('div', 'vol-titles');
  const label = el('div', 'vol-label');
  label.appendChild(el('span', '', v.label || '存储空间'));
  label.appendChild(el('span', 'chip', v.fs || 'unknown'));
  if (v.system) label.appendChild(el('span', 'chip', '系统盘'));
  if (v.accessible === false) label.appendChild(el('span', 'chip danger', '不可访问'));
  titles.appendChild(label);
  titles.appendChild(el('div', 'vol-mount', v.path || v.id || '—'));
  top.appendChild(titles);

  const analyze = el('button', 'btn btn-primary btn-sm', '分析');
  analyze.type = 'button';
  analyze.disabled = v.accessible === false;
  if (v.accessible === false) analyze.title = '当前无法访问该路径';
  analyze.addEventListener('click', () => startScan(v.path || v.id));
  top.appendChild(analyze);
  card.appendChild(top);

  const usage = el('div', 'vol-usage');
  usage.appendChild(el('strong', '', formatBytes(used)));
  usage.appendChild(el('span', '', '/ ' + formatBytes(total)));
  usage.appendChild(el('span', 'vol-pct ' + level, formatPercent(pct)));
  card.appendChild(usage);

  const bar = el('div', 'vol-bar');
  const fill = el('i', level);
  fill.style.width = Math.max(0, Math.min(100, pct * 100)).toFixed(2) + '%';
  bar.appendChild(fill);
  card.appendChild(bar);

  const foot = el('div', 'vol-foot');
  foot.appendChild(el('span', '', `${v.fs || '未知文件系统'} · 可用 ${formatBytes(free)}`));
  const right = el('span', 'right');
  right.appendChild(el('span', v.accessible === false ? 'bad' : 'ok', v.accessible === false ? '无权限' : '读取正常'));
  foot.appendChild(right);
  card.appendChild(foot);

  return card;
}

function renderRecentRow(group, index) {
  const members = group.items || [group.latest];
  const latest = group.latest;
  // 优先展示/打开仍在内存中的最新一次；都被释放时标记为 stale
  const available = state.scanIndexOk
    ? members.filter((x) => state.scanIndex.has(x.id)).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0]
    : null;
  const h = available || latest;
  const stale = state.scanIndexOk && !available;
  const openable = !stale && (h.status === 'done' || h.status === 'cancelled');

  const row = el('div', 'recent-row' + (stale ? ' stale' : ''));
  const iconBox = el('span', 'recent-icon');
  iconBox.appendChild(icon(stale ? 'archive' : 'clock'));
  row.appendChild(iconBox);

  const main = el('div', 'recent-main');
  const p = el('div', 'recent-path', h.path || '—');
  p.title = h.path || '';
  main.appendChild(p);
  const meta = el('div', 'recent-meta');
  const bits = [];
  bits.push(formatBytes(h.size));
  bits.push(`${formatNumber(h.files)} 文件`);
  bits.push(formatRelative(h.finishedAt || h.startedAt || Date.now()));
  if (h.durationMs) bits.push(`用时 ${formatDuration(h.durationMs)}`);
  if (group.count > 1) bits.push(`共 ${group.count} 次`);
  meta.textContent = bits.join(' · ');
  main.appendChild(meta);
  row.appendChild(main);

  const badge = el('span', 'recent-status ' + (h.status || ''), statusText(h.status));
  row.appendChild(badge);
  if (stale) {
    const chip = el('span', 'recent-status stale', '结果已释放');
    chip.title = '该次扫描结果已不在内存中，可重新分析';
    row.appendChild(chip);
  }

  const actions = el('div', 'recent-actions');
  if (openable) {
    const view = el('button', 'btn btn-ghost btn-sm', '查看');
    view.type = 'button';
    view.addEventListener('click', (e) => {
      e.stopPropagation();
      openHistoryScan(h.id, h.path);
    });
    actions.appendChild(view);
  }
  const again = el('button', 'btn btn-ghost btn-sm', '重新分析');
  again.type = 'button';
  again.title = '重新扫描该路径';
  again.addEventListener('click', (e) => {
    e.stopPropagation();
    startScan(h.path);
  });
  actions.appendChild(again);
  row.appendChild(actions);

  if (stale) {
    row.title = '结果已释放，点击可重新分析该路径';
    row.addEventListener('click', () => showStaleScan(h.path));
  } else if (openable) {
    row.title = '点击查看该次扫描结果';
    row.addEventListener('click', () => openHistoryScan(h.id, h.path));
  }
  return row;
}

/** 按路径合并历史记录，仅保留最新一条并统计出现次数 */
function groupHistory(history) {
  const map = new Map();
  for (const h of history || []) {
    if (!h || !h.path) continue;
    const g = map.get(h.path);
    if (!g) {
      map.set(h.path, { latest: h, count: 1, items: [h] });
    } else {
      g.count += 1;
      g.items.push(h);
      if ((h.startedAt || 0) > (g.latest.startedAt || 0)) g.latest = h;
    }
  }
  return [...map.values()].sort((a, b) => (b.latest.startedAt || 0) - (a.latest.startedAt || 0));
}

/** 更新"内存中仍可打开"的扫描 id 集合，避免对已释放的扫描发请求 */
function applyScanIndex(list) {
  if (!list || !Array.isArray(list.scans)) {
    state.scanIndexOk = false;
    state.scanIndex = new Set();
    return;
  }
  state.scanIndexOk = true;
  state.scanIndex = new Set(list.scans.map((s) => s && s.id).filter(Boolean));
}

async function refreshScanIndex() {
  try {
    const list = await api.listScans();
    applyScanIndex(list);
  } catch (_) { /* 保留旧索引 */ }
}

function showStaleScan(path) {
  const p = normalizePath(path);
  if (!p) {
    toast('该扫描结果已释放，请重新选择目录扫描', 'warn', 5000);
    return;
  }
  toastAction(`扫描结果已释放：${p}`, '重新分析', () => startScan(p), 'warn', 9000);
}

async function openHistoryScan(id, fallbackPath) {
  if (!id) return;
  let summary = null;
  let listOk = false;

  // 先向 /scans 校验该结果是否仍在内存中，避免直接打 404 造成控制台报错
  try {
    const list = await api.listScans();
    listOk = true;
    applyScanIndex(list);
    if (Array.isArray(list.scans)) {
      summary = list.scans.find((s) => s && s.id === id) || null;
    }
  } catch (_) { /* 列表不可用时退回历史记录中的摘要 */ }

  if (!summary && !listOk) {
    const h = (state.history || []).find((x) => x && x.id === id);
    if (h) summary = h;
  }
  if (!summary) {
    showStaleScan(fallbackPath || ((state.history || []).find((x) => x && x.id === id) || {}).path);
    return;
  }

  state.demo = false;
  state.scanId = summary.id || id;
  state.scan = summary;
  state.globals = emptyGlobals();
  resetSearchState();
  if (summary.status === 'running') {
    enterScanning();
    startPolling();
    updateUrl(null, { push: true });
  } else if (summary.status === 'error') {
    showError(summary.error || '扫描失败');
  } else {
    enterResult();
    await loadTree(0, { push: false });
    if (summary.status === 'cancelled') showBanner('扫描已取消，结果可能不完整', 'warn');
    updateUrl(0, { push: true });
  }
}
/* ------------------------------------------------------------------ */
/* 扫描流程                                                            */
/* ------------------------------------------------------------------ */

async function startScan(rawPath) {
  if (state.phase === 'scanning') return;
  const path = normalizePath(rawPath);
  if (!path) {
    toast('请输入要分析的目录路径', 'warn');
    focusPathInput();
    return;
  }
  if (!path.startsWith('/')) {
    toast('请输入绝对路径（以 / 开头）', 'warn');
    focusPathInput();
    return;
  }

  setStatus('scanning', '准备扫描');
  try {
    const res = await api.createScan(path, true);
    state.demo = false;
    state.scanId = res.id;
    state.scan = {
      id: res.id, path, status: 'running',
      startedAt: Date.now(), files: 0, dirs: 0, size: 0, alloc: 0, errors: 0,
    };
    state.globals = emptyGlobals();
    resetSearchState();
    state.selection = null;
    enterScanning();
    updateUrl(null, { push: true });
    startPolling();
  } catch (err) {
    if (err.status === 409) {
      await adoptActiveScan(path);
      return;
    }
    setStatus('error', '扫描启动失败');
    toast('无法开始扫描：' + err.message, 'error', 6000);
  }
}

async function adoptActiveScan(path) {
  try {
    const list = await api.listScans();
    if (list && list.active) {
      let scan = null;
      try { scan = await api.getScan(list.active); } catch (_) { scan = null; }
      state.demo = false;
      state.scanId = list.active;
      state.scan = scan || { id: list.active, path: path || '—', status: 'running', startedAt: Date.now() };
      state.globals = emptyGlobals();
      resetSearchState();
      enterScanning();
      updateUrl(null, { push: true });
      startPolling();
      toast('已有扫描任务正在运行，已接管其进度', 'warn', 4200);
      return;
    }
    toast('已有扫描任务正在运行', 'warn');
  } catch (_) {
    toast('已有扫描任务正在运行', 'warn');
  }
}

function enterScanning() {
  state.phase = 'scanning';
  showView('scanning');
  setScanButton('scanning');
  setStatus('scanning', '扫描中');
  setExportEnabled(false);
  setInputsEnabled(false);
  hideBanner();
  setText(dom.scanTarget, (state.scan && state.scan.path) || '—');
  setText(dom.scanFilesBig, '0');
  setText(dom.scanFiles, '0');
  setText(dom.scanDirs, '0');
  setText(dom.scanSize, '0 B');
  setText(dom.scanTime, '0.0 s');
  setText(dom.scanElapsed, '—');
  setText(dom.scanPath, '—');
  if (dom.scanHint) dom.scanHint.hidden = true;
  if (dom.cancelBtn) dom.cancelBtn.disabled = false;
}

function renderScanning(p) {
  const files = Number(p.files) || 0;
  const dirs = Number(p.dirs) || 0;
  const elapsed = Number(p.elapsedMs) || 0;
  setText(dom.scanFilesBig, formatNumber(files));
  setText(dom.scanFiles, formatNumber(files));
  setText(dom.scanDirs, formatNumber(dirs));
  setText(dom.scanSize, formatBytes(p.size || 0));
  setText(dom.scanTime, formatDuration(elapsed));
  setText(dom.scanElapsed, '已用时 ' + formatDuration(elapsed));
  const currentPath = p.currentPath || (state.scan && state.scan.path) || '—';
  setText(dom.scanPath, currentPath);
  if (dom.scanPath) dom.scanPath.title = currentPath;
  if (dom.scanHint) dom.scanHint.hidden = !(elapsed > 3000);
}

function startPolling() {
  stopPolling();
  state.poll.retries = 0;
  const tick = async () => {
    if (state.phase !== 'scanning' || !state.scanId) return;
    try {
      const p = await api.progress(state.scanId);
      if (state.phase !== 'scanning') return;
      state.poll.retries = 0;
      renderScanning(p);
      if (p.status === 'running') {
        state.poll.timer = window.setTimeout(tick, 400);
      } else {
        await finishScan(p);
      }
    } catch (err) {
      if (state.phase !== 'scanning') return;
      state.poll.retries += 1;
      if (state.poll.retries > 3) {
        stopPolling();
        setStatus('error', '进度获取失败');
        toast('扫描进度获取失败（已重试 3 次）：' + err.message, 'error', 5200);
        try {
          const scan = await api.getScan(state.scanId);
          if (scan && scan.status !== 'running') await finishScan(scan);
        } catch (_) { /* 保持当前视图 */ }
      } else {
        state.poll.timer = window.setTimeout(tick, 900);
      }
    }
  };
  state.poll.timer = window.setTimeout(tick, 120);
}

function stopPolling() {
  if (state.poll.timer) {
    window.clearTimeout(state.poll.timer);
    state.poll.timer = 0;
  }
}

async function cancelScan() {
  if (!state.scanId) return;
  if (dom.cancelBtn) dom.cancelBtn.disabled = true;
  try {
    await api.cancelScan(state.scanId);
    toast('正在取消扫描，已扫描的数据仍可查看', 'warn', 3600);
  } catch (err) {
    toast('取消扫描失败：' + err.message, 'error');
  } finally {
    window.setTimeout(() => {
      if (dom.cancelBtn) dom.cancelBtn.disabled = false;
    }, 1500);
  }
}

async function finishScan(progress) {
  stopPolling();
  try {
    const scan = await api.getScan(state.scanId);
    state.scan = scan;
    refreshScanIndex();
    if (scan.status === 'error') {
      setStatus('error', '扫描失败');
      showError(scan.error || '扫描任务失败');
      return;
    }
    refreshVolumes();
    enterResult();
    await loadTree(0, { push: false });
    if (scan.status === 'cancelled') {
      showBanner('扫描已取消，结果可能不完整', 'warn');
      toast('扫描已取消，可查看已扫描部分', 'warn', 4200);
    } else {
      toast(`扫描完成，用时 ${formatDuration(scan.durationMs)}`, 'ok', 3600);
    }
    setStatus('idle', '就绪');
    updateUrl(0, { push: false });
  } catch (err) {
    setStatus('error', '无法获取结果');
    showError('扫描完成，但获取结果失败：' + err.message);
  }
}

async function refreshVolumes() {
  try {
    const vols = await api.volumes();
    state.volumes = vols;
    state.history = Array.isArray(vols.history) ? vols.history : [];
    state.roots = Array.isArray(vols.roots) ? vols.roots : [];
    if (state.phase === 'empty') renderEmpty();
  } catch (_) { /* 忽略刷新失败 */ }
}

/* ------------------------------------------------------------------ */
/* 结果视图                                                            */
/* ------------------------------------------------------------------ */

function enterResult() {
  state.phase = 'result';
  showView('result');
  setScanButton('idle');
  setStatus('idle', '就绪');
  setInputsEnabled(true);
  ensureTables();
  setExportEnabled(true);
  if (dom.pathInput) dom.pathInput.value = (state.scan && state.scan.path) || dom.pathInput.value;
  renderStatusbar();
  renderErrorsBadge();
  if (state.scan && state.scan.status === 'cancelled') {
    showBanner('扫描已取消，结果可能不完整', 'warn');
  } else {
    hideBanner();
  }
  if (dom.viewResult) dom.viewResult.classList.remove('sidebar-open');
}

async function loadTree(nodeId, opts = {}) {
  if (!state.scanId) return;
  const id = nodeId || 0;
  const seq = ++state.loadSeq;
  try {
    const data = await api.tree(state.scanId, { node: id, depth: 1, limit: 5000 });
    if (seq !== state.loadSeq) return;
    const node = data.node || null;
    if (!node) {
      toast('目录不存在', 'error');
      return;
    }
    state.node = node;
    state.nodeId = node.id;
    state.ancestors = Array.isArray(data.ancestors) ? data.ancestors : [];
    state.children = Array.isArray(data.children) ? data.children : [];
    state.total = typeof data.total === 'number' ? data.total : state.children.length;
    state.truncated = !!data.truncated;
    state.rootNode = state.ancestors.length ? state.ancestors[0] : node;
    state.selection = null;

    if (treemap) {
      treemap.setData({
        node,
        children: state.children,
        total: state.total,
        truncated: state.truncated,
      });
      treemap.setSelected(null);
    }

    resetListFilters();
    renderCrumbs();
    renderNodeCard();
    renderExtensions();
    renderTopChildren();
    renderTreemapOverlay();
    renderStatusbar();
    renderErrorsBadge();
    updateUrl(node.id, { push: !!opts.push });
    loadList();
  } catch (err) {
    if (seq !== state.loadSeq) return;
    if (id !== 0) {
      toast('无法打开该目录，已返回根目录', 'warn');
      await loadTree(0, { push: false });
      return;
    }
    toast('加载目录失败：' + err.message, 'error', 5200);
  }
}

function renderCrumbs() {
  const node = state.node;
  const wrap = dom.crumbs;
  if (!wrap) return;
  clear(wrap);
  if (!node) return;

  const parts = state.ancestors.concat([node]);
  parts.forEach((n, i) => {
    if (i > 0) {
      const sep = el('span', 'crumb-sep');
      sep.appendChild(icon('chevron-right'));
      wrap.appendChild(sep);
    }
    const isCurrent = i === parts.length - 1;
    const label = n.path === '/' ? '/' : (n.name || n.path || '—');
    const btn = el('button', 'crumb' + (isCurrent ? ' current' : ''), label);
    btn.type = 'button';
    btn.title = n.path || '';
    if (!isCurrent) {
      btn.addEventListener('click', () => loadTree(n.id, { push: true }));
    }
    wrap.appendChild(btn);
  });

  if (dom.upBtn) dom.upBtn.disabled = state.ancestors.length === 0;

  const rootSize = (state.rootNode && state.rootNode.size) || (state.scan && state.scan.size) || node.size;
  if (dom.crumbSize) {
    dom.crumbSize.textContent = `${formatBytes(node.size)} · 占扫描根 ${formatPercent(ratio(node.size, rootSize))}`;
  }
}

function renderNodeCard() {
  const card = dom.nodeCard;
  if (!card) return;
  clear(card);

  const current = state.node;
  if (!current) {
    card.appendChild(el('div', 'ext-empty', '未选择目录'));
    return;
  }
  const selected = state.selection && state.selection.id !== current.id ? state.selection : null;
  const n = selected || current;
  const isSel = !!selected;
  const rootSize = (state.rootNode && state.rootNode.size) || (state.scan && state.scan.size) || current.size || 0;

  const kicker = el('div', 'node-kicker');
  kicker.appendChild(el('span', '', isSel ? '选中的条目' : '当前目录'));
  kicker.appendChild(el('span', 'chip', nodeTypeLabel(n)));
  card.appendChild(kicker);

  const title = el('div', 'node-title');
  const ic = icon(iconForType(n));
  ic.style.color = n.type === 'dir' ? '#7db2ff' : 'var(--text-2)';
  title.appendChild(ic);
  const nameEl = el('span', 'node-name', n.name || n.path || '—');
  nameEl.title = n.path || '';
  title.appendChild(nameEl);
  card.appendChild(title);

  const pathRow = el('div', 'node-path');
  const pathCode = el('code', '', n.path || '—');
  pathCode.title = n.path || '';
  pathRow.appendChild(pathCode);
  const copyBtn = el('button', 'icon-btn');
  copyBtn.type = 'button';
  copyBtn.title = '复制完整路径';
  copyBtn.appendChild(icon('copy'));
  copyBtn.addEventListener('click', () => copyText(n.path));
  pathRow.appendChild(copyBtn);
  card.appendChild(pathRow);

  const stats = el('div', 'node-stats');
  const stat = (k, v, title) => {
    const box = el('div', 'ns');
    box.appendChild(el('span', 'ns-k', k));
    const val = el('span', 'ns-v', v);
    if (title) val.title = title;
    box.appendChild(val);
    return box;
  };
  stats.appendChild(stat('大小', formatBytes(n.size)));
  stats.appendChild(stat('磁盘占用', formatBytes(n.alloc)));
  stats.appendChild(stat('条目数', formatNumber(n.count)));
  stats.appendChild(stat('修改时间', formatTime(n.mtime), formatTime(n.mtime, true)));
  card.appendChild(stats);

  const r = ratio(n.size, rootSize);
  const bar = el('div', 'ratio');
  const fill = el('i');
  fill.style.width = (r * 100).toFixed(2) + '%';
  bar.appendChild(fill);
  card.appendChild(bar);
  const rl = el('div', 'ratio-label');
  rl.appendChild(el('span', '', `占扫描根 ${formatPercent(r)}`));
  rl.appendChild(el('span', '', `${formatBytes(n.size)} / ${formatBytes(rootSize)}`));
  card.appendChild(rl);

  const actions = el('div', 'node-actions');
  if (n.type === 'dir') {
    const enter = el('button', 'btn btn-primary btn-sm', isSel ? '进入目录' : '进入此目录');
    enter.type = 'button';
    enter.disabled = !isSel;
    if (!isSel) enter.title = '当前已在该目录中';
    enter.addEventListener('click', () => loadTree(n.id, { push: true }));
    actions.appendChild(enter);
  } else {
    const parentBtn = el('button', 'btn btn-primary btn-sm', '所在目录');
    parentBtn.type = 'button';
    parentBtn.addEventListener('click', () => locateAndSelect(n.id));
    actions.appendChild(parentBtn);
  }
  const inList = el('button', 'btn btn-ghost btn-sm', '在列表中查看');
  inList.type = 'button';
  inList.addEventListener('click', () => showInList(n));
  actions.appendChild(inList);
  card.appendChild(actions);

  // 第二行：打开所在位置 / 删除
  const row2 = el('div', 'node-actions');
  const openBtn = el('button', 'btn btn-ghost btn-sm');
  openBtn.type = 'button';
  openBtn.appendChild(icon('external'));
  openBtn.appendChild(el('span', '', n.type === 'dir' ? '在文件管理中打开' : '打开所在文件夹'));
  openBtn.title = '在 fnOS 文件管理器中打开所在目录';
  openBtn.addEventListener('click', () => openInFileManager(n));
  row2.appendChild(openBtn);

  const delBtn = el('button', 'btn btn-danger-ghost btn-sm');
  delBtn.type = 'button';
  delBtn.appendChild(icon('trash'));
  delBtn.appendChild(el('span', '', '删除'));
  delBtn.title = '从磁盘永久删除（需二次确认）';
  delBtn.addEventListener('click', () => askDelete(n));
  row2.appendChild(delBtn);
  card.appendChild(row2);

  if (isSel) {
    const cancel = el('button', 'btn btn-ghost btn-sm', '取消');
    cancel.type = 'button';
    cancel.title = '取消选中';
    cancel.addEventListener('click', () => selectNode(null));
    actions.appendChild(cancel);
  }
}

function nodeTypeLabel(n) {
  if (!n) return '—';
  if (n.type === 'dir') return n.mount ? '挂载点' : '目录';
  if (n.type === 'link') return '链接';
  if (n.type === 'other') return '其他';
  return n.ext ? `.${n.ext}` : '文件';
}

function selectNode(node) {
  const target = node && state.node && node.id === state.node.id ? null : (node || null);
  state.selection = target;
  if (treemap) treemap.setSelected(target ? target.id : null);
  if (tables.files) tables.files.setSelected(target ? target.id : null);
  renderNodeCard();
  renderTopChildren();
}

function renderExtensions() {
  const wrap = dom.extList;
  if (!wrap) return;
  const items = state.globals.ext;

  if (items === null) {
    clear(wrap);
    wrap.appendChild(el('div', 'ext-empty', state.globals.extLoading ? '正在统计扩展名…' : '加载中…'));
    if (!state.globals.extLoading) {
      state.globals.extLoading = true;
      api.extensions(state.scanId)
        .then((res) => {
          state.globals.ext = Array.isArray(res.items) ? res.items : [];
          state.globals.extLoading = false;
          if (state.phase === 'result') renderExtensions();
        })
        .catch((err) => {
          state.globals.ext = [];
          state.globals.extLoading = false;
          if (state.phase === 'result') renderExtensions();
          toast('扩展名统计加载失败：' + err.message, 'error');
        });
    }
    return;
  }

  clear(wrap);
  setText(dom.extSub, '扫描范围');
  if (!items.length) {
    wrap.appendChild(el('div', 'ext-empty', '扫描范围内没有文件'));
    return;
  }

  const total = items.reduce((s, it) => s + (Number(it.size) || 0), 0);
  const top = items.slice(0, 8);
  const rest = items.slice(8);
  const rows = top.slice();
  if (rest.length) {
    rows.push({
      ext: '__other__',
      size: rest.reduce((s, it) => s + (Number(it.size) || 0), 0),
      count: rest.reduce((s, it) => s + (Number(it.count) || 0), 0),
      other: rest.length,
    });
  }

  for (const it of rows) {
    const isOther = it.ext === '__other__';
    const ext = it.ext || '';
    const color = isOther ? '#475569' : colorForExt(ext, 'file');
    const pct = ratio(it.size, total);
    const row = el('button', 'ext-row');
    row.type = 'button';
    row.title = isOther ? `其余 ${it.other} 种扩展名` : `${extLabel(ext)} · ${formatNumber(it.count)} 个文件`;
    const dot = el('span', 'ext-dot');
    dot.style.background = color;
    row.appendChild(dot);

    const main = el('span', 'ext-main');
    const topLine = el('span', 'ext-top');
    topLine.appendChild(el('span', 'ext-name', isOther ? `其他 ${it.other} 项` : extLabel(ext)));
    topLine.appendChild(el('span', 'ext-pct', formatPercent(pct)));
    main.appendChild(topLine);
    const bar = el('span', 'ext-bar');
    const fill = el('i');
    fill.style.width = Math.max(2, pct * 100).toFixed(1) + '%';
    fill.style.background = color;
    bar.appendChild(fill);
    main.appendChild(bar);
    row.appendChild(main);
    row.appendChild(el('span', 'ext-size', formatBytes(it.size)));

    row.addEventListener('click', () => {
      if (isOther) {
        toast('请选择具体的扩展名进行搜索', 'warn', 2600);
        return;
      }
      searchByExt(ext);
    });
    wrap.appendChild(row);
  }
}

function renderTopChildren() {
  const wrap = dom.topChildren;
  if (!wrap) return;
  clear(wrap);
  const children = state.children.filter((n) => Number(n.size) > 0).slice(0, 5);
  if (!children.length) {
    wrap.appendChild(el('div', 'ext-empty', '此目录没有可显示的子项'));
    return;
  }
  const max = Number(children[0].size) || 1;
  children.forEach((n, i) => {
    const row = el('button', 'top-child' + (state.selection && state.selection.id === n.id ? ' sel' : ''));
    row.type = 'button';
    row.title = n.path || '';
    row.appendChild(el('span', 'rank', String(i + 1)));
    const main = el('span', 'tc-main');
    main.appendChild(el('span', 'tc-name', n.name || n.path || '—'));
    const bar = el('span', 'tc-bar');
    const fill = el('i');
    fill.style.width = Math.max(2, (Number(n.size) / max) * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    main.appendChild(bar);
    row.appendChild(main);
    row.appendChild(el('span', 'tc-size', formatBytes(n.size)));
    row.addEventListener('click', () => selectNode(n));
    wrap.appendChild(row);
  });
}

function renderTreemapOverlay() {
  const node = state.node;
  if (!node) return;
  setText(dom.tmTitle, node.name || node.path || '—');
  const childCount = Number.isFinite(Number(node.childCount)) ? Number(node.childCount) : state.children.length;
  setText(dom.tmMeta, `${formatNumber(childCount)} 个子项 · 按大小排序`);
  const shown = treemap ? treemap.getShownCount() : Math.min(state.children.length, 4000);
  const total = state.total || state.children.length;
  if (state.children.length > shown || state.truncated || total > shown) {
    setText(dom.tmCount, `前 ${formatNumber(shown)} 项 / 共 ${formatNumber(total)} 项`);
  } else {
    setText(dom.tmCount, `${formatNumber(total)} 项`);
  }
}

function renderStatusbar() {
  const scan = state.scan;
  if (!scan) return;
  clear(dom.statusLeft);
  clear(dom.statusRight);

  const root = el('span', 'sb-root', scan.path || '—');
  root.title = scan.path || '';
  dom.statusLeft.appendChild(root);
  dom.statusLeft.appendChild(dotSep());
  dom.statusLeft.appendChild(el('span', 'sb-item', `${formatNumber(scan.files)} 文件`));
  dom.statusLeft.appendChild(dotSep());
  dom.statusLeft.appendChild(el('span', 'sb-item', `${formatNumber(scan.dirs)} 目录`));
  dom.statusLeft.appendChild(dotSep());
  dom.statusLeft.appendChild(el('span', 'sb-item', formatBytes(scan.size)));
  dom.statusLeft.appendChild(dotSep());
  dom.statusLeft.appendChild(el('span', 'sb-item', `用时 ${formatDuration(scan.durationMs)}`));
  if (scan.status === 'cancelled') {
    dom.statusLeft.appendChild(dotSep());
    dom.statusLeft.appendChild(el('span', 'sb-item sb-warn-text', '已取消'));
  }

  const errors = Number(scan.errors) || 0;
  if (errors > 0) {
    const errBtn = el('button', 'sb-warn', `${formatNumber(errors)} 个目录无法读取`);
    errBtn.type = 'button';
    errBtn.addEventListener('click', () => switchTab('errors'));
    dom.statusRight.appendChild(errBtn);
  }
  const rescan = el('button', 'sb-link', '重新扫描');
  rescan.type = 'button';
  rescan.addEventListener('click', () => startScan(scan.path));
  dom.statusRight.appendChild(rescan);
}

function renderErrorsBadge() {
  const errors = state.scan ? Number(state.scan.errors) || 0 : 0;
  if (!dom.errorsBadge) return;
  if (errors > 0) {
    dom.errorsBadge.hidden = false;
    setText(dom.errorsBadge, errors > 999 ? '999+' : String(errors));
  } else {
    dom.errorsBadge.hidden = true;
    setText(dom.errorsBadge, '0');
  }
}

/* ------------------------------------------------------------------ */
/* 底部面板                                                            */
/* ------------------------------------------------------------------ */

function ensureTables() {
  if (tables.files) return;

  tables.files = new VirtualTable(dom.paneFiles, {
    columns: filesColumns(),
    sort: state.list.sort,
    dir: state.list.dir,
    emptyText: '此目录没有子项',
    onSort: (key, dir) => {
      state.list.sort = key;
      state.list.dir = dir;
      updateListSortNote();
      loadList();
    },
    onRowClick: (node) => selectNode(node),
    onRowDblClick: (node) => {
      if (node && node.type === 'dir') loadTree(node.id, { push: true });
    },
  });

  tables.top = new VirtualTable(dom.paneTop, {
    columns: topColumns(),
    emptyText: '没有大文件数据',
    onRowClick: (node) => locateAndSelect(node.id),
  });

  tables.search = new VirtualTable(dom.paneSearch, {
    columns: searchColumns(),
    emptyText: '输入名称关键词开始搜索',
    onRowClick: (node) => locateAndSelect(node.id),
    onRowDblClick: (node) => {
      if (node && node.type === 'dir') locateAndSelect(node.id, { openDir: true });
    },
  });

  tables.errors = new VirtualTable(dom.paneErrors, {
    columns: errorColumns(),
    emptyText: '没有读取错误',
  });

  tables.search.setEmptyText('输入名称关键词开始搜索');
}

function renderNameCell(node, cell) {
  cell.classList.add('name-cell');
  const bar = el('span', 'name-bar');
  bar.style.background = colorForKey(node.name, node.type, node.ext);
  cell.appendChild(bar);
  const ic = icon(iconForType(node));
  if (node.type === 'dir') ic.style.color = '#7db2ff';
  else if (node.type === 'link') ic.style.color = '#fbbf24';
  cell.appendChild(ic);
  const txt = el('span', 'name-text', node.name || node.path || '—');
  cell.appendChild(txt);
}

function filesColumns() {
  return [
    {
      key: 'name', label: '名称', width: 'minmax(190px, 2.2fr)', sortable: true, defaultDir: 'asc',
      render: renderNameCell,
    },
    {
      key: 'size', label: '大小', width: '100px', sortable: true, align: 'right',
      render: (n, c) => { c.classList.add('size-cell'); c.textContent = formatBytes(n.size); },
    },
    {
      key: 'alloc', label: '占用', width: '100px', sortable: true, align: 'right',
      render: (n, c) => { c.classList.add('size-cell'); c.textContent = formatBytes(n.alloc); },
    },
    {
      key: 'pct', label: '占父级', width: '76px', align: 'right',
      render: (n, c) => {
        c.classList.add('pct-cell');
        c.textContent = formatPercent(ratio(n.size, state.node ? state.node.size : 0));
      },
    },
    {
      key: 'count', label: '条目数', width: '76px', sortable: true, align: 'right',
      render: (n, c) => { c.classList.add('pct-cell'); c.textContent = formatNumber(n.count); },
    },
    {
      key: 'mtime', label: '修改时间', width: '132px', sortable: true, align: 'right',
      render: (n, c) => { c.classList.add('time-cell'); c.textContent = formatTime(n.mtime); },
    },
    {
      key: 'actions', label: '操作', width: '84px', cls: 'row-actions-cell',
      render: (n, c) => renderRowActions(n, c),
    },
  ];
}

/** 列表行内的操作按钮：打开所在位置 / 删除 */
function renderRowActions(node, cell) {
  const wrap = el('div', 'row-actions');

  const openBtn = el('button', 'icon-btn row-act');
  openBtn.type = 'button';
  openBtn.title = node.type === 'dir' ? '在文件管理中打开' : '打开所在文件夹';
  openBtn.setAttribute('aria-label', openBtn.title);
  openBtn.appendChild(icon('external'));
  openBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openInFileManager(node);
  });
  wrap.appendChild(openBtn);

  const delBtn = el('button', 'icon-btn row-act row-act-danger');
  delBtn.type = 'button';
  delBtn.title = '删除（需二次确认）';
  delBtn.setAttribute('aria-label', delBtn.title);
  delBtn.appendChild(icon('trash'));
  delBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    askDelete(node);
  });
  wrap.appendChild(delBtn);

  cell.appendChild(wrap);
}

function topColumns() {
  return [
    {
      key: 'rank', label: '#', width: '44px', align: 'right',
      render: (n, c, t, i) => { c.classList.add('rank-cell'); c.textContent = String(i + 1); },
    },
    { key: 'name', label: '名称', width: 'minmax(150px, 1.1fr)', render: renderNameCell },
    {
      key: 'path', label: '路径', width: 'minmax(190px, 1.7fr)',
      render: (n, c) => { c.classList.add('path-cell'); c.textContent = n.path || '—'; },
    },
    {
      key: 'size', label: '大小', width: '100px', align: 'right',
      render: (n, c) => { c.classList.add('size-cell'); c.textContent = formatBytes(n.size); },
    },
    {
      key: 'mtime', label: '修改时间', width: '132px', align: 'right',
      render: (n, c) => { c.classList.add('time-cell'); c.textContent = formatTime(n.mtime); },
    },
    {
      key: 'action', label: '', width: '62px', align: 'right',
      render: (n, c) => {
        c.classList.add('action-cell');
        const btn = el('button', 'btn btn-ghost btn-sm', '定位');
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          locateAndSelect(n.id);
        });
        c.appendChild(btn);
      },
    },
  ];
}

function searchColumns() {
  return [
    { key: 'name', label: '名称', width: 'minmax(150px, 1.1fr)', render: renderNameCell },
    {
      key: 'path', label: '路径', width: 'minmax(190px, 1.8fr)',
      render: (n, c) => { c.classList.add('path-cell'); c.textContent = n.path || '—'; },
    },
    {
      key: 'size', label: '大小', width: '100px', align: 'right',
      render: (n, c) => { c.classList.add('size-cell'); c.textContent = formatBytes(n.size); },
    },
    {
      key: 'mtime', label: '修改时间', width: '132px', align: 'right',
      render: (n, c) => { c.classList.add('time-cell'); c.textContent = formatTime(n.mtime); },
    },
    {
      key: 'action', label: '', width: '62px', align: 'right',
      render: (n, c) => {
        c.classList.add('action-cell');
        const btn = el('button', 'btn btn-ghost btn-sm', '定位');
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          locateAndSelect(n.id);
        });
        c.appendChild(btn);
      },
    },
  ];
}

function errorColumns() {
  return [
    {
      key: 'path', label: '路径', width: 'minmax(260px, 1.6fr)',
      render: (n, c) => { c.classList.add('path-cell'); c.textContent = n.path || '—'; },
    },
    {
      key: 'error', label: '错误信息', width: 'minmax(220px, 1fr)',
      render: (n, c) => { c.classList.add('err-cell'); c.textContent = n.error || '—'; },
    },
  ];
}

function resetListFilters() {
  state.list.q = '';
  state.list.kind = 'all';
  state.list.sort = 'size';
  state.list.dir = 'desc';
  state.list.total = 0;
  if (dom.listQ) dom.listQ.value = '';
  if (dom.listKind) dom.listKind.value = 'all';
  if (tables.files) tables.files.setSort('size', 'desc');
  updateListSortNote();
}

function updateListSortNote() {
  const labels = { size: '大小', name: '名称', mtime: '修改时间', alloc: '占用', count: '条目数' };
  const label = labels[state.list.sort] || state.list.sort;
  setText(dom.listSortNote, `排序：${label} ${state.list.dir === 'asc' ? '升序' : '降序'}`);
}

async function loadList() {
  if (!state.node || !state.scanId) return;
  const filesTable = tables.files;
  if (!filesTable) return;
  const seq = ++state.list.seq;
  const node = state.node;
  const filters = {
    q: (dom.listQ ? dom.listQ.value.trim() : state.list.q),
    kind: dom.listKind ? dom.listKind.value : state.list.kind,
    sort: state.list.sort,
    dir: state.list.dir,
  };
  state.list.q = filters.q;
  state.list.kind = filters.kind;

  filesTable.setLoading(true);
  updateBottomCount();
  try {
    const params = {
      node: node.id, offset: 0, limit: 200,
      sort: filters.sort, dir: filters.dir,
      q: filters.q || undefined,
      kind: filters.kind,
    };
    const res = await api.children(state.scanId, params);
    if (seq !== state.list.seq) return;
    state.list.total = Number(res.total) || 0;
    filesTable.setPaged(
      state.list.total,
      (offset, limit) => api.children(state.scanId, {
        node: node.id, offset, limit,
        sort: filters.sort, dir: filters.dir,
        q: filters.q || undefined,
        kind: filters.kind,
      }).then((r) => r.items || []),
      res.items || [],
    );
    setText(dom.listCount, `${formatNumber(state.list.total)} 项`);
    updateBottomCount();
  } catch (err) {
    if (seq !== state.list.seq) return;
    filesTable.setError('列表加载失败：' + err.message);
  }
}

function showInList(node) {
  if (!node) return;
  switchTab('files');
  if (dom.listQ) dom.listQ.value = node.name || '';
  loadList();
}

/* ------------------------------------------------------------------ */
/* 节点操作：在文件管理器中打开 / 删除                                  */
/* ------------------------------------------------------------------ */

/**
 * 在 fnOS 文件管理器中打开该条目所在目录。
 * 必须通过桌面壳（Trim App）的 openFileManager 桥接调用，桌面壳才会切到
 * 文件管理器并定位到目标目录；直接 window.open 一个 hash 路由是无效的。
 */
async function openInFileManager(node) {
  if (!node || !state.scanId) return;
  let res;
  try {
    res = await api.openNode(state.scanId, node.id);
  } catch (err) {
    toast('无法获取所在位置：' + err.message, 'error', 5000);
    return;
  }
  const target = res && res.dir ? res.dir : node.path;
  // 后端已按宿主规则判定该目录要不要管理员"全部文件"视角：
  // 自己的共享目录 / 普通目录 → 用户视角；别人的共享、团队文件、系统目录 → 管理员视角。
  const needAdmin = !!(res && res.admin);

  try {
    await hostOpenFileManager(target, { isAdmin: needAdmin });
    toast(
      needAdmin ? '已用管理员视角在文件管理器中打开：' + target : '已在文件管理器中打开：' + target,
      'ok',
      3500,
    );
    return;
  } catch (err) {
    if (err && err.message !== 'HOST_UNAVAILABLE') {
      // 壳在，但调用失败：给出明确原因，并保留路径到剪贴板
      logHostError(err);
    }
  }

  // 降级：不在 fnOS 壳内（例如本地开发直接用浏览器打开）
  copyText(target);
  toast('当前环境无法唤起文件管理器，已复制目录路径：' + target, 'warn', 6000);
}

/** 记录宿主调用错误，便于排查 */
function logHostError(err) {
  const msg = (err && err.message) || String(err);
  // eslint-disable-next-line no-console
  console.warn('[trtree] 文件管理器调用失败:', msg, err);
  if (state.hostSupport === null) {
    hostAvailable().then((ok) => { state.hostSupport = ok; });
  }
}

/** 打开二次确认弹窗 */
function askDelete(node) {
  if (!node || !state.scanId) return;
  state.del.node = node;
  state.del.open = true;
  state.del.busy = false;

  setText(dom.confirmPath, node.path || node.name || '—');
  setText(dom.confirmType, nodeTypeLabel(node));
  setText(dom.confirmSize, formatBytes(node.size));
  setText(dom.confirmAlloc, formatBytes(node.alloc));
  setText(dom.confirmCount, node.type === 'dir' ? `${formatNumber(node.count)} 项` : '单个文件');
  setText(dom.confirmStatus, '');
  dom.confirmStatus.classList.remove('error');
  if (dom.confirmDelete) {
    dom.confirmDelete.disabled = false;
    setText(dom.confirmDelete.querySelector('span'), '永久删除');
  }
  if (dom.confirm) dom.confirm.hidden = false;
  window.setTimeout(() => { if (dom.confirmCancel) dom.confirmCancel.focus(); }, 30);
}

function closeDelete() {
  if (state.del.busy) return;
  state.del.open = false;
  state.del.node = null;
  if (dom.confirm) dom.confirm.hidden = true;
}

async function confirmDelete() {
  const node = state.del.node;
  if (!node || !state.scanId || state.del.busy) return;
  state.del.busy = true;
  if (dom.confirmDelete) {
    dom.confirmDelete.disabled = true;
    setText(dom.confirmDelete.querySelector('span'), '正在删除…');
  }
  setText(dom.confirmStatus, '正在删除，请稍候…');
  dom.confirmStatus.classList.remove('error');

  const scanId = state.scanId;
  try {
    await api.deleteNode(scanId, node.id);
  } catch (err) {
    state.del.busy = false;
    if (dom.confirmDelete) {
      dom.confirmDelete.disabled = false;
      setText(dom.confirmDelete.querySelector('span'), '永久删除');
    }
    setText(dom.confirmStatus, err.message || '删除失败');
    dom.confirmStatus.classList.add('error');
    return;
  }

  state.del.busy = false;
  state.del.open = false;
  state.del.node = null;
  if (dom.confirm) dom.confirm.hidden = true;
  toast('已删除：' + (node.name || node.path), 'ok', 5000);

  // 树已失效（后端已丢弃缓存），回到概览页并提示重新分析
  const path = state.scan && state.scan.path;
  showEmptyView();
  if (path) {
    window.setTimeout(() => {
      toastAction(`「${path}」的扫描结果已过期`, '重新分析', () => startScan(path), 'warn', 12000);
    }, 260);
  }
}

function updateBottomCount() {
  if (!dom.bottomCount) return;
  let text = '';
  if (state.tab === 'files') text = state.list.total ? `${formatNumber(state.list.total)} 项` : '';
  else if (state.tab === 'top') text = state.globals.top ? `${formatNumber(state.globals.top.length)} 个文件` : '';
  else if (state.tab === 'search') text = state.search.total ? `共 ${formatNumber(state.search.total)} 条` : '';
  else if (state.tab === 'errors') text = state.globals.errors ? `共 ${formatNumber(state.globals.errors.total || 0)} 条` : '';
  setText(dom.bottomCount, text);
}

function switchTab(tab) {
  state.tab = tab;
  const panes = { files: dom.paneFiles, top: dom.paneTop, search: dom.paneSearch, errors: dom.paneErrors };
  const toolbars = { files: dom.toolbarFiles, top: dom.toolbarTop, search: dom.toolbarSearch, errors: dom.toolbarErrors };
  for (const key of Object.keys(panes)) {
    if (panes[key]) panes[key].hidden = key !== tab;
    if (toolbars[key]) toolbars[key].hidden = key !== tab;
  }
  if (dom.tabs) {
    for (const btn of dom.tabs.querySelectorAll('.tab')) {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }
  if (tab === 'top') loadTop();
  else if (tab === 'search') {
    if (tables.search) {
      tables.search.setEmptyText(state.search.q ? '没有找到匹配项' : '输入名称关键词开始搜索');
    }
    if (dom.searchQ) dom.searchQ.focus();
  } else if (tab === 'errors') loadErrors();
  updateBottomCount();
}

async function loadTop(force = false) {
  if (!state.scanId || !tables.top) return;
  if (!force && state.globals.top) {
    tables.top.setStatic(state.globals.top);
    setText(dom.topCount, `${formatNumber(state.globals.top.length)} 个文件`);
    updateBottomCount();
    return;
  }
  tables.top.setLoading(true);
  try {
    const res = await api.top(state.scanId, 200);
    const items = Array.isArray(res.items) ? res.items : [];
    state.globals.top = items;
    tables.top.setStatic(items);
    setText(dom.topCount, `${formatNumber(items.length)} 个文件`);
    updateBottomCount();
  } catch (err) {
    tables.top.setError('大文件列表加载失败：' + err.message);
  }
}

async function loadErrors(force = false) {
  if (!state.scanId || !tables.errors) return;
  if (!force && state.globals.errors) {
    setText(dom.errorsCount, `共 ${formatNumber(state.globals.errors.total || 0)} 条`);
    updateBottomCount();
    return;
  }
  tables.errors.setLoading(true);
  try {
    const res = await api.errors(state.scanId, { offset: 0, limit: 200 });
    const total = Number(res.total) || 0;
    state.globals.errors = { total };
    tables.errors.setPaged(
      total,
      (offset, limit) => api.errors(state.scanId, { offset, limit }).then((r) => r.items || []),
      res.items || [],
    );
    setText(dom.errorsCount, `共 ${formatNumber(total)} 条`);
    updateBottomCount();
  } catch (err) {
    tables.errors.setError('错误列表加载失败：' + err.message);
  }
}

function resetSearchState() {
  state.search = { q: '', kind: 'all', min: 0, total: 0, truncated: false, seq: state.search.seq + 1 };
  if (dom.searchQ) dom.searchQ.value = '';
  if (dom.searchKind) dom.searchKind.value = 'all';
  if (dom.searchMinSize) dom.searchMinSize.value = '0';
  if (tables.search) {
    tables.search.setStatic([]);
    tables.search.setEmptyText('输入名称关键词开始搜索');
  }
  setText(dom.searchCount, '');
}

async function runSearch() {
  if (!state.scanId || !tables.search) return;
  const q = dom.searchQ ? dom.searchQ.value.trim() : '';
  const kind = dom.searchKind ? dom.searchKind.value : 'all';
  const min = dom.searchMinSize ? Number(dom.searchMinSize.value) || 0 : 0;
  state.search.q = q;
  state.search.kind = kind;
  state.search.min = min;

  if (!q) {
    state.search.total = 0;
    state.search.truncated = false;
    tables.search.setStatic([]);
    tables.search.setEmptyText('输入名称关键词开始搜索');
    setText(dom.searchCount, '');
    updateBottomCount();
    return;
  }

  const seq = ++state.search.seq;
  tables.search.setLoading(true);
  setText(dom.searchCount, '搜索中…');
  try {
    const res = await api.search(state.scanId, {
      q, kind, minSize: min || undefined, limit: 500,
    });
    if (seq !== state.search.seq) return;
    state.search.total = Number(res.total) || 0;
    state.search.truncated = !!res.truncated;
    const items = Array.isArray(res.items) ? res.items : [];
    tables.search.setStatic(items);
    tables.search.setEmptyText('没有找到匹配项');
    setText(dom.searchCount, `共 ${formatNumber(state.search.total)} 条${res.truncated ? '（仅显示前 500）' : ''}`);
    updateBottomCount();
  } catch (err) {
    if (seq !== state.search.seq) return;
    tables.search.setError('搜索失败：' + err.message);
    setText(dom.searchCount, '');
  }
}

function searchByExt(ext) {
  if (!ext) {
    toast('无扩展名文件请在文件列表中按名称过滤', 'warn', 3200);
    return;
  }
  switchTab('search');
  if (dom.searchQ) dom.searchQ.value = '.' + ext;
  if (dom.searchKind) dom.searchKind.value = 'file';
  if (dom.searchMinSize) dom.searchMinSize.value = '0';
  runSearch();
}

async function locateAndSelect(nodeOrId, opts = {}) {
  if (!state.scanId) return;
  const id = nodeOrId && typeof nodeOrId === 'object' ? nodeOrId.id : nodeOrId;
  if (id === undefined || id === null) return;
  try {
    const loc = await api.locate(state.scanId, id);
    const node = loc.node;
    if (!node) { toast('未找到该条目', 'warn'); return; }
    const parent = (loc.ancestors && loc.ancestors.length) ? loc.ancestors[loc.ancestors.length - 1] : null;
    const parentId = parent ? parent.id : node.id;

    if (state.nodeId !== parentId) {
      await loadTree(parentId, { push: true });
    } else if (!state.node || state.node.id !== parentId) {
      await loadTree(parentId, { push: true });
    }
    selectNode(node);
    if (opts.openDir && node.type === 'dir') {
      await loadTree(node.id, { push: true });
    }
  } catch (err) {
    toast('定位失败：' + err.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* URL / 历史                                                          */
/* ------------------------------------------------------------------ */

function updateUrl(nodeId, opts = {}) {
  const params = new URLSearchParams();
  if (state.scanId) params.set('scan', state.scanId);
  const id = nodeId === undefined || nodeId === null ? 0 : Number(nodeId);
  if (id) params.set('node', String(id));
  const s = params.toString();
  const url = location.pathname + (s ? '?' + s : '');
  try {
    if (opts.push) history.pushState({ scan: state.scanId, node: id }, '', url);
    else history.replaceState({ scan: state.scanId, node: id }, '', url);
  } catch (_) { /* 忽略沙箱限制 */ }
}

function onPopState() {
  const params = new URLSearchParams(location.search);
  const sid = params.get('scan');
  const nodeId = Number(params.get('node') || 0);
  if (!sid) {
    showEmptyView();
    return;
  }
  if (sid === state.scanId && state.phase === 'result') {
    if (nodeId !== (state.node ? state.node.id : 0)) {
      loadTree(nodeId, { push: false });
    }
    return;
  }
  restoreScan(sid, nodeId);
}

function showEmptyView() {
  stopPolling();
  state.phase = 'empty';
  state.demo = false;
  state.scanId = null;
  state.scan = null;
  state.nodeId = 0;
  state.node = null;
  state.rootNode = null;
  state.ancestors = [];
  state.children = [];
  state.total = 0;
  state.truncated = false;
  state.selection = null;
  state.globals = emptyGlobals();
  resetSearchState();
  renderEmpty();
  updateUrl(null, { push: true });
}

function showError(message) {
  stopPolling();
  state.phase = 'error';
  showView('error');
  setText(dom.errorMessage, message || '未知错误');
  setStatus('error', '出错了');
  setScanButton('idle');
  setExportEnabled(false);
  setInputsEnabled(true);
}

/* ------------------------------------------------------------------ */
/* 目录选择弹窗                                                        */
/* ------------------------------------------------------------------ */

function pickerBreadcrumbs(path) {
  const out = [{ label: '根目录', path: '/' }];
  if (!path || path === '/') return out;
  const parts = String(path).split('/').filter(Boolean);
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    out.push({ label: p, path: acc });
  }
  return out;
}

async function openPicker(path) {
  state.picker.open = true;
  if (dom.picker) dom.picker.hidden = false;
  const start = normalizePath(path) || '/';
  if (dom.pickerPath) dom.pickerPath.value = start;
  state.picker.selected = null;
  if (dom.pickerRoots && !state.picker.roots.length) {
    state.picker.roots = state.roots.slice();
  }
  await loadPicker(start);
}

function closePicker(focus) {
  state.picker.open = false;
  if (dom.picker) dom.picker.hidden = true;
  if (focus === 'scan' && dom.scanBtn) dom.scanBtn.focus();
  else if (focus === 'path' && dom.pathInput) dom.pathInput.focus();
  else if (focus === 'browse' && dom.browseBtn) dom.browseBtn.focus();
}

async function loadPicker(path) {
  const p = normalizePath(path) || '/';
  const seq = ++state.picker.seq;
  state.picker.loading = true;
  state.picker.error = null;
  state.picker.selected = null;
  renderPickerCrumbs(p);
  renderPickerList();
  setText(dom.pickerStatus, '正在加载 ' + p + ' …');
  if (dom.pickerStatus) dom.pickerStatus.classList.remove('error');
  try {
    const res = await api.browse(p);
    if (seq !== state.picker.seq) return;
    state.picker.loading = false;
    state.picker.current = res.path || p;
    state.picker.parent = res.parent || null;
    state.picker.dirs = Array.isArray(res.dirs) ? res.dirs : [];
    if (Array.isArray(res.roots) && res.roots.length) state.picker.roots = res.roots;
    state.picker.error = res.error || null;
    if (dom.pickerPath) dom.pickerPath.value = state.picker.current;
    renderPickerCrumbs(state.picker.current);
    renderPickerRoots();
    renderPickerList();
    if (state.picker.error) {
      if (dom.pickerStatus) dom.pickerStatus.classList.add('error');
      setText(dom.pickerStatus, state.picker.error + '（' + state.picker.current + '）');
    } else {
      if (dom.pickerStatus) dom.pickerStatus.classList.remove('error');
      setText(dom.pickerStatus, `${state.picker.current} · ${state.picker.dirs.length} 个子目录`);
    }
  } catch (err) {
    if (seq !== state.picker.seq) return;
    state.picker.loading = false;
    state.picker.dirs = [];
    state.picker.error = err.message;
    renderPickerList();
    if (dom.pickerStatus) dom.pickerStatus.classList.add('error');
    setText(dom.pickerStatus, err.message);
  }
}

function renderPickerCrumbs(path) {
  const wrap = dom.pickerCrumbs;
  if (!wrap) return;
  clear(wrap);
  const parts = pickerBreadcrumbs(path || state.picker.current || '/');
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = el('span', 'crumb-sep');
      sep.appendChild(icon('chevron-right'));
      wrap.appendChild(sep);
    }
    const btn = el('button', 'crumb' + (i === parts.length - 1 ? ' current' : ''), part.label);
    btn.type = 'button';
    btn.title = part.path;
    if (i !== parts.length - 1) {
      btn.addEventListener('click', () => loadPicker(part.path));
    }
    wrap.appendChild(btn);
  });
}

function renderPickerRoots() {
  const wrap = dom.pickerRoots;
  if (!wrap) return;
  clear(wrap);
  const roots = state.picker.roots.length ? state.picker.roots : state.roots;
  if (!roots.length) {
    wrap.appendChild(el('div', 'ext-empty', '暂无快捷根目录'));
    return;
  }
  for (const r of roots) {
    const btn = el('button', 'root-item' + (r.path === state.picker.current ? ' active' : ''));
    btn.type = 'button';
    const name = el('b');
    name.appendChild(icon(rootIcon(r.kind)));
    name.appendChild(document.createTextNode(' ' + (r.label || r.path)));
    btn.appendChild(name);
    const path = el('span', '', r.path || '');
    btn.appendChild(path);
    btn.addEventListener('click', () => loadPicker(r.path));
    wrap.appendChild(btn);
  }
}

function rootIcon(kind) {
  if (kind === 'system') return 'server';
  if (kind === 'home') return 'home';
  return 'drive';
}

function renderPickerList() {
  const wrap = dom.pickerList;
  if (!wrap) return;
  clear(wrap);
  if (state.picker.loading) {
    const loading = el('div', 'picker-loading');
    loading.appendChild(el('span', 'spinner'));
    loading.appendChild(el('span', '', '正在读取目录…'));
    wrap.appendChild(loading);
    return;
  }
  if (state.picker.error) {
    const empty = el('div', 'picker-empty');
    empty.appendChild(icon('alert'));
    empty.appendChild(el('div', '', state.picker.error));
    const retry = el('button', 'btn btn-ghost btn-sm', '重试');
    retry.type = 'button';
    retry.addEventListener('click', () => loadPicker(state.picker.current || '/'));
    empty.appendChild(retry);
    wrap.appendChild(empty);
    return;
  }
  if (!state.picker.dirs.length) {
    const empty = el('div', 'picker-empty');
    empty.appendChild(icon('folder'));
    empty.appendChild(el('div', '', '此目录中没有子目录'));
    wrap.appendChild(empty);
    return;
  }
  for (const d of state.picker.dirs) {
    const row = el('div', 'dir-row' + (state.picker.selected && state.picker.selected.path === d.path ? ' sel' : ''));
    row.title = d.path || '';
    row.appendChild(icon('folder'));
    row.appendChild(el('span', 'dir-name', d.name || d.path || '—'));
    row.appendChild(el('span', 'dir-time', d.mtime ? formatTime(d.mtime) : ''));
    row.addEventListener('click', () => {
      state.picker.selected = d;
      if (dom.pickerList) {
        for (const child of dom.pickerList.children) child.classList.remove('sel');
      }
      row.classList.add('sel');
      setText(dom.pickerStatus, '已选择 ' + (d.path || d.name || ''));
    });
    row.addEventListener('dblclick', () => loadPicker(d.path));
    wrap.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function closeExportMenu() {
  if (!dom.exportMenu) return;
  dom.exportMenu.hidden = true;
  if (dom.exportBtn) dom.exportBtn.setAttribute('aria-expanded', 'false');
}

function toggleExportMenu() {
  if (!dom.exportMenu || !dom.exportBtn || dom.exportBtn.disabled) return;
  const open = dom.exportMenu.hidden;
  dom.exportMenu.hidden = !open;
  dom.exportBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function downloadExport(format) {
  if (!state.scanId) return;
  const scan = state.scan || {};
  const base = (scan.path || 'trtree').replace(/^\/+/, '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') || 'trtree';
  const stamp = formatTime(Date.now()).replace(/[-: ]/g, '');
  const a = document.createElement('a');
  a.rel = 'noopener';
  if (format === 'json') {
    a.href = api.exportJsonUrl(state.scanId);
    a.download = `trtree-${base}-${stamp}.json`;
  } else {
    a.href = api.exportUrl(state.scanId, 'csv', 'all', 'size');
    a.download = `trtree-${base}-${stamp}.csv`;
  }
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  closeExportMenu();
  toast(`已开始导出 ${format.toUpperCase()} 文件`, 'ok', 3200);
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  // 顶栏
  dom.scanBtn.addEventListener('click', () => {
    if (state.phase === 'scanning') {
      if (state.demo) toast('这是静态预览模式，取消操作不可用', 'warn', 3000);
      else cancelScan();
      return;
    }
    startScan(dom.pathInput.value);
  });
  dom.browseBtn.addEventListener('click', () => openPicker(dom.pathInput.value || '/'));
  dom.pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startScan(dom.pathInput.value);
    }
  });

  dom.exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExportMenu();
  });
  dom.exportMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    downloadExport(btn.dataset.export);
  });
  document.addEventListener('click', (e) => {
    if (!dom.exportMenu || dom.exportMenu.hidden) return;
    if (dom.exportMenu.contains(e.target) || dom.exportBtn.contains(e.target)) return;
    closeExportMenu();
  });

  // 空状态
  dom.volGrid.addEventListener('click', () => { /* 卡片按钮单独绑定 */ });

  // 扫描中
  dom.cancelBtn.addEventListener('click', () => {
    if (state.demo) toast('这是静态预览模式，取消操作不可用', 'warn', 3000);
    else cancelScan();
  });

  // 返回首页
  dom.homeBtn.addEventListener('click', goHome);
  dom.brandHome.addEventListener('click', goHome);
  dom.brandHome.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      goHome();
    }
  });

  // 结果
  dom.bannerClose.addEventListener('click', hideBanner);
  dom.upBtn.addEventListener('click', () => {
    if (state.ancestors.length) {
      loadTree(state.ancestors[state.ancestors.length - 1].id, { push: true });
    }
  });
  dom.sidebarToggle.addEventListener('click', () => {
    if (dom.viewResult) dom.viewResult.classList.toggle('sidebar-open');
  });
  dom.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn && btn.dataset.tab) switchTab(btn.dataset.tab);
  });
  dom.collapseBtn.addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    dom.bottomPanel.classList.toggle('collapsed', state.collapsed);
    if (!state.collapsed) dom.bottomPanel.style.height = state.panelHeight + 'px';
  });
  bindPanelResize();

  // 文件列表工具栏
  dom.listQ.addEventListener('input', debounce(() => loadList(), 280));
  dom.listKind.addEventListener('change', () => loadList());
  dom.listRefresh.addEventListener('click', () => loadList());

  // 大文件 / 错误
  dom.topRefresh.addEventListener('click', () => loadTop(true));
  dom.errorsRefresh.addEventListener('click', () => loadErrors(true));

  // 搜索
  dom.searchQ.addEventListener('input', debounce(() => runSearch(), 300));
  dom.searchKind.addEventListener('change', () => runSearch());
  dom.searchMinSize.addEventListener('change', () => runSearch());

  // 删除确认弹窗
  dom.confirmCancel.addEventListener('click', closeDelete);
  dom.confirmDelete.addEventListener('click', confirmDelete);
  dom.confirm.querySelectorAll('[data-close="confirm"]').forEach((n) => {
    n.addEventListener('click', closeDelete);
  });

  // 错误视图
  dom.errorBack.addEventListener('click', showEmptyView);
  dom.errorRetry.addEventListener('click', () => {
    const path = (state.scan && state.scan.path) || dom.pathInput.value;
    showEmptyView();
    window.setTimeout(() => startScan(path), 30);
  });

  // 弹窗
  for (const btn of document.querySelectorAll('[data-close="picker"]')) {
    btn.addEventListener('click', () => closePicker('browse'));
  }
  dom.pickerCancel.addEventListener('click', () => closePicker('browse'));
  dom.pickerChoose.addEventListener('click', () => {
    const p = (state.picker.selected && state.picker.selected.path) || state.picker.current || '/';
    dom.pathInput.value = p;
    closePicker('scan');
    toast('已选择目录：' + p + '，按「扫描」开始分析', 'ok', 3200);
  });
  dom.pickerGo.addEventListener('click', () => loadPicker(dom.pickerPath.value));
  dom.pickerPath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadPicker(dom.pickerPath.value);
    }
  });

  // 键盘
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);

    if (e.key === 'Escape') {
      if (state.del.open) { closeDelete(); return; }
      if (!dom.picker.hidden) closePicker('browse');
      closeExportMenu();
      if (state.phase === 'result' && state.selection) selectNode(null);
      return;
    }
    if (typing) return;
    if (e.key === '/' && state.phase !== 'scanning') {
      e.preventDefault();
      focusPathInput();
      return;
    }
    if (state.phase !== 'result') return;
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (state.ancestors.length) {
        loadTree(state.ancestors[state.ancestors.length - 1].id, { push: true });
      }
    } else if (e.key === 'Enter' && state.selection && state.selection.type === 'dir') {
      e.preventDefault();
      loadTree(state.selection.id, { push: true });
    }
  });

  window.addEventListener('popstate', onPopState);
}

function bindPanelResize() {
  let dragging = false;
  let startY = 0;
  let startH = 0;

  dom.panelResize.addEventListener('pointerdown', (e) => {
    if (state.collapsed) return;
    dragging = true;
    startY = e.clientY;
    startH = dom.bottomPanel.offsetHeight;
    dom.panelResize.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const next = clamp(startH + (startY - e.clientY), 300, 520);
    state.panelHeight = next;
    dom.bottomPanel.style.height = next + 'px';
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

/* ------------------------------------------------------------------ */
/* Treemap 回调                                                        */
/* ------------------------------------------------------------------ */

function handleTreemapSelect(node) {
  if (!node) {
    selectNode(null);
    return;
  }
  selectNode(node);
}

function handleTreemapOpen(node) {
  if (node && node.type === 'dir') loadTree(node.id, { push: true });
}

function handleTreemapOpenFile(node) {
  if (!node) return;
  selectNode(node);
  showInList(node);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function bootstrapTreemap() {
  treemap = new TreemapView(dom.treemap, {
    onSelect: handleTreemapSelect,
    onOpen: handleTreemapOpen,
    onOpenFile: handleTreemapOpenFile,
  });
}

function startDemoScanning() {
  state.demo = true;
  state.phase = 'scanning';
  state.scan = {
    id: 's_preview', path: '/vol1', status: 'running',
    startedAt: Date.now() - 8400, files: 128443, dirs: 6210,
    size: 442000000000, alloc: 438000000000, errors: 0,
  };
  state.scanId = null;
  showView('scanning');
  setScanButton('scanning');
  setStatus('scanning', '扫描中');
  setExportEnabled(false);
  setInputsEnabled(false);
  if (dom.pathInput) dom.pathInput.value = '/vol1';
  setText(dom.scanTarget, '/vol1');
  renderScanning({
    files: 128443,
    dirs: 6210,
    size: 442000000000,
    alloc: 438000000000,
    elapsedMs: 8400,
    currentPath: '/vol1/1000/Photos/2024/DCIM/IMG_20240812_183022.jpg',
  });
}

// 启动
try {
  bootstrapTreemap();
} catch (err) {
  // 画布不可用时仍然保证其余界面可用
  treemap = null;
}
init();
