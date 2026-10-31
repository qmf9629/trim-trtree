/**
 * table.js — 虚拟滚动表格（可视区 ±10 行）
 * 支持：静态数据 / 服务端分页双模式、排序、选中、双击。
 * 所有单元格内容由 render 回调通过 textContent / createElement 写入。
 */

import { el, clear, icon } from './format.js';

const OVERSCAN = 10;

export class VirtualTable {
  /**
   * @param {HTMLElement} root 容器（会被清空）
   * @param {Object} opts { columns, rowHeight, pageSize, sort, dir, onSort, onRowClick,
   *                        onRowDblClick, emptyText, loadingText }
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.columns = opts.columns || [];
    this.rowHeight = opts.rowHeight || 34;
    this.pageSize = opts.pageSize || 200;
    this.sort = opts.sort || null;
    this.dir = opts.dir || 'desc';
    this.template = this.columns.map((c) => c.width || '1fr').join(' ');

    this.mode = 'static';
    this.rows = [];
    this.total = 0;
    this.fetcher = null;
    this.pages = new Set();
    this.pending = new Set();
    this.failed = new Set();
    this.gen = 0;
    this.selectedId = null;
    this.error = null;
    this.loading = false;
    this._raf = 0;
    this._emptyText = opts.emptyText || '暂无数据';
    this._start = -1;
    this._end = -1;

    this._build();
    this._ro = new ResizeObserver(() => this._schedule());
    this._ro.observe(root);
  }

  /* ------------------------------- build ----------------------------- */

  _build() {
    const root = this.root;
    clear(root);
    root.classList.add('vt');

    const head = el('div', 'vt-head');
    this.headRow = el('div', 'vt-head-row');
    this.headRow.style.gridTemplateColumns = this.template;
    for (const col of this.columns) {
      const th = el('div', 'vt-th' + (col.align === 'right' ? ' ta-r' : '') + (col.sortable ? ' sortable' : ''));
      const label = el('span', 'vt-th-label', col.label);
      th.appendChild(label);
      if (col.sortable) {
        const arrow = el('span', 'vt-sort', '');
        th.appendChild(arrow);
        th.addEventListener('click', () => this._handleSort(col));
      }
      this.headRow.appendChild(th);
    }
    head.appendChild(this.headRow);

    this.viewport = el('div', 'vt-viewport');
    this.spacer = el('div', 'vt-spacer');
    this.rowsLayer = el('div', 'vt-rows');
    this.spacer.appendChild(this.rowsLayer);
    this.viewport.appendChild(this.spacer);
    this.status = el('div', 'vt-status');
    this.status.hidden = true;

    root.appendChild(head);
    root.appendChild(this.viewport);
    root.appendChild(this.status);

    this.viewport.addEventListener('scroll', () => this._schedule(), { passive: true });
    this._setSortIndicator();
    this._updateStatus();
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._render();
    });
  }

  /* -------------------------------- data ----------------------------- */

  setStatic(items) {
    this.mode = 'static';
    this.gen++;
    this.rows = Array.isArray(items) ? items.slice() : [];
    this.total = this.rows.length;
    this.loading = false;
    this.error = null;
    this.fetcher = null;
    this.pages = new Set();
    this.pending = new Set();
    this.failed = new Set();
    this.viewport.scrollTop = 0;
    this.selectedId = null;
    this._render(true);
  }

  /**
   * 服务端分页模式：只加载可视区域附近的分页。
   * @param {number} total 总行数（过滤后）
   * @param {(offset:number, limit:number)=>Promise<Array>} fetcher
   * @param {Array} firstPage 首页数据（可省略）
   */
  setPaged(total, fetcher, firstPage) {
    this.mode = 'paged';
    this.gen++;
    this.total = Math.max(0, Number(total) || 0);
    this.rows = new Array(this.total).fill(null);
    this.fetcher = fetcher;
    this.pages = new Set();
    this.pending = new Set();
    this.failed = new Set();
    this.loading = false;
    this.error = null;
    this.viewport.scrollTop = 0;
    this.selectedId = null;
    if (Array.isArray(firstPage) && firstPage.length) {
      const n = Math.min(firstPage.length, this.total);
      for (let i = 0; i < n; i++) this.rows[i] = firstPage[i];
      this.pages.add(0);
    }
    this._render(true);
  }

  setLoading(v) {
    this.loading = !!v;
    this._updateStatus();
  }

  setError(msg) {
    this.error = msg || '加载失败';
    this.loading = false;
    this._updateStatus();
  }

  setEmptyText(text) {
    this._emptyText = text || '暂无数据';
    this._updateStatus();
  }

  setSort(key, dir) {
    this.sort = key;
    this.dir = dir || 'desc';
    this._setSortIndicator();
  }

  setSelected(id) {
    this.selectedId = id === undefined ? null : id;
    if (!this.rowsLayer) return;
    for (const row of this.rowsLayer.children) {
      if (!row.dataset.id) continue;
      row.classList.toggle('sel', row.dataset.id === String(this.selectedId));
    }
  }

  scrollToIndex(index) {
    if (!this.viewport) return;
    const h = this.rowHeight;
    this.viewport.scrollTop = Math.max(0, index * h - Math.floor(this.viewport.clientHeight / 2));
    this._schedule();
  }

  clearSelection() {
    this.setSelected(null);
  }

  /* ------------------------------- render ---------------------------- */

  _handleSort(col) {
    let dir;
    if (this.sort === col.key) dir = this.dir === 'desc' ? 'asc' : 'desc';
    else dir = col.defaultDir || (col.align === 'right' ? 'desc' : 'asc');
    this.sort = col.key;
    this.dir = dir;
    this._setSortIndicator();
    if (this.opts.onSort) this.opts.onSort(col.key, dir);
  }

  _setSortIndicator() {
    if (!this.headRow) return;
    const cells = this.headRow.children;
    for (let i = 0; i < cells.length; i++) {
      const col = this.columns[i];
      const th = cells[i];
      const arrow = th.querySelector('.vt-sort');
      th.classList.toggle('sorted', !!col.sortable && this.sort === col.key);
      if (arrow) {
        if (col.sortable && this.sort === col.key) arrow.textContent = this.dir === 'asc' ? '▲' : '▼';
        else arrow.textContent = '';
      }
    }
  }

  _updateStatus() {
    if (!this.status) return;
    if (this.loading) {
      this.status.hidden = false;
      this.status.className = 'vt-status loading';
      clear(this.status);
      this.status.appendChild(el('span', 'spinner'));
      this.status.appendChild(el('span', '', this.opts.loadingText || '加载中…'));
      return;
    }
    if (this.error) {
      this.status.hidden = false;
      this.status.className = 'vt-status error';
      clear(this.status);
      this.status.appendChild(icon('alert'));
      this.status.appendChild(el('span', '', this.error));
      return;
    }
    if (this.total === 0) {
      this.status.hidden = false;
      this.status.className = 'vt-status empty';
      clear(this.status);
      this.status.appendChild(icon('list'));
      this.status.appendChild(el('span', '', this._emptyText));
      return;
    }
    this.status.hidden = true;
  }

  _render(force = false) {
    if (!this.viewport) return;
    const vh = this.viewport.clientHeight || 300;
    const st = this.viewport.scrollTop || 0;
    const start = Math.max(0, Math.floor(st / this.rowHeight) - OVERSCAN);
    const end = Math.min(this.total, Math.ceil((st + vh) / this.rowHeight) + OVERSCAN);

    this._ensurePages(start, Math.min(this.total, end + OVERSCAN));

    if (!force && start === this._start && end === this._end) {
      this._updateStatus();
      return;
    }
    this._start = start;
    this._end = end;
    clear(this.rowsLayer);
    this.spacer.style.height = Math.max(0, this.total * this.rowHeight) + 'px';

    for (let i = start; i < end; i++) {
      const node = this.rows[i];
      const row = node ? this._makeRow(node, i) : this._makePendingRow(i);
      this.rowsLayer.appendChild(row);
    }
    this._updateStatus();
  }

  _makePendingRow(index) {
    const row = el('div', 'vt-row vt-row-pending');
    row.style.top = index * this.rowHeight + 'px';
    row.style.height = this.rowHeight + 'px';
    row.style.gridTemplateColumns = this.template;
    const cellCount = Math.min(3, this.columns.length);
    for (let i = 0; i < cellCount; i++) {
      const cell = el('div', 'vt-cell');
      cell.appendChild(el('span', 'skel'));
      row.appendChild(cell);
    }
    return row;
  }

  _makeRow(node, index) {
    const row = el('div', 'vt-row');
    row.dataset.id = String(node.id);
    row.style.top = index * this.rowHeight + 'px';
    row.style.height = this.rowHeight + 'px';
    row.style.gridTemplateColumns = this.template;
    if (String(node.id) === String(this.selectedId)) row.classList.add('sel');
    if (node.path) row.title = node.path;

    for (const col of this.columns) {
      const cell = el('div', 'vt-cell' + (col.align === 'right' ? ' ta-r' : '') + (col.cls ? ' ' + col.cls : ''));
      try {
        if (col.render) col.render(node, cell, this, index);
        else cell.textContent = col.get ? col.get(node) : '';
      } catch (err) {
        cell.textContent = '—';
      }
      row.appendChild(cell);
    }

    row.addEventListener('click', () => {
      this.setSelected(node.id);
      if (this.opts.onRowClick) this.opts.onRowClick(node, index);
    });
    row.addEventListener('dblclick', () => {
      if (this.opts.onRowDblClick) this.opts.onRowDblClick(node, index);
    });
    return row;
  }

  _ensurePages(start, end) {
    if (this.mode !== 'paged' || typeof this.fetcher !== 'function') return;
    if (!(this.total > 0)) return;
    const ps = this.pageSize;
    const lastPage = Math.ceil(this.total / ps) - 1;
    const p0 = Math.max(0, Math.floor(start / ps));
    const p1 = Math.min(lastPage, Math.floor(Math.max(0, end - 1) / ps));
    for (let p = p0; p <= p1; p++) {
      if (this.pages.has(p) || this.pending.has(p) || this.failed.has(p)) continue;
      const offset = p * ps;
      const limit = Math.min(ps, this.total - offset);
      if (limit <= 0) continue;
      this.pending.add(p);
      const gen = this.gen;
      Promise.resolve()
        .then(() => this.fetcher(offset, limit))
        .then((items) => {
          if (gen !== this.gen) return;
          this.pending.delete(p);
          this.pages.add(p);
          const arr = Array.isArray(items) ? items : [];
          for (let k = 0; k < arr.length && offset + k < this.total; k++) this.rows[offset + k] = arr[k];
          this._render(true);
        })
        .catch((err) => {
          if (gen !== this.gen) return;
          this.pending.delete(p);
          this.failed.add(p);
          this.error = (err && err.message) ? err.message : '分页数据加载失败';
          this._updateStatus();
        });
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
