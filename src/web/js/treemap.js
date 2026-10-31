/**
 * treemap.js — WizTree 风格嵌套 squarified treemap + Canvas 渲染 + 交互
 *
 * 目录块内部按子项大小继续切分为子块（递归），层级越深色调越亮（深色主题）/
 * 越暗（浅色主题），同一顶层分支保持同一色相，便于看清"谁在谁里面"。
 *
 * 导出：
 *   squarify(items, x, y, w, h) 纯函数布局（便于测试）
 *   TreemapView                 画布视图（hover tooltip / 单击选中 / 双击钻取 / DPR / ResizeObserver）
 */

import {
  el, extGroup, formatBytes, formatNumber, formatPercent, formatTime, hashString, ratio,
} from './format.js';
import { getTheme, rgbCss, toneColor } from './theme.js';

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
/* 嵌套布局参数                                                         */
/* ------------------------------------------------------------------ */

const FONT = '"Google Sans","Roboto","Noto Sans SC","PingFang SC","Microsoft YaHei",-apple-system,"Segoe UI",sans-serif';
/** 目录块至少这么大（CSS px）才在内部绘制子块 */
const NEST_MIN = 10;
/** 目录块足够大时显示标题栏 */
const HEADER_MIN_W = 64;
const HEADER_MIN_H = 46;
const HEADER_H = 18;

/** 色相池：24 等分，偏移 7° 避免与主题主色完全重合 */
const HUES = Array.from({ length: 24 }, (_, i) => (i * 360) / 24 + 7);

/** 扩展名分组色相（OKLCH）：视频粉、图片绿、音频黄、压缩包紫、文档蓝、代码青 */
const GROUP_HUES = { video: 350, image: 150, audio: 85, archive: 305, doc: 260, code: 205 };

function hueFor(node, index) {
  if (node.type !== 'dir') {
    // 文件：同扩展名同色（WizTree 式），未知扩展名按扩展名散列
    const g = extGroup(node.ext);
    if (GROUP_HUES[g] !== undefined) return GROUP_HUES[g];
    return HUES[hashString('.' + (node.ext || '')) % HUES.length];
  }
  const h = hashString(node.id !== undefined ? 'n' + node.id : node.path || node.name);
  return HUES[(index + h) % HUES.length];
}

/** 与顶层文件块一致的扩展名颜色（侧栏图例 / 列表色条共用） */
export function extColor(ext, type) {
  const dark = getTheme().resolved !== 'light';
  if (type === 'dir') return rgbCss(toneColor(getTheme().hue || 260, 0.075, dark ? 40 : 70));
  if (type === 'link' || type === 'other') return rgbCss(toneColor(0, 0, dark ? 55 : 60));
  return rgbCss(toneColor(hueFor({ type: 'file', ext }, 0), 0.12, dark ? 62 : 55));
}

function joinPath(parent, name) {
  if (!parent) return name || '';
  return parent.endsWith('/') ? parent + name : parent + '/' + name;
}

/**
 * 目录 / 文件在第 depth 层的色调（M3 tone）。
 * 深色主题越深层越亮，浅色主题越深层越暗——内层子块始终比外框更"突出"。
 */
function toneFor(dark, depth, isDir, jitter) {
  if (dark) {
    const dirTone = Math.min(26 + depth * 9, 72);
    return isDir ? dirTone : Math.min(dirTone + 10 + jitter, 86);
  }
  const dirTone = Math.max(84 - depth * 8, 36);
  return isDir ? dirTone : Math.max(dirTone - 9 + jitter, 26);
}

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

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (_) {
    return fallback;
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (r > 0.5 && ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export class TreemapView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts { onSelect(node|null), onOpen(node), onOpenFile(node) }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d', { alpha: false });
    this.opts = opts || {};
    this.roots = [];
    this.tileCount = 0;
    this.children = [];
    this.node = null;
    this.total = 0;
    this.hidden = 0;
    this.truncated = false;
    this.hover = null;
    this.selectedId = null;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this._raf = 0;
    this._tooltipTile = null;
    this.readTheme();

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

  /* ------------------------------- theme ---------------------------- */

  /** 从 CSS 变量读取 Material 主题色（主题切换后调用 refreshTheme） */
  readTheme() {
    const t = getTheme();
    this.theme = {
      dark: t.resolved !== 'light',
      bg: cssVar('--md-surface-container-lowest', '#0e0e11'),
      primary: cssVar('--md-primary', '#aac7ff'),
      onSurface: cssVar('--md-on-surface', '#e3e2e6'),
      onSurfaceVariant: cssVar('--md-on-surface-variant', '#c4c6d0'),
      outline: cssVar('--md-outline', '#8e9099'),
      neutralHue: t.hue || 260,
    };
  }

  refreshTheme() {
    this.readTheme();
    this._layout();
    this._render();
  }

  /* ------------------------------- data ----------------------------- */

  /**
   * @param {{node:Object, children:Array, total?:number, hidden?:number, truncated?:boolean}} data
   *   children 可带嵌套 children（/treemap 接口）；不带时只画一层。
   * @param {{preserve?:boolean}} opts preserve=true 时保留选中状态且不播放淡入
   */
  setData(data, opts = {}) {
    this.node = (data && data.node) || null;
    const children = Array.isArray(data && data.children) ? data.children.slice() : [];
    children.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    this.children = children;
    this.total = typeof data.total === 'number' ? data.total : children.length;
    this.hidden = typeof data.hidden === 'number'
      ? data.hidden
      : Math.max(0, this.total - children.length);
    this.truncated = !!data.truncated;
    this.nested = children.some((c) => Array.isArray(c.children));

    this.hover = null;
    this._hideTooltip();
    this._resize(true);
    if (!opts.preserve && this.canvas.animate) {
      this.canvas.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.2,0,0,1)' });
    }
  }

  setSelected(id) {
    const next = id === undefined || id === null ? null : id;
    if (this.selectedId === next) return;
    this.selectedId = next;
    this._draw();
  }

  /** 第一层可见块数量（不含「其他小项」） */
  getShownCount() {
    return this.roots.filter((t) => !t.rest).length;
  }

  /** 已绘制的全部块数量（含嵌套） */
  getTileCount() {
    return this.tileCount;
  }

  /** 画布面积（CSS px²），用于向后端请求合适的嵌套精度 */
  getArea() {
    return Math.max(0, this.cssW * this.cssH);
  }

  /* ------------------------------ sizing ---------------------------- */

  _measure() {
    const host = this.canvas.parentElement || this.canvas;
    const rect = host.getBoundingClientRect();
    const w = Math.max(0, Math.floor(rect.width));
    const h = Math.max(0, Math.floor(rect.height));
    const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    if (this.base.width !== pw || this.base.height !== ph) {
      this.base.width = pw;
      this.base.height = ph;
    }
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    return w !== 0 && h !== 0;
  }

  _resize(force = false) {
    const prevW = this.cssW;
    const prevH = this.cssH;
    const prevDpr = this.dpr;
    const ok = this._measure();
    if (!ok) return;
    if (force || prevW !== this.cssW || prevH !== this.cssH || prevDpr !== this.dpr) {
      this._layout();
      this._render();
    } else {
      this._draw();
    }
  }

  /* ------------------------------ layout ---------------------------- */

  _layout() {
    this.tileCount = 0;
    this.roots = [];
    if (!this.node || !this.cssW || !this.cssH) return;
    this.roots = this._layoutLevel(
      this.node, this.children, this.hidden,
      { x: 0, y: 0, w: this.cssW, h: this.cssH }, 0, null,
    );
  }

  /**
   * 在 rect 内布局 parent 的子项，返回 tile 数组；目录递归布局到其内部。
   * 未展示的小子项（parent.size - Σchildren）合并成一个「其他」块。
   */
  _layoutLevel(parent, kids, hiddenCount, rect, depth, parentTile) {
    const items = [];
    let sum = 0;
    for (const n of kids) {
      const v = Number(n.size) || 0;
      if (v <= 0) continue;
      sum += v;
      items.push({ node: n, value: v });
    }
    const parentSize = Number(parent.size) || 0;
    const rest = parentSize - sum;
    if (rest > 0 && rest > parentSize * 1e-4 && (items.length > 0 || hiddenCount > 0)) {
      items.push({ node: null, value: rest, rest: true });
    }
    if (!items.length) return [];

    const laid = squarify(items, rect.x, rect.y, rect.w, rect.h);
    const dark = this.theme.dark;
    const gap = depth === 0 ? 1 : 0.5;
    const out = [];
    let idx = 0;
    for (const t of laid) {
      if (!(t.w > 0) || !(t.h > 0)) continue;
      const dx = t.x + gap;
      const dy = t.y + gap;
      const dw = t.w - gap * 2;
      const dh = t.h - gap * 2;
      if (dw < 0.6 || dh < 0.6) continue;

      const tile = {
        x: t.x, y: t.y, w: t.w, h: t.h,
        dx, dy, dw, dh,
        depth,
        parent: parentTile,
        parentNode: parent,
        rest: !!t.rest,
        node: null,
        children: null,
        header: false,
        hue: 0,
        tone: 0,
        fill: '',
        ink: '',
      };

      if (t.rest) {
        const count = hiddenCount > 0 ? hiddenCount : 0;
        tile.node = {
          id: '__rest__' + (parent.id !== undefined ? parent.id : ''),
          agg: true,
          name: count > 0 ? `其他 ${formatNumber(count)} 个小项` : '其他小项',
          size: rest,
          restCount: count,
          type: 'other',
          path: parent.path || '',
        };
        tile.hue = parentTile ? parentTile.hue : this.theme.neutralHue;
        tile.tone = toneFor(dark, depth, false, 0) + (dark ? -6 : 6);
        tile.fill = rgbCss(toneColor(tile.hue, parentTile ? 0.025 : 0.01, tile.tone));
      } else {
        const n = t.node;
        if (!n.path && parent.path) n.path = joinPath(parent.path, n.name || '');
        if (n.parentId === undefined && parent.id !== undefined) n.parentId = parent.id;
        tile.node = n;
        tile.hue = parentTile ? parentTile.hue : hueFor(n, idx);
        const isDir = n.type === 'dir';
        const jitter = isDir ? 0 : ((hashString(n.name || '') % 9) - 4);
        tile.tone = toneFor(dark, depth, isDir, jitter);
        const chroma = n.type === 'link' || n.type === 'other' ? 0.02 : (isDir ? 0.075 : 0.12);
        tile.fill = rgbCss(toneColor(tile.hue, chroma, tile.tone));
        idx++;

        const sub = isDir && Array.isArray(n.children) ? n.children : null;
        if (sub && (sub.length || n.hidden) && dw >= NEST_MIN && dh >= NEST_MIN) {
          let inner;
          if (dw >= HEADER_MIN_W && dh >= HEADER_MIN_H) {
            tile.header = true;
            inner = { x: dx + 3, y: dy + HEADER_H, w: dw - 6, h: dh - HEADER_H - 3 };
          } else {
            inner = { x: dx + 2, y: dy + 2, w: dw - 4, h: dh - 4 };
          }
          if (inner.w >= 3 && inner.h >= 3) {
            const hid = typeof n.hidden === 'number' ? n.hidden : Math.max(0, (n.childCount || 0) - sub.length);
            tile.children = this._layoutLevel(n, sub, hid, inner, depth + 1, tile);
            if (!tile.children.length) tile.children = null;
          }
          if (!tile.children) tile.header = false;
        }
      }
      tile.ink = tile.tone >= 60 ? 'rgba(0,0,0,0.86)' : 'rgba(255,255,255,0.95)';
      tile.inkSoft = tile.tone >= 60 ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.72)';
      this.tileCount++;
      out.push(tile);
    }
    return out;
  }

  /* ------------------------------- draw ----------------------------- */

  /** 把全部色块画到离屏底图；hover/选中只在 _draw 中叠加 */
  _render() {
    const ctx = this.baseCtx;
    if (!ctx) return;
    const w = this.cssW;
    const h = this.cssH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, w, h);
    if (this.roots.length) {
      const stack = this.roots.slice().reverse();
      while (stack.length) {
        const tile = stack.pop();
        this._drawTile(ctx, tile);
        if (tile.children) {
          for (let i = tile.children.length - 1; i >= 0; i--) stack.push(tile.children[i]);
        }
      }
    }
    this._draw();
  }

  _drawTile(ctx, tile) {
    const { dx, dy, dw, dh } = tile;
    const small = dw < 6 || dh < 6;
    const r = small ? 0 : Math.min(tile.depth === 0 ? 8 : 4, dw / 4, dh / 4);
    ctx.fillStyle = tile.fill;
    if (r > 0.5) {
      roundRectPath(ctx, dx, dy, dw, dh, r);
      ctx.fill();
    } else {
      ctx.fillRect(dx, dy, dw, dh);
    }

    if (tile.header) {
      this._drawHeader(ctx, tile);
    } else if (!tile.children && dw >= 50 && dh >= 22) {
      this._drawLabel(ctx, tile);
    }
  }

  _drawHeader(ctx, tile) {
    const n = tile.node;
    const pad = 6;
    const maxW = tile.dw - pad * 2;
    if (maxW < 20) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tile.dx, tile.dy, tile.dw, HEADER_H);
    ctx.clip();
    ctx.textBaseline = 'middle';
    ctx.font = `500 11.5px ${FONT}`;
    const sizeText = formatBytes(n.size);
    const sizeW = ctx.measureText(sizeText).width;
    const nameW = maxW - (sizeW + 8 <= maxW * 0.5 ? sizeW + 8 : 0);
    ctx.fillStyle = tile.ink;
    const nameText = fitText(ctx, n.name || n.path || '', nameW);
    const cy = tile.dy + HEADER_H / 2 + 0.5;
    if (nameText) ctx.fillText(nameText, tile.dx + pad, cy);
    if (nameW < maxW) {
      ctx.font = `400 10.5px ${FONT}`;
      ctx.fillStyle = tile.inkSoft;
      ctx.textAlign = 'right';
      ctx.fillText(sizeText, tile.dx + tile.dw - pad, cy);
    }
    ctx.restore();
  }

  _drawLabel(ctx, tile) {
    const n = tile.node;
    const pad = 6;
    const maxW = tile.dw - pad * 2;
    if (maxW < 22) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tile.dx + 1, tile.dy + 1, tile.dw - 2, tile.dh - 2);
    ctx.clip();
    ctx.textBaseline = 'top';
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = tile.ink;
    const nameText = fitText(ctx, n.name || n.path || '', maxW);
    if (nameText) ctx.fillText(nameText, tile.dx + pad, tile.dy + pad);
    if (tile.dh >= 38 && tile.dw >= 56) {
      ctx.font = `400 11px ${FONT}`;
      ctx.fillStyle = tile.inkSoft;
      const sizeText = fitText(ctx, formatBytes(n.size), maxW);
      if (sizeText) ctx.fillText(sizeText, tile.dx + pad, tile.dy + pad + 17);
    }
    ctx.restore();
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.cssW;
    const h = this.cssH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.base.width && this.base.height) ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (!this.roots.length) {
      ctx.fillStyle = this.theme.bg;
      ctx.fillRect(0, 0, w, h);
      this._drawEmpty(ctx, w, h, this.children.length > 0);
      return;
    }

    const selectedTile = this.selectedId !== null ? this._findTile(this.selectedId) : null;
    if (this.hover && this.hover !== selectedTile) {
      // 悬停：父链淡描边 + 目标块状态层
      for (let p = this.hover.parent; p; p = p.parent) {
        this._strokeTile(ctx, p, this.theme.dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)', 1, false);
      }
      ctx.fillStyle = this.theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
      roundRectPath(ctx, this.hover.dx, this.hover.dy, this.hover.dw, this.hover.dh, this._radius(this.hover));
      ctx.fill();
      this._strokeTile(ctx, this.hover, this.theme.onSurface, 1.5, false);
    }
    if (selectedTile) {
      this._strokeTile(ctx, selectedTile, this.theme.primary, 2.5, true);
    }
  }

  _radius(tile) {
    if (tile.dw < 6 || tile.dh < 6) return 0;
    return Math.min(tile.depth === 0 ? 8 : 4, tile.dw / 4, tile.dh / 4);
  }

  _strokeTile(ctx, tile, color, width, glow) {
    const inset = width / 2;
    const w = tile.dw - width;
    const h = tile.dh - width;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    roundRectPath(ctx, tile.dx + inset, tile.dy + inset, w, h, Math.max(0, this._radius(tile) - inset));
    ctx.stroke();
    ctx.restore();
  }

  _findTile(id) {
    const stack = this.roots.slice();
    while (stack.length) {
      const t = stack.pop();
      if (!t.rest && t.node.id === id) return t;
      if (t.children) for (const c of t.children) stack.push(c);
    }
    return null;
  }

  _drawEmpty(ctx, w, h, hasChildren) {
    if (w < 80 || h < 60) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.theme.onSurface;
    ctx.font = `500 14px ${FONT}`;
    ctx.fillText(hasChildren ? '无可显示的占用空间' : '此目录为空', w / 2, h / 2 - 10);
    ctx.fillStyle = this.theme.onSurfaceVariant;
    ctx.font = `12px ${FONT}`;
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

  /** 命中最深一层的块 */
  _hit(x, y) {
    let list = this.roots;
    let found = null;
    while (list) {
      let next = null;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) {
          next = t;
          break;
        }
      }
      if (!next) break;
      found = next;
      list = next.children;
    }
    return found;
  }

  _handleMove(e) {
    if (!this.roots.length) return;
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
    if (tile.rest) return;
    this.selectedId = tile.node.id;
    this._draw();
    if (this.opts.onSelect) this.opts.onSelect(tile.node);
  }

  _handleDblClick(e) {
    const p = this._localPoint(e);
    let tile = this._hit(p.x, p.y);
    if (!tile) return;
    // 「其他小项」或嵌套内的文件：进入其所在目录
    if (tile.rest || tile.node.type !== 'dir') {
      if (!tile.rest && !tile.parent && this.opts.onOpenFile) {
        this.opts.onOpenFile(tile.node);
        return;
      }
      tile = tile.parent;
      if (!tile) return;
    }
    if (this.opts.onOpen) this.opts.onOpen(tile.node);
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
      ['view', '占当前目录'],
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
    const parentSize = (tile.parentNode && tile.parentNode.size) || 0;
    const viewSize = (this.node && this.node.size) || 0;
    tt.rows.size.textContent = formatBytes(n.size);
    tt.rows.pct.textContent = formatPercent(ratio(n.size, parentSize));
    tt.rows.view.textContent = formatPercent(ratio(n.size, viewSize));
    if (tile.rest) {
      tt.name.textContent = n.name;
      tt.path.textContent = n.path ? `位于 ${n.path}` : '';
      tt.rows.count.textContent = n.restCount ? formatNumber(n.restCount) + ' 项' : '—';
      tt.rows.mtime.textContent = '—';
      tt.hint.textContent = '体积过小无法单独绘制，已合并 · 双击进入所在目录';
      return;
    }
    tt.name.textContent = n.name || n.path || '';
    tt.path.textContent = n.path || '';
    tt.rows.count.textContent = formatNumber(n.count);
    tt.rows.mtime.textContent = formatTime(n.mtime);
    if (n.type === 'dir') {
      tt.hint.textContent = n.mount ? '跨文件系统挂载点（未深入扫描）' : '单击选中 · 双击进入此目录';
    } else {
      tt.hint.textContent = tile.parent ? '单击选中 · 双击进入所在目录' : '单击选中 · 双击定位到列表';
    }
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
