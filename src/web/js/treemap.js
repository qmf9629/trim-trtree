/**
 * treemap.js — squarified treemap 布局 + Canvas 渲染 + 交互
 *
 * 导出：
 *   squarify(items, x, y, w, h) 纯函数布局（便于测试）
 *   TreemapView                 画布视图（hover tooltip / 单击选中 / 双击钻取 / DPR / ResizeObserver）
 */

import {
  el, formatBytes, formatNumber, formatPercent, formatTime,
  randomTileColor, ratio,
} from './format.js';

const MAX_TILES = 4000;

/* ------------------------------------------------------------------ */
/* squarified treemap（Bruls / Huizing / van Wijk）                    */
/* ------------------------------------------------------------------ */

function worstRatio(row, side) {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (let i = 0; i < row.length; i++) {
    const a = row[i];
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  if (!(sum > 0) || !(side > 0) || !(min > 0)) return Infinity;
  const s2 = sum * sum;
  const l2 = side * side;
  return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

function placeRow(row, entries, startIndex, rect, placed) {
  const sum = row.reduce((s, a) => s + a, 0);
  if (!(sum > 0)) {
    for (let k = 0; k < row.length; k++) placed.push({ item: entries[startIndex + k].item, x: rect.x, y: rect.y, w: 0, h: 0 });
    return rect;
  }
  if (rect.w >= rect.h) {
    // 竖条，贴左侧
    const rw = sum / rect.h;
    let oy = rect.y;
    for (let k = 0; k < row.length; k++) {
      const rh = row[k] / rw;
      placed.push({ item: entries[startIndex + k].item, x: rect.x, y: oy, w: rw, h: rh });
      oy += rh;
    }
    return { x: rect.x + rw, y: rect.y, w: Math.max(0, rect.w - rw), h: rect.h };
  }
  // 横条，贴顶部
  const rh = sum / rect.w;
  let ox = rect.x;
  for (let k = 0; k < row.length; k++) {
    const rw = row[k] / rh;
    placed.push({ item: entries[startIndex + k].item, x: ox, y: rect.y, w: rw, h: rh });
    ox += rw;
  }
  return { x: rect.x, y: rect.y + rh, w: rect.w, h: Math.max(0, rect.h - rh) };
}

/**
 * 计算 squarified treemap。
 * @param {Array} items  每项需含 value:number（其余字段原样带出）
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @returns {Array} 与 items 等长、按原始顺序排列，附带 x/y/w/h（0 值项 w=h=0）
 */
export function squarify(items, x, y, w, h) {
  const src = Array.isArray(items) ? items : [];
  if (!src.length) return [];
  x = Number(x) || 0;
  y = Number(y) || 0;
  w = Math.max(0, Number(w) || 0);
  h = Math.max(0, Number(h) || 0);

  const positive = [];
  for (const it of src) {
    const v = Number(it && it.value);
    if (Number.isFinite(v) && v > 0) positive.push({ item: it, value: v });
  }

  if (!positive.length || w === 0 || h === 0) {
    return src.map((it) => ({ ...it, x, y, w: 0, h: 0 }));
  }

  positive.sort((a, b) => b.value - a.value);
  const total = positive.reduce((s, p) => s + p.value, 0);
  const scale = (w * h) / total;
  const entries = positive.map((p) => ({ item: p.item, area: p.value * scale }));

  const placed = [];
  let rect = { x, y, w, h };
  let i = 0;
  while (i < entries.length) {
    if (!(rect.w > 0) || !(rect.h > 0)) break;
    const side = Math.min(rect.w, rect.h);
    const row = [];
    let best = Infinity;
    while (i < entries.length) {
      const area = entries[i].area;
      const candidate = row.concat(area);
      const r = worstRatio(candidate, side);
      if (row.length > 0 && r > best) break;
      row.push(area);
      best = r;
      i++;
    }
    const start = i - row.length;
    rect = placeRow(row, entries, start, rect, placed);
  }
  // 浮点误差导致剩余空间未分配：把剩余项塞进零面积（避免 NaN）
  while (i < entries.length) {
    placed.push({ item: entries[i].item, x: rect.x, y: rect.y, w: 0, h: 0 });
    i++;
  }

  const byItem = new Map();
  for (const p of placed) byItem.set(p.item, p);
  return src.map((it) => {
    const p = byItem.get(it);
    return p ? { ...it, x: p.x, y: p.y, w: p.w, h: p.h } : { ...it, x, y, w: 0, h: 0 };
  });
}

/* ------------------------------------------------------------------ */

function fitText(ctx, text, maxW) {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

export class TreemapView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts { onSelect(node|null), onOpen(node), onEmptyClick() }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.opts = opts || {};
    this.tiles = [];
    this.children = [];
    this.node = null;
    this.total = 0;
    this.truncated = false;
    this.showCount = 0;
    this.agg = null;
    this.hover = null;
    this.selectedId = null;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this._raf = 0;
    this._tooltipTile = null;

    this.tooltip = this._createTooltip();
    this._bindEvents();

    this.ro = new ResizeObserver(() => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._resize();
      });
    });
    const host = canvas.parentElement || canvas;
    this.ro.observe(host);
    this._resize();
  }

  /* ------------------------------- data ----------------------------- */

  /**
   * @param {{node:Object, children:Array, total?:number, truncated?:boolean}} data
   */
  setData(data) {
    this.node = (data && data.node) || null;
    let children = Array.isArray(data && data.children) ? data.children.slice() : [];
    children.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    this.children = children;
    this.total = typeof data.total === 'number' ? data.total : children.length;
    this.truncated = !!data.truncated;
    this.agg = null;

    let layoutChildren = children;
    if (children.length > MAX_TILES) {
      const head = children.slice(0, MAX_TILES);
      const rest = children.slice(MAX_TILES);
      const restSize = rest.reduce((s, n) => s + (Number(n.size) || 0), 0);
      this.agg = {
        id: '__other__',
        agg: true,
        name: `其他 ${formatNumber(rest.length)} 项`,
        size: restSize,
        alloc: rest.reduce((s, n) => s + (Number(n.alloc) || 0), 0),
        count: rest.reduce((s, n) => s + (Number(n.count) || 0), 0),
        type: 'dir',
        ext: '',
        restCount: rest.length,
        path: '',
      };
      layoutChildren = head.concat([this.agg]);
    }
    this.showCount = children.length > MAX_TILES ? MAX_TILES : children.length;

    this.hover = null;
    this._hideTooltip();
    this._resize(true);
  }

  setSelected(id) {
    const next = id === undefined || id === null ? null : id;
    if (this.selectedId === next) return;
    this.selectedId = next;
    this._draw();
  }

  /** 返回可见 tile 数量（不含聚合项） */
  getShownCount() {
    return this.showCount;
  }

  /* ------------------------------ sizing ---------------------------- */

  _measure() {
    const host = this.canvas.parentElement || this.canvas;
    const rect = host.getBoundingClientRect();
    const w = Math.max(0, Math.floor(rect.width));
    const h = Math.max(0, Math.floor(rect.height));
    const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    return w !== 0 && h !== 0;
  }

  _resize(force = false) {
    const prevW = this.cssW;
    const prevH = this.cssH;
    const ok = this._measure();
    if (!ok) return;
    if (force || prevW !== this.cssW || prevH !== this.cssH) {
      this._layout();
    }
    this._draw();
  }

  _layout() {
    const tiles = [];
    const w = this.cssW;
    const h = this.cssH;
    const items = [];
    for (const n of this.children) {
      const size = Number(n.size) || 0;
      items.push({ node: n, value: size, agg: false });
    }
    if (this.agg) {
      items.push({ node: this.agg, value: Number(this.agg.size) || 0, agg: true });
    }
    const laid = squarify(items, 0, 0, w, h);
    for (let i = 0; i < laid.length; i++) {
      const t = laid[i];
      if (!(t.w > 0) || !(t.h > 0)) continue;
      // index 参与配色取色，保证相邻色块色相不同
      t.index = i;
      tiles.push(t);
    }
    tiles.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    this.tiles = tiles;
  }

  /* ------------------------------- draw ----------------------------- */

  _fillFor(tile) {
    if (tile.agg) return 'rgb(71,85,105)';
    const n = tile.node;
    // 每个色块使用稳定随机色：同一次扫描中颜色不变，相邻块色相分散
    return randomTileColor(n.id !== undefined ? 'n' + n.id : n.path || n.name, tile.index || 0, n.type === 'dir');
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.cssW;
    const h = this.cssH;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, w, h);

    const hasArea = this.tiles.length > 0;
    if (!hasArea) {
      this._drawEmpty(ctx, w, h, this.children.length > 0);
      return;
    }

    const selected = this.selectedId;
    let selectedTile = null;

    for (const tile of this.tiles) {
      const gap = 1;
      const x = tile.x + gap;
      const y = tile.y + gap;
      const tw = tile.w - gap * 2;
      const th = tile.h - gap * 2;
      if (tw <= 0.5 || th <= 0.5) continue;

      ctx.fillStyle = this._fillFor(tile);
      ctx.fillRect(x, y, tw, th);
      ctx.strokeStyle = 'rgba(0,0,0,0.38)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, tw - 1), Math.max(0, th - 1));

      if (this.hover === tile) {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(x, y, tw, th);
      }

      const isSel = selected !== null && !tile.agg && tile.node.id === selected;
      if (isSel) selectedTile = tile;

      if (tw >= 54 && th >= 24) {
        this._drawLabel(ctx, tile, x, y, tw, th);
      }
    }

    // hover / selection 描边绘制在所有色块之上
    if (this.hover && this.hover !== selectedTile) {
      this._strokeTile(this.hover, 'rgba(255,255,255,0.88)', 1.5, false);
    }
    if (selectedTile) {
      this._strokeTile(selectedTile, '#ffffff', 2, true);
    }
  }

  _strokeTile(tile, color, width, glow) {
    const ctx = this.ctx;
    const x = tile.x + 1.5;
    const y = tile.y + 1.5;
    const w = Math.max(0, tile.w - 3);
    const h = Math.max(0, tile.h - 3);
    if (w <= 0 || h <= 0) return;
    ctx.save();
    if (glow) {
      ctx.shadowColor = 'rgba(255,255,255,0.55)';
      ctx.shadowBlur = 10;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  _drawLabel(ctx, tile, x, y, tw, th) {
    const n = tile.node;
    const pad = 6;
    const maxW = tw - pad * 2;
    if (maxW < 24) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, tw - 4, th - 4);
    ctx.clip();
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;

    const name = tile.agg ? n.name : (n.name || n.path || '');
    const showSize = th >= 40 && tw >= 56;
    ctx.font = '600 12px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    const nameText = fitText(ctx, name, maxW);
    if (nameText) ctx.fillText(nameText, x + pad, y + pad + 1);

    if (showSize) {
      ctx.font = '11px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      const sizeText = fitText(ctx, formatBytes(n.size), maxW);
      if (sizeText) ctx.fillText(sizeText, x + pad, y + pad + 18);
    }
    ctx.restore();
  }

  _drawEmpty(ctx, w, h, hasChildren) {
    if (w < 80 || h < 60) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(232,238,252,0.72)';
    ctx.font = '600 14px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText(hasChildren ? '无可显示的占用空间' : '此目录为空', w / 2, h / 2 - 10);
    ctx.fillStyle = 'rgba(159,176,201,0.6)';
    ctx.font = '12px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText(hasChildren ? '子项大小均为 0 字节' : '当前目录下没有任何条目', w / 2, h / 2 + 14);
    ctx.restore();
  }

  /* ------------------------------ events ---------------------------- */

  _bindEvents() {
    this._onMove = (e) => this._handleMove(e);
    this._onLeave = () => {
      if (this.hover) {
        this.hover = null;
        this._draw();
      }
      this._hideTooltip();
    };
    this._onClick = (e) => this._handleClick(e);
    this._onDbl = (e) => this._handleDblClick(e);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerleave', this._onLeave);
    this.canvas.addEventListener('click', this._onClick);
    this.canvas.addEventListener('dblclick', this._onDbl);
  }

  _localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _hit(x, y) {
    for (let i = this.tiles.length - 1; i >= 0; i--) {
      const t = this.tiles[i];
      if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return t;
    }
    return null;
  }

  _handleMove(e) {
    if (!this.tiles.length) return;
    const p = this._localPoint(e);
    const tile = this._hit(p.x, p.y);
    if (tile !== this.hover) {
      this.hover = tile;
      this._draw();
    }
    if (tile) {
      if (this._tooltipTile !== tile) {
        this._fillTooltip(tile);
        this._tooltipTile = tile;
      }
      this._positionTooltip(e.clientX, e.clientY);
    } else {
      this._hideTooltip();
    }
  }

  _handleClick(e) {
    const p = this._localPoint(e);
    const tile = this._hit(p.x, p.y);
    if (!tile) {
      if (this.selectedId !== null) {
        this.selectedId = null;
        this._draw();
        if (this.opts.onSelect) this.opts.onSelect(null);
      }
      return;
    }
    if (tile.agg) return;
    this.selectedId = tile.node.id;
    this._draw();
    if (this.opts.onSelect) this.opts.onSelect(tile.node);
  }

  _handleDblClick(e) {
    const p = this._localPoint(e);
    const tile = this._hit(p.x, p.y);
    if (!tile || tile.agg) return;
    if (tile.node.type === 'dir') {
      if (this.opts.onOpen) this.opts.onOpen(tile.node);
    } else if (this.opts.onOpenFile) {
      this.opts.onOpenFile(tile.node);
    }
  }

  /* ----------------------------- tooltip ---------------------------- */

  _createTooltip() {
    const t = el('div', 'tm-tooltip');
    t.hidden = true;
    const name = el('div', 'tt-name');
    const path = el('div', 'tt-path');
    const grid = el('div', 'tt-grid');
    const rows = {};
    const fields = [
      ['size', '大小'],
      ['pct', '占父级'],
      ['count', '条目数'],
      ['mtime', '修改时间'],
    ];
    for (const [key, label] of fields) {
      grid.appendChild(el('span', 'tt-k', label));
      const b = el('b', 'tt-v');
      grid.appendChild(b);
      rows[key] = b;
    }
    const hint = el('div', 'tt-hint');
    t.appendChild(name);
    t.appendChild(path);
    t.appendChild(grid);
    t.appendChild(hint);
    document.body.appendChild(t);
    this._tt = { root: t, name, path, rows, hint };
    return t;
  }

  _fillTooltip(tile) {
    const tt = this._tt;
    const n = tile.node;
    if (tile.agg) {
      tt.name.textContent = n.name;
      tt.path.textContent = `超出单层渲染上限，剩余 ${formatNumber(n.restCount)} 项已聚合`;
      tt.rows.size.textContent = formatBytes(n.size);
      tt.rows.pct.textContent = formatPercent(ratio(n.size, (this.node && this.node.size) || 0));
      tt.rows.count.textContent = formatNumber(n.restCount) + ' 项';
      tt.rows.mtime.textContent = '—';
      tt.hint.textContent = '聚合项不可选中';
      return;
    }
    tt.name.textContent = n.name || n.path || '';
    tt.path.textContent = n.path || '';
    tt.rows.size.textContent = formatBytes(n.size);
    tt.rows.pct.textContent = formatPercent(ratio(n.size, (this.node && this.node.size) || 0));
    tt.rows.count.textContent = formatNumber(n.count);
    tt.rows.mtime.textContent = formatTime(n.mtime);
    tt.hint.textContent = n.type === 'dir'
      ? (n.mount ? '跨文件系统挂载点（未深入扫描）' : '双击进入此目录')
      : '单击选中 · 双击定位到列表';
  }

  _positionTooltip(cx, cy) {
    const t = this.tooltip;
    if (t.hidden) t.hidden = false;
    const pad = 16;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    let x = cx + pad;
    let y = cy + pad;
    if (x + w > window.innerWidth - 8) x = cx - w - pad;
    if (y + h > window.innerHeight - 8) y = cy - h - pad;
    x = Math.max(8, x);
    y = Math.max(8, y);
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }

  _hideTooltip() {
    this._tooltipTile = null;
    if (this.tooltip) this.tooltip.hidden = true;
  }

  destroy() {
    if (this.ro) this.ro.disconnect();
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    this.canvas.removeEventListener('click', this._onClick);
    this.canvas.removeEventListener('dblclick', this._onDbl);
    if (this.tooltip && this.tooltip.parentNode) this.tooltip.parentNode.removeChild(this.tooltip);
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
