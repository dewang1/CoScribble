(() => {
  'use strict';

  if (window.__waInjected) return;
  window.__waInjected = true;

  const api = globalThis.browser || globalThis.chrome;

  function newId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }

  // Storage key + page state
 
  function storageKeyForThisPage() {
    const url = new URL(location.href);
 
    const EXACT_TRACKING_PARAMS = new Set([
      'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'ttclid', 'yclid',
      'mc_cid', 'mc_eid', 'igshid', 'mkt_tok', '_hsenc', '_hsmi', 'vero_id',
      'ref', 'ref_src', 'ref_url', 'srsltid', 'gbraid', 'wbraid', 'gad_source',
    ]);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || EXACT_TRACKING_PARAMS.has(key)) {
        url.searchParams.delete(key);
      }
    }

    url.searchParams.sort();
 
    const looksLikeRouteHash = /^#\/|^#!/.test(url.hash);
    const hashPart = looksLikeRouteHash ? url.hash : '';
 
    return `wa:${url.origin}${url.pathname}${url.search}${hashPart}`;
  }
 
  const PAGE_KEY = storageKeyForThisPage();
 
  let pageData = { highlights: [], drawings: [] };
  let pageDataLoaded = false;
 
  async function loadPageData() {
    const stored = await api.storage.local.get(PAGE_KEY);
    pageData = stored[PAGE_KEY] || { highlights: [], drawings: [] };
    pageDataLoaded = true;
  }
 
  async function savePageData() {
    await api.storage.local.set({ [PAGE_KEY]: pageData });
  }

  // Undo / redo history

  const HISTORY_LIMIT = 50;
  let undoStack = [];
  let redoStack = [];

  function snapshotState() {
    return JSON.parse(JSON.stringify({ highlights: pageData.highlights, drawings: pageData.drawings }));
  }

  function pushHistory() {
    undoStack.push(snapshotState());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  }

  async function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshotState());
    const prev = undoStack.pop();
    pageData.highlights = prev.highlights;
    pageData.drawings = prev.drawings;
    await savePageData();
    renderAllHighlights();
    renderAllDrawings();
  }

  async function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshotState());
    const next = redoStack.pop();
    pageData.highlights = next.highlights;
    pageData.drawings = next.drawings;
    await savePageData();
    renderAllHighlights();
    renderAllDrawings();
  }

  // Text anchoring

  function getFullText() {
    const r = document.createRange();
    r.selectNodeContents(document.body);
    return r.toString();
  }

  function globalOffsetOf(container, offset) {
    const r = document.createRange();
    r.setStart(document.body, 0);
    r.setEnd(container, offset);
    return r.toString().length;
  }

  function locateOffset(target) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (acc + len >= target) return { node, offset: target - acc };
      acc += len;
    }
    return null;
  }

  function buildAnchorFromOffsets(startOffset, endOffset) {
    const fullText = getFullText();
    const CONTEXT = 32;
    return {
      startOffset,
      endOffset,
      quote: {
        exact: fullText.slice(startOffset, endOffset),
        prefix: fullText.slice(Math.max(0, startOffset - CONTEXT), startOffset),
        suffix: fullText.slice(endOffset, endOffset + CONTEXT),
      },
    };
  }

  // Builds a DOM Range directly from known-good global text offsets
  function rangeFromOffsets(startOffset, endOffset) {
    const startPos = locateOffset(startOffset);
    const endPos = locateOffset(endOffset);
    if (!startPos || !endPos) return null;
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    return range;
  }

  // Subtracts a set of occupied intervals from a new interval, returning the leftover pieces.
  // New highlight never overlaps existing ones. Only new text becomes part of the new highlights.
  function subtractIntervals(start, end, occupied) {
    let pieces = [[start, end]];
    occupied.forEach(([occStart, occEnd]) => {
      const next = [];
      pieces.forEach(([s, e]) => {
        if (occEnd <= s || occStart >= e) {
          next.push([s, e]);
          return;
        }
        if (occStart > s) next.push([s, occStart]);
        if (occEnd < e) next.push([occEnd, e]);
      });
      pieces = next;
    });
    return pieces.filter(([s, e]) => e > s);
  }

  function resolveAnchorToRange(anchor) {
    const fullText = getFullText();
    const { startOffset, endOffset, quote } = anchor;

    const directMatch =
      startOffset != null &&
      endOffset != null &&
      fullText.slice(startOffset, endOffset) === quote.exact;

    let resolvedStart = null;
    let resolvedEnd = null;

    if (directMatch) {
      resolvedStart = startOffset;
      resolvedEnd = endOffset;
    } else if (quote.exact) {
      const candidates = [];
      let idx = fullText.indexOf(quote.exact);
      while (idx !== -1) {
        candidates.push(idx);
        idx = fullText.indexOf(quote.exact, idx + 1);
      }
      if (candidates.length === 1) {
        resolvedStart = candidates[0];
        resolvedEnd = candidates[0] + quote.exact.length;
      } else if (candidates.length > 1) {
        let best = null;
        let bestScore = -1;
        for (const c of candidates) {
          const prefix = fullText.slice(Math.max(0, c - 32), c);
          const suffix = fullText.slice(c + quote.exact.length, c + quote.exact.length + 32);
          let score = 0;
          if (prefix.endsWith(quote.prefix)) score += 2;
          if (suffix.startsWith(quote.suffix)) score += 2;
          if (score > bestScore) {
            bestScore = score;
            best = c;
          }
        }
        resolvedStart = best;
        resolvedEnd = best + quote.exact.length;
      }
    }

    if (resolvedStart == null) return null;

    const startPos = locateOffset(resolvedStart);
    const endPos = locateOffset(resolvedEnd);
    if (!startPos || !endPos) return null;

    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    return range;
  }

  // Highlight rendering

  function getTextNodesInRange(range) {
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
      root.nodeType === Node.TEXT_NODE ? root.parentNode : root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      }
    );
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function selectionIntersectsToolbar(range) {
    const toolbar = document.querySelector('#wa-toolbar-host');
    if (!toolbar) return false;
    const textNodes = getTextNodesInRange(range);
    return textNodes.some((node) => {
      const parent = node.parentElement;
      return Boolean(parent && toolbar.contains(parent));
    });
  }

  function setHighlightHover(id, on) {
    document.querySelectorAll(`span.wa-highlight[data-wa-id="${id}"]`).forEach((s) => {
      s.classList.toggle('wa-hl-hover', on);
    });
    const icon = document.querySelector(`.wa-note-icon[data-wa-id="${id}"]`);
    if (icon) icon.classList.toggle('wa-hl-hover', on);
  }

  function paintHighlight(range, id, color) {
    const textNodes = getTextNodesInRange(range);
    const spans = [];

    textNodes.forEach((node) => {
      if (!node.parentNode) return;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.textContent.length;
      if (start === end) return;

      let wrapNode = node;
      let selectedNode = null;

      try {
        if (start > 0 && end < node.textContent.length) {
          const afterStart = node.splitText(start);
          selectedNode = afterStart.splitText(end - start);
          wrapNode = afterStart;
        } else if (start > 0) {
          wrapNode = node.splitText(start);
        } else if (end < node.textContent.length) {
          selectedNode = node.splitText(end);
          wrapNode = node;
        }

        const span = document.createElement('span');
        span.className = 'wa-highlight';
        span.dataset.waId = id;
        span.style.backgroundColor = color;

        const parent = wrapNode.parentNode;
        parent.insertBefore(span, wrapNode);
        span.appendChild(wrapNode);
        spans.push(span);

        if (selectedNode && selectedNode.parentNode) {
          selectedNode.parentNode.normalize();
        }
      } catch (err) {
        console.warn('Failed to paint highlight fragment:', err);
      }
    });

    spans.forEach((span) => {
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        openNotePopover(id, span);
      });
      span.addEventListener('mouseenter', () => setHighlightHover(id, true));
      span.addEventListener('mouseleave', () => setHighlightHover(id, false));
    });
    return spans;
  }

  function positionNoteIcon(icon, lastSpan) {
    const rect = lastSpan.getBoundingClientRect();
    icon.style.top = `${rect.top + window.scrollY + rect.height / 2 - 7.5}px`;
    icon.style.left = `${rect.right + window.scrollX + 3}px`;
  }

  function buildNoteIcon(id, lastSpan) {
    const icon = document.createElement('span');
    icon.className = 'wa-note-icon';
    icon.dataset.waId = id;
    icon.title = 'Has a note — click to view';
    icon.innerHTML =
      '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M3 4h14v9H8l-4 3.5V13H3V4z" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linejoin="round" stroke-linecap="round"/></svg>';
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      openNotePopover(id, icon);
    });
    icon.addEventListener('mouseenter', () => setHighlightHover(id, true));
    icon.addEventListener('mouseleave', () => setHighlightHover(id, false));
    
    icon.style.zIndex = '2147483645';
    document.documentElement.appendChild(icon);
    positionNoteIcon(icon, lastSpan);
    return icon;
  }

  function clearRenderedAnnotations() {
    document.querySelectorAll('span.wa-highlight').forEach((span) => {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    });
    document.querySelectorAll('.wa-note-icon').forEach((el) => el.remove());
  }

  function removeHighlight(id) {
    document.querySelectorAll(`span.wa-highlight[data-wa-id="${id}"]`).forEach((span) => {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    });
    document.querySelectorAll(`.wa-note-icon[data-wa-id="${id}"]`).forEach((el) => el.remove());
  }

  function renderAllHighlights() {
    clearRenderedAnnotations();
    pageData.highlights.forEach((h) => {
      const range = resolveAnchorToRange(h.anchor);
      if (!range) {
        h.orphaned = true;
        return;
      }
      h.orphaned = false;
      const spans = paintHighlight(range, h.id, h.color);
      if (h.note && spans.length) {
        buildNoteIcon(h.id, spans[spans.length - 1]);
      }
    });
  }

  // Note popover

  let activePopover = null;

  function closePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  function openNotePopover(id, anchorEl) {
    closePopover();
    const highlight = pageData.highlights.find((h) => h.id === id);
    if (!highlight) return;

    const rect = anchorEl.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'wa-popover';
    pop.style.zIndex = '2147483646';
    pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
    pop.style.left = `${Math.min(rect.left + window.scrollX, document.documentElement.scrollWidth - 260)}px`;

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add a note...';
    textarea.value = highlight.note || '';

    const row = document.createElement('div');
    row.className = 'wa-popover-row';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'wa-close';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = closePopover;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'wa-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = async () => {
      pushHistory();
      pageData.highlights = pageData.highlights.filter((h) => h.id !== id);
      removeHighlight(id);
      rtSend({ type: 'delete_highlight', id });
      await savePageData();
      closePopover();
    };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'wa-save';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = async () => {
      pushHistory();
      highlight.note = textarea.value.trim();
      highlight.updatedAt = Date.now();
      rtSend({ type: 'update_note', id: highlight.id, note: highlight.note, updatedAt: highlight.updatedAt });
      await savePageData();
      renderAllHighlights();
      closePopover();
    };

    row.append(closeBtn, deleteBtn, saveBtn);
    pop.append(textarea, row);
    
    document.documentElement.appendChild(pop);
    activePopover = pop;
    textarea.focus();
  }

  document.addEventListener('click', (e) => {
    if (activePopover && !activePopover.contains(e.target)) closePopover();
  });

  // Color picker helpers 

  let normalizeCtx = null;
  function toHexColor(cssColor) {
    if (!cssColor) return '#000000';
    if (!normalizeCtx) normalizeCtx = document.createElement('canvas').getContext('2d');
    try {
      normalizeCtx.fillStyle = '#000000';
      normalizeCtx.fillStyle = cssColor;
      return normalizeCtx.fillStyle;
    } catch (e) {
      return '#000000';
    }
  }

  // Drawing overlay

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let drawLayer = null;
  let resizeObserverAttached = false;

  let currentDrawTool = 'pencil'; // pencil | line | rect | ellipse |erase
  let drawColor = '#fde047';
  let drawOpacity = 1;
  let radius = 12;

  // Make stroke radius consistent with eraser radius
  function strokeWidthFromRadius() {
    return radius * 2;
  }

  function ensureDrawLayer() {
    if (drawLayer) return drawLayer;
    drawLayer = document.createElementNS(SVG_NS, 'svg');
    drawLayer.id = 'wa-draw-layer';

    drawLayer.style.cssText = 'position: absolute; top: 0; left: 0; z-index: 2147483645;';
    
    document.documentElement.appendChild(drawLayer);
    
    resizeDrawLayer();
    if (!resizeObserverAttached) {
      const debouncedResize = debounce(resizeDrawLayer, 250);
      window.addEventListener('resize', debouncedResize);
      new MutationObserver(debouncedResize).observe(document.body, { childList: true, subtree: true });
      resizeObserverAttached = true;
    }
    return drawLayer;
  }

  function destroyDrawLayer() {
    if (drawLayer) drawLayer.remove();
    drawLayer = null;
    radiusPreviewEl = null;
  }

  // Dashed circle radius preview

  let radiusPreviewEl = null;

  function ensureRadiusPreview() {
    if (radiusPreviewEl) return radiusPreviewEl;
    const layer = ensureDrawLayer();
    radiusPreviewEl = document.createElementNS(SVG_NS, 'circle');
    radiusPreviewEl.id = 'wa-radius-preview';
    radiusPreviewEl.setAttribute('fill', 'none');
    radiusPreviewEl.setAttribute('stroke', '#111827');
    radiusPreviewEl.setAttribute('stroke-width', '1');
    radiusPreviewEl.setAttribute('stroke-dasharray', '3 2');
    radiusPreviewEl.style.pointerEvents = 'none';
    radiusPreviewEl.style.display = 'none';
    layer.appendChild(radiusPreviewEl);
    return radiusPreviewEl;
  }

  function updateRadiusPreviewGeometry() {
    if (!radiusPreviewEl) return;
    radiusPreviewEl.setAttribute('r', String(radius));
  }

  function updateRadiusPreviewVisibility() {
    const show = mode === 'draw' && (currentDrawTool === 'pencil' || currentDrawTool === 'erase');
    const el = ensureRadiusPreview();
    el.style.display = show ? '' : 'none';
    updateRadiusPreviewGeometry();
  }

  function moveRadiusPreview(p) {
    const el = ensureRadiusPreview();
    el.setAttribute('cx', p.x);
    el.setAttribute('cy', p.y);
    if (el.parentNode) {
      el.parentNode.appendChild(el);
    }
  }

  function resizeDrawLayer() {
    if (!drawLayer) return;
    const w = document.documentElement.scrollWidth;
    const h = document.documentElement.scrollHeight;
    drawLayer.setAttribute('width', w);
    drawLayer.setAttribute('height', h);
    drawLayer.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  const debouncedReflow = debounce(() => {
    resizeDrawLayer();
    if (enabled) renderAllHighlights();
  }, 200);
  window.addEventListener('resize', debouncedReflow);

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function pointsToPathD(points) {
    if (!points.length) return '';
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  }

  function pointDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function renderDrawing(d) {
    const layer = ensureDrawLayer();
    const type = d.type || 'freehand';
    let el = null;

    if (type === 'freehand') {
      el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', pointsToPathD(d.points));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', d.color);
      el.setAttribute('stroke-width', String(d.width || 3));
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
    } else if (type === 'line') {
      el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', d.x1);
      el.setAttribute('y1', d.y1);
      el.setAttribute('x2', d.x2);
      el.setAttribute('y2', d.y2);
      el.setAttribute('stroke', d.color);
      el.setAttribute('stroke-width', String(d.width || 3));
      el.setAttribute('stroke-linecap', 'round');
    } else if (type === 'rect') {
      el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', d.x);
      el.setAttribute('y', d.y);
      el.setAttribute('width', d.w);
      el.setAttribute('height', d.h);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', d.color);
      el.setAttribute('stroke-width', String(d.width || 3));
    } else if (type === 'ellipse') {
      el = document.createElementNS(SVG_NS, 'ellipse');
      el.setAttribute('cx', d.cx);
      el.setAttribute('cy', d.cy);
      el.setAttribute('rx', d.rx);
      el.setAttribute('ry', d.ry);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', d.color);
      el.setAttribute('stroke-width', String(d.width || 3));
    }

    if (!el) return;
    el.style.opacity = String(d.opacity != null ? d.opacity : 1);
    el.dataset.waId = d.id;
    layer.appendChild(el);
  }

  function renderAllDrawings() {
    if (drawLayer) drawLayer.innerHTML = '';
    pageData.drawings.forEach(renderDrawing);
    if (drawLayer && radiusPreviewEl) drawLayer.appendChild(radiusPreviewEl);
  }

  // Used by eraser to erase drawings accurately

  function pointToSegmentDistance(p, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abLenSq = abx * abx + aby * aby;
    if (abLenSq === 0) return pointDist(p, a);
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    return pointDist(p, { x: a.x + t * abx, y: a.y + t * aby });
  }

  function distanceToRectOutline(p, rect) {
    const { x, y, w, h } = rect;
    const corners = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
    let min = Infinity;
    for (let i = 0; i < 4; i++) {
      min = Math.min(min, pointToSegmentDistance(p, corners[i], corners[(i + 1) % 4]));
    }
    return min;
  }

  function distanceToEllipseOutline(p, cx, cy, rx, ry) {
    const SEGMENTS = 32;
    let min = Infinity;
    let prev = null;
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * Math.PI * 2;
      const pt = { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
      if (prev) min = Math.min(min, pointToSegmentDistance(p, prev, pt));
      prev = pt;
    }
    return min;
  }

  function shapeOutlineDistance(d, center) {
    const type = d.type || 'freehand';
    if (type === 'line') return pointToSegmentDistance(center, { x: d.x1, y: d.y1 }, { x: d.x2, y: d.y2 });
    if (type === 'rect') return distanceToRectOutline(center, { x: d.x, y: d.y, w: d.w, h: d.h });
    if (type === 'ellipse') return distanceToEllipseOutline(center, d.cx, d.cy, d.rx, d.ry);
    return Infinity;
  }

  function eraseAt(center, radius) {
    let changed = false;
    const next = [];
    pageData.drawings.forEach((d) => {
      const type = d.type || 'freehand';
      const effectiveRadius = radius + (d.width || 3) / 2;

      if (type === 'freehand') {
        if (d.points.length < 2) {
          if (d.points.length === 1 && pointDist(d.points[0], center) <= effectiveRadius) {
            changed = true;
            eraseRemovedIds.add(d.id);
          } else next.push(d);
          return;
        }
        const segments = [];
        let current = [d.points[0]];
        for (let i = 0; i < d.points.length - 1; i++) {
          const a = d.points[i];
          const b = d.points[i + 1];
          if (pointToSegmentDistance(center, a, b) <= effectiveRadius) {
            changed = true;
            if (current.length > 1) segments.push(current);
            current = [b];
          } else {
            current.push(b);
          }
        }
        if (current.length > 1) segments.push(current);
        if (segments.length === 1 && segments[0].length === d.points.length) {
          next.push(d);
        } else {
          eraseRemovedIds.add(d.id);
          segments.forEach((seg) => {
            const piece = { ...d, id: newId('d'), points: seg };
            next.push(piece);
            eraseAddedDrawings.push(piece);
          });
        }
      } else if (shapeOutlineDistance(d, center) <= effectiveRadius) {
        changed = true;
        eraseRemovedIds.add(d.id);
      } else {
        next.push(d);
      }
    });
    if (changed) pageData.drawings = next;
    return changed;
  }

  // Pointer-driven tools

  let dragStart = null;
  let previewEl = null;
  let currentFreehandPath = null;
  let currentFreehandPoints = [];
  let eraseActive = false;
  let eraseChangedThisStroke = false;
  let eraseRemovedIds = new Set();
  let eraseAddedDrawings = [];

  function toPagePoint(e) {
    return { x: e.pageX, y: e.pageY };
  }

  // Holding Shift constrains the line to whichever axis has the larger displacement
  function snapLineEndpoint(start, current, shift) {
    if (!shift) return current;
    const dx = Math.abs(current.x - start.x);
    const dy = Math.abs(current.y - start.y);
    return dx > dy ? { x: current.x, y: start.y } : { x: start.x, y: current.y };
  }

  function rectFromDrag(start, current, shift) {
    let dx = current.x - start.x;
    let dy = current.y - start.y;
    if (shift) {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * side;
      dy = (dy < 0 ? -1 : 1) * side;
    }
    return {
      x: Math.min(start.x, start.x + dx),
      y: Math.min(start.y, start.y + dy),
      w: Math.abs(dx),
      h: Math.abs(dy),
    };
  }

  function ellipseFromDrag(start, current, shift) {
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    let rx = Math.abs(dx) / 2;
    let ry = Math.abs(dy) / 2;
    if (shift) {
      const r = Math.max(rx, ry);
      rx = r;
      ry = r;
    }
    return {
      cx: start.x + (dx < 0 ? -rx : rx),
      cy: start.y + (dy < 0 ? -ry : ry),
      rx,
      ry,
    };
  }

  function createPreviewElFor(tool) {
    const tag = tool === 'line' ? 'line' : tool === 'rect' ? 'rect' : 'ellipse';
    const el = document.createElementNS(SVG_NS, tag);
    el.setAttribute('stroke', drawColor);
    el.setAttribute('stroke-width', String(strokeWidthFromRadius()));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-dasharray', '4 3');
    el.style.opacity = String(drawOpacity);
    return el;
  }


  function doerase(p) {
    const changed = eraseAt(p, radius);
    if (changed) {
      eraseChangedThisStroke = true;
      renderAllDrawings();
    }
  }

  async function handlePointerDown(e) {
    if (!enabled || mode !== 'draw') return;
    const p = toPagePoint(e);
    switch (currentDrawTool) {
      case 'pencil':
        currentFreehandPoints = [p];
        currentFreehandPath = document.createElementNS(SVG_NS, 'path');
        currentFreehandPath.setAttribute('fill', 'none');
        currentFreehandPath.setAttribute('stroke', drawColor);
        currentFreehandPath.setAttribute('stroke-width', String(strokeWidthFromRadius()));
        currentFreehandPath.setAttribute('stroke-linecap', 'round');
        currentFreehandPath.setAttribute('stroke-linejoin', 'round');
        currentFreehandPath.style.opacity = String(drawOpacity);
        ensureDrawLayer().appendChild(currentFreehandPath);
        break;
      case 'line':
      case 'rect':
      case 'ellipse':
        dragStart = p;
        previewEl = createPreviewElFor(currentDrawTool);
        ensureDrawLayer().appendChild(previewEl);
        break;
      case 'erase':
        pushHistory();
        eraseChangedThisStroke = false;
        eraseRemovedIds = new Set();
        eraseAddedDrawings = [];
        eraseActive = true;
        doerase(p);
        break;
    }
  }

  function handlePointerMove(e) {
    if (!enabled || mode !== 'draw') return;
    const p = toPagePoint(e);
    if (currentDrawTool === 'pencil' || currentDrawTool === 'erase') moveRadiusPreview(p);
    switch (currentDrawTool) {
      case 'pencil':
        if (!currentFreehandPath) return;
        currentFreehandPoints.push(p);
        currentFreehandPath.setAttribute('d', pointsToPathD(currentFreehandPoints));
        break;
      case 'line':
        if (!dragStart || !previewEl) return;
        {
          const endPoint = snapLineEndpoint(dragStart, p, e.shiftKey);
          previewEl.setAttribute('x1', dragStart.x);
          previewEl.setAttribute('y1', dragStart.y);
          previewEl.setAttribute('x2', endPoint.x);
          previewEl.setAttribute('y2', endPoint.y);
        }
        break;
      case 'rect': {
        if (!dragStart || !previewEl) return;
        const r = rectFromDrag(dragStart, p, e.shiftKey);
        previewEl.setAttribute('x', r.x);
        previewEl.setAttribute('y', r.y);
        previewEl.setAttribute('width', r.w);
        previewEl.setAttribute('height', r.h);
        break;
      }
      case 'ellipse': {
        if (!dragStart || !previewEl) return;
        const el = ellipseFromDrag(dragStart, p, e.shiftKey);
        previewEl.setAttribute('cx', el.cx);
        previewEl.setAttribute('cy', el.cy);
        previewEl.setAttribute('rx', el.rx);
        previewEl.setAttribute('ry', el.ry);
        break;
      }
      case 'erase':
        if (!eraseActive) return;
        doerase(p);
        break;
    }
  }

  async function handlePointerUp(e) {
    if (!enabled || mode !== 'draw') return;
    const p = toPagePoint(e);
    switch (currentDrawTool) {
      case 'pencil': {
        if (!currentFreehandPath) break;
        if (currentFreehandPoints.length < 2) {
          // A click still leaves a dot
          currentFreehandPoints.push({ ...currentFreehandPoints[0] });
          currentFreehandPath.setAttribute('d', pointsToPathD(currentFreehandPoints));
        }
        pushHistory();
        const id = newId('d');
        currentFreehandPath.dataset.waId = id;
        const drawing = {
          id,
          type: 'freehand',
          color: drawColor,
          opacity: drawOpacity,
          width: strokeWidthFromRadius(),
          points: currentFreehandPoints,
          createdAt: Date.now(),
        };
        pageData.drawings.push(drawing);
        rtSend({ type: 'add_drawing', drawing });
        await savePageData();
        currentFreehandPath = null;
        currentFreehandPoints = [];
        break;
      }
      case 'line': {
        if (!dragStart) break;
        const endPoint = snapLineEndpoint(dragStart, p, e.shiftKey);
        if (pointDist(dragStart, endPoint) > 2) {
          pushHistory();
          const drawing = {
            id: newId('d'), type: 'line', color: drawColor, opacity: drawOpacity, width: strokeWidthFromRadius(),
            x1: dragStart.x, y1: dragStart.y, x2: endPoint.x, y2: endPoint.y, createdAt: Date.now(),
          };
          pageData.drawings.push(drawing);
          rtSend({ type: 'add_drawing', drawing });
          await savePageData();
        }
        if (previewEl) previewEl.remove();
        previewEl = null;
        dragStart = null;
        renderAllDrawings();
        break;
      }
      case 'rect': {
        if (!dragStart) break;
        const r = rectFromDrag(dragStart, p, e.shiftKey);
        if (r.w > 2 && r.h > 2) {
          pushHistory();
          const drawing = {
            id: newId('d'), type: 'rect', color: drawColor, opacity: drawOpacity, width: strokeWidthFromRadius(),
            x: r.x, y: r.y, w: r.w, h: r.h, createdAt: Date.now(),
          };
          pageData.drawings.push(drawing);
          rtSend({ type: 'add_drawing', drawing });
          await savePageData();
        }
        if (previewEl) previewEl.remove();
        previewEl = null;
        dragStart = null;
        renderAllDrawings();
        break;
      }
      case 'ellipse': {
        if (!dragStart) break;
        const el = ellipseFromDrag(dragStart, p, e.shiftKey);
        if (el.rx > 2 && el.ry > 2) {
          pushHistory();
          const drawing = {
            id: newId('d'), type: 'ellipse', color: drawColor, opacity: drawOpacity, width: strokeWidthFromRadius(),
            cx: el.cx, cy: el.cy, rx: el.rx, ry: el.ry, createdAt: Date.now(),
          };
          pageData.drawings.push(drawing);
          rtSend({ type: 'add_drawing', drawing });
          await savePageData();
        }
        if (previewEl) previewEl.remove();
        previewEl = null;
        dragStart = null;
        renderAllDrawings();
        break;
      }
      case 'erase': {
        if (eraseActive && eraseChangedThisStroke) {
          rtSend({
            type: 'erase_drawings',
            removedIds: [...eraseRemovedIds],
            addedDrawings: eraseAddedDrawings,
          });
          await savePageData();
          renderAllDrawings();
        }
        eraseActive = false;
        break;
      }
    }
  }

  function setDrawMode(active) {
    const layer = ensureDrawLayer();
    layer.classList.toggle('wa-draw-active', active);
    if (active) {
      layer.addEventListener('pointerdown', handlePointerDown);
      layer.addEventListener('pointermove', handlePointerMove);
      layer.addEventListener('pointerup', handlePointerUp);
      layer.addEventListener('pointerleave', handlePointerUp);
    } else {
      layer.removeEventListener('pointerdown', handlePointerDown);
      layer.removeEventListener('pointermove', handlePointerMove);
      layer.removeEventListener('pointerup', handlePointerUp);
      layer.removeEventListener('pointerleave', handlePointerUp);
    }
  }

  // Toolbar

  const COLORS = ['#fde047', '#86efac', '#93c5fd', '#fca5a5', '#d8b4fe'];
  let mode = 'off'; // 'off' | 'highlight' | 'draw'
  let highlightColor = COLORS[0];
  let highlightCustomColor = '#ff0000';
  let drawCustomColor = '#ff0000';
  let toolbarHost = null;
  let submenuEl = null;
  // Remembers where the user last dragged the toolbar
  let toolbarPos = null;
  let rtStatusEl = null; // connection indicator in the bar

  const DRAW_TOOLS = [
    { id: 'pencil', label: 'Pencil' },
    { id: 'line', label: 'Line' },
    { id: 'rect', label: 'Rect' },
    { id: 'ellipse', label: 'Ellipse' },
    { id: 'erase', label: 'Erase' },
  ];

  function colorRow(shadow, currentColor, customColor, onDefaultPick, onCustomPick, onCustomSelect) {
    const row = document.createElement('div');
    row.className = 'row colors';

    COLORS.forEach((c) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (c.toLowerCase() === (currentColor || '').toLowerCase() ? ' active' : '');
      sw.style.background = c;
      sw.title = c;
      sw.onclick = () => onDefaultPick(c);
      row.appendChild(sw);
    });

    const customInput = document.createElement('input');
    customInput.type = 'color';
    customInput.value = /^#/.test(customColor) ? customColor : '#ff0000';
    customInput.className = 'custom-color' + ((currentColor || '').toLowerCase() === (customColor || '').toLowerCase() ? ' active' : '');
    customInput.title = 'Pick any RGB color';
    customInput.style.background = customInput.value;

    customInput.onpointerdown = (e) => {
      e.stopPropagation();
      row.querySelectorAll('.swatch.active').forEach((sw) => sw.classList.remove('active'));
      customInput.classList.add('active');
      onCustomSelect(customInput.value);
    };
    customInput.oninput = () => {
      customInput.style.background = customInput.value;
      customInput.classList.add('active');
      onCustomPick(customInput.value);
    };
    customInput.onchange = () => {
      customInput.style.background = customInput.value;
      customInput.classList.add('active');
      onCustomPick(customInput.value);
    };

    row.appendChild(customInput);
    return row;
  }

  function buildAnnotateSubmenu(container) {
    container.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'submenu-label';
    label.textContent = 'Color';
    container.appendChild(label);

    container.appendChild(
      colorRow(
        container,
        highlightColor,
        highlightCustomColor,
        (c) => {
          highlightColor = c;
          buildAnnotateSubmenu(container);
        },
        (c) => {
          highlightColor = c;
          highlightCustomColor = c;
        },
        (c) => {
          highlightColor = c;
          highlightCustomColor = c;
        }
      )
    );

  }

  function buildDrawSubmenu(container) {
    container.innerHTML = '';

    const toolsLabel = document.createElement('div');
    toolsLabel.className = 'submenu-label';
    toolsLabel.textContent = 'Tool';
    container.appendChild(toolsLabel);

    const toolsRow = document.createElement('div');
    toolsRow.className = 'row tools';
    DRAW_TOOLS.forEach((t) => {
      const btn = document.createElement('button');
      btn.textContent = t.label;
      btn.className = t.id === currentDrawTool ? 'active' : '';
      btn.onclick = () => {
        currentDrawTool = t.id;
        buildDrawSubmenu(container);
        updateRadiusPreviewVisibility();
      };
      toolsRow.appendChild(btn);
    });
    container.appendChild(toolsRow);

    const colorLabel = document.createElement('div');
    colorLabel.className = 'submenu-label';
    colorLabel.textContent = 'Color';
    container.appendChild(colorLabel);

    container.appendChild(
      colorRow(
        container,
        drawColor,
        drawCustomColor,
        (c) => {
          drawColor = c;
          buildDrawSubmenu(container);
        },
        (c) => {
          drawColor = c;
          drawCustomColor = c;
        },
        (c) => {
          drawColor = c;
          drawCustomColor = c;
        }
      )
    );

    const opacityLabel = document.createElement('div');
    opacityLabel.className = 'submenu-label';
    opacityLabel.textContent = `Opacity (${Math.round(drawOpacity * 100)}%)`;
    container.appendChild(opacityLabel);

    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range';
    opacitySlider.min = '0.1';
    opacitySlider.max = '1';
    opacitySlider.step = '0.01';
    opacitySlider.value = String(drawOpacity);
    opacitySlider.oninput = () => {
      drawOpacity = parseFloat(opacitySlider.value);
      opacityLabel.textContent = `Opacity (${Math.round(drawOpacity * 100)}%)`;
    };
    container.appendChild(opacitySlider);

    const sizeLabel = document.createElement('div');
    sizeLabel.className = 'submenu-label';
    sizeLabel.textContent = `Radius (${radius}px)`;
    container.appendChild(sizeLabel);

    const sizeSlider = document.createElement('input');
    sizeSlider.type = 'range';
    sizeSlider.min = '1';
    sizeSlider.max = '80';
    sizeSlider.value = String(radius);
    sizeSlider.oninput = () => {
      radius = parseInt(sizeSlider.value, 10);
      sizeLabel.textContent = `Radius (${radius}px)`;
      updateRadiusPreviewGeometry();
    };
    container.appendChild(sizeSlider);

    const hint = document.createElement('div');
    hint.className = 'submenu-hint';
    hint.textContent =
      currentDrawTool === 'rect'
        ? 'Hold Shift while dragging for a square.'
        : currentDrawTool === 'ellipse'
        ? 'Hold Shift while dragging for a circle.'
        : currentDrawTool === 'line'
        ? 'Hold Shift while dragging for a vertical/horizontal line.'
        : '';
    if (hint.textContent) container.appendChild(hint);
  }

  function updateSubmenu() {
    if (!submenuEl) return;
    if (mode === 'highlight') {
      submenuEl.style.display = '';
      buildAnnotateSubmenu(submenuEl);
    } else if (mode === 'draw') {
      submenuEl.style.display = '';
      buildDrawSubmenu(submenuEl);
    } else {
      submenuEl.style.display = 'none';
      submenuEl.innerHTML = '';
    }
  }

  function updateToolbarStatus(status, peerCount) {
    if (!rtStatusEl) return;
    if (status === 'connected') {
      rtStatusEl.textContent = peerCount > 1 ? `\u25CF Live \u00B7 ${peerCount}` : '\u25CF Live';
      rtStatusEl.style.color = '#4ade80';
    } else if (status === 'connecting') {
      rtStatusEl.textContent = '\u25CF Connecting\u2026';
      rtStatusEl.style.color = '#facc15';
    } else {
      rtStatusEl.textContent = '\u25CB Offline';
      rtStatusEl.style.color = '#9ca3af';
    }
  }

  function buildToolbar() {
    if (toolbarHost) return;

    const host = document.createElement('div');
    host.id = 'wa-toolbar-host';
    if (toolbarPos) {
      host.style.cssText = `position: fixed; top: ${toolbarPos.top}px; left: ${toolbarPos.left}px; right: auto; bottom: auto; z-index: 2147483647;`;
    } else {
      host.style.cssText = `position: fixed; top: 20px; right: 20px; left: auto; bottom: auto; z-index: 2147483647;`;
    }
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .wrap { display:flex; flex-direction:column; gap:6px; min-width: 360px; max-width: 420px;
              font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              user-select:none; -webkit-user-select:none; }
      .bar { display:grid; grid-template-columns: 1fr auto 1fr; align-items:center; gap:6px;
             background:#1f2937; padding:8px; border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.3);
             white-space: nowrap; user-select:none; -webkit-user-select:none; }
      .bar-group { display:flex; align-items:center; gap:6px; }
      .bar-group.left { justify-content: flex-start; }
      .bar-group.right { justify-content: flex-end; }
      .handle { cursor: grab; color: #9ca3af; padding: 0 6px; display:flex; align-items:center;
                justify-content:center; user-select: none; touch-action: none; flex: none; }
      .handle:active { cursor: grabbing; }
      button { font: inherit; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; color:#fff;
               background:#374151; white-space: nowrap; }
      button.active { background:#2563eb; }
      button:disabled { opacity: 0.4; cursor: default; }
      button.icon-btn { display:flex; align-items:center; justify-content:center; padding:6px; }
      .divider { width:1px; align-self:stretch; background:#4b5563; flex:none; }
      .submenu { display:flex; flex-direction:column; gap:6px; background:#111827; padding:10px;
                 border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.3); color:#e5e7eb;
                 user-select:none; -webkit-user-select:none; }
      .submenu-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color:#9ca3af;
                       margin-top: 4px; }
      .submenu-hint { font-size: 11px; color:#9ca3af; font-style: italic; }
      .row { display:flex; align-items:center; gap:6px; flex-wrap: wrap; }
      .swatch { width:20px; height:20px; border-radius:50%; cursor:pointer; border:2px solid transparent;
                flex: none; }
      .swatch.active { border-color:#fff; }
      .custom-color { width:20px; height:20px; border-radius:0; overflow:hidden; border:2px solid transparent;
                      cursor:pointer; box-sizing:border-box; flex:none; padding:0; background:#ff0000;
                      appearance:none; -webkit-appearance:none; }
      .custom-color.active { border-color:#fff; }
      .custom-color::-webkit-color-swatch-wrapper { padding:0; }
      .custom-color::-webkit-color-swatch { border:none; border-radius:0; }
      .custom-color::-moz-color-swatch { border:none; border-radius:0; }
      input[type="range"] { width: 100%; }
      .rt-status { display:flex; align-items:center; gap:4px; font-size:11px; color:#9ca3af;
                   padding:0 4px; white-space:nowrap; flex:none; }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const bar = document.createElement('div');
    bar.className = 'bar';

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.title = 'Drag to move';
    handle.innerHTML =
      '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="2.5" cy="2.5" r="1.5"/><circle cx="7.5" cy="2.5" r="1.5"/>' +
      '<circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/>' +
      '<circle cx="2.5" cy="13.5" r="1.5"/><circle cx="7.5" cy="13.5" r="1.5"/></svg>';

    const annotateBtn = document.createElement('button');
    annotateBtn.textContent = 'Annotate';
    const drawBtn = document.createElement('button');
    drawBtn.textContent = 'Draw';

    const divider = document.createElement('div');
    divider.className = 'divider';

    const undoBtn = document.createElement('button');
    undoBtn.className = 'icon-btn';
    undoBtn.title = 'Undo';
    undoBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M9 15L4 10l5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M4 10h11a6 6 0 010 12h-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const redoBtn = document.createElement('button');
    redoBtn.className = 'icon-btn';
    redoBtn.title = 'Redo';
    redoBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M15 15l5-5-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M20 10H9a6 6 0 000 12h2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'icon-btn';
    clearBtn.title = 'Clear page';
    clearBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v14a1 1 0 001 1h8a1 1 0 001-1V7" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    annotateBtn.onclick = () => {
      mode = mode === 'highlight' ? 'off' : 'highlight';
      annotateBtn.classList.toggle('active', mode === 'highlight');
      drawBtn.classList.remove('active');
      setDrawMode(false);
      updateSubmenu();
      updateRadiusPreviewVisibility();
    };

    drawBtn.onclick = () => {
      mode = mode === 'draw' ? 'off' : 'draw';
      drawBtn.classList.toggle('active', mode === 'draw');
      annotateBtn.classList.remove('active');
      setDrawMode(mode === 'draw');
      updateSubmenu();
      updateRadiusPreviewVisibility();
    };

    undoBtn.onclick = () => undo();
    redoBtn.onclick = () => redo();

    clearBtn.onclick = async () => {
      if (!confirm('Remove all highlights and drawings on this page?')) return;
      pushHistory();
      pageData = { highlights: [], drawings: [] };
      rtSend({ type: 'clear' });
      await savePageData();
      renderAllHighlights();
      renderAllDrawings();
    };

    const leftGroup = document.createElement('div');
    leftGroup.className = 'bar-group left';
    const rightGroup = document.createElement('div');
    rightGroup.className = 'bar-group right';

    const statusEl = document.createElement('div');
    statusEl.className = 'rt-status';
    statusEl.title = 'Realtime sync status';
    rtStatusEl = statusEl;
    updateToolbarStatus(rtStatus, rtPeerCount);

    leftGroup.append(handle, annotateBtn, drawBtn);
    rightGroup.append(statusEl, undoBtn, redoBtn, clearBtn);
    bar.append(leftGroup, divider, rightGroup);

    // Clicking the bar's empty background (not a button, not the drag
    // handle) exits whichever mode is active, returning to the same
    // cursor-is-just-a-cursor state as right after toggling the extension
    // on, without having to click the now-active mode button again.
    bar.addEventListener('click', (e) => {
      if (mode === 'off') return;
      if (e.target.closest('button') || e.target.closest('.handle')) return;
      mode = 'off';
      annotateBtn.classList.remove('active');
      drawBtn.classList.remove('active');
      setDrawMode(false);
      updateSubmenu();
      updateRadiusPreviewVisibility();
    });

    const submenu = document.createElement('div');
    submenu.className = 'submenu';
    submenu.style.display = 'none';
    submenuEl = submenu;

    wrap.append(bar, submenu);
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);
    toolbarHost = host;

    attachDrag(handle, host);
  }

  function attachDrag(handle, host) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = host.getBoundingClientRect();
      const startTop = rect.top;
      const startLeft = rect.left;

      function onMove(ev) {
        const top = startTop + (ev.clientY - startY);
        const left = startLeft + (ev.clientX - startX);
        host.style.top = `${top}px`;
        host.style.left = `${left}px`;
        host.style.bottom = 'auto';
        host.style.right = 'auto';
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        const rect2 = host.getBoundingClientRect();
        toolbarPos = { top: rect2.top, left: rect2.left };
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  function destroyToolbar() {
    if (toolbarHost) {
      toolbarHost.remove();
      toolbarHost = null;
    }
    submenuEl = null;
    rtStatusEl = null;
    mode = 'off';
  }

  // Keyboard shortcuts for undo/redo while the extension is active.
  document.addEventListener('keydown', (e) => {
    if (!enabled) return;
    const meta = e.ctrlKey || e.metaKey;
    if (!meta) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (key === 'z' && e.shiftKey) {
      e.preventDefault();
      redo();
    } else if (key === 'y') {
      e.preventDefault();
      redo();
    }
  });

  // Selection handling to create a highlight

  document.addEventListener('mouseup', async () => {
    if (!enabled || mode !== 'highlight') return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!range.toString().trim()) return;
    if (selectionIntersectsToolbar(range)) return;
    if (range.toString().trim().length > 4000) return;

    const newStart = globalOffsetOf(range.startContainer, range.startOffset);
    const newEnd = globalOffsetOf(range.endContainer, range.endOffset);
    selection.removeAllRanges();
    if (newEnd <= newStart) return;

    // Existing highlights are never altered or overlapped
    const occupied = pageData.highlights
      .filter((h) => !h.orphaned)
      .map((h) => [h.anchor.startOffset, h.anchor.endOffset])
      .sort((a, b) => a[0] - b[0]);

    const remaining = subtractIntervals(newStart, newEnd, occupied);
    if (!remaining.length) return;

    pushHistory();
    remaining.forEach(([s, e]) => {
      const segRange = rangeFromOffsets(s, e);
      if (!segRange) return;
      const anchor = buildAnchorFromOffsets(s, e);
      const id = newId('h');
      const highlight = { id, anchor, color: highlightColor, note: '', createdAt: Date.now() };
      pageData.highlights.push(highlight);
      paintHighlight(segRange, id, highlightColor);
      rtSend({ type: 'add_highlight', highlight });
    });

    await savePageData();
  });

  // Realtime sync

  const RT_SERVER_URL = 'ws://localhost:8787';

  const rtClientId = newId('u');
  let rtStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
  let rtPeerCount = 1;
  let rtPendingOps = []; // ops made while offline, replayed once reconnected

  function rtConnect() {
    rtStatus = 'connecting';
    updateToolbarStatus(rtStatus, rtPeerCount);
    api.runtime
      .sendMessage({ type: 'wa-rt-connect', room: PAGE_KEY, serverUrl: RT_SERVER_URL, clientId: rtClientId })
      .catch(() => {});
  }

  function rtDisconnect() {
    rtStatus = 'disconnected';
    rtPeerCount = 1;
    api.runtime.sendMessage({ type: 'wa-rt-disconnect', room: PAGE_KEY }).catch(() => {});
  }

  // Sends an op if connected. Otherwise queues it for replay on reconnect
  function rtSend(op) {
    if (rtStatus === 'connected') {
      api.runtime.sendMessage({ type: 'wa-rt-send', room: PAGE_KEY, op }).catch(() => {});
    } else {
      rtPendingOps.push(op);
    }
  }

  function rtApplyIncoming(op) {
    switch (op.type) {
      case 'add_highlight':
        if (!pageData.highlights.some((h) => h.id === op.highlight.id)) {
          pageData.highlights.push(op.highlight);
        }
        break;
      case 'update_note': {
        const h = pageData.highlights.find((h) => h.id === op.id);
        if (h) {
          h.note = op.note;
          h.updatedAt = op.updatedAt;
        }
        break;
      }
      case 'delete_highlight':
        pageData.highlights = pageData.highlights.filter((h) => h.id !== op.id);
        break;
      case 'add_drawing':
        if (!pageData.drawings.some((d) => d.id === op.drawing.id)) {
          pageData.drawings.push(op.drawing);
        }
        break;
      case 'erase_drawings': {
        const removed = new Set(op.removedIds || []);
        pageData.drawings = pageData.drawings.filter((d) => !removed.has(d.id));
        (op.addedDrawings || []).forEach((d) => pageData.drawings.push(d));
        break;
      }
      case 'clear':
        pageData.highlights = [];
        pageData.drawings = [];
        break;
      default:
        return;
    }
    savePageData();
    renderAllHighlights();
    renderAllDrawings();
  }

  // On reconnect, the server sends its canonical snapshot for the room.

  function rtApplyInit(payload) {
    pageData = { highlights: payload.highlights || [], drawings: payload.drawings || [] };
    const toReplay = rtPendingOps;
    rtPendingOps = [];
    toReplay.forEach((op) => rtApplyIncoming(op));
    savePageData();
    renderAllHighlights();
    renderAllDrawings();
    toReplay.forEach((op) => rtSend(op));
  }


  // On/off toggle

  let enabled = false;

  async function setEnabled(value) {
    if (value === enabled) return;
    enabled = value;

    if (enabled) {
      if (!pageDataLoaded) await loadPageData();
      buildToolbar();
      renderAllHighlights();
      renderAllDrawings();
      rtConnect();
    } else {
      closePopover();
      setDrawMode(false);
      destroyToolbar();
      clearRenderedAnnotations();
      destroyDrawLayer();
      rtDisconnect();
    }
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'wa-toggle') {
      setEnabled(Boolean(msg.enabled));
      return;
    }

    if (msg.type === 'wa-rt-status') {
      rtStatus = msg.status;
      if (rtStatus !== 'connected') rtPeerCount = 1;
      updateToolbarStatus(rtStatus, rtPeerCount);
      return;
    }

    if (msg.type === 'wa-rt-incoming') {
      const payload = msg.payload;
      if (!payload || typeof payload.type !== 'string') return;
      if (payload.type === 'init') {
        rtStatus = 'connected';
        rtApplyInit(payload);
        updateToolbarStatus(rtStatus, rtPeerCount);
      } else if (payload.type === 'presence') {
        rtPeerCount = payload.count;
        updateToolbarStatus(rtStatus, rtPeerCount);
      } else {
        rtApplyIncoming(payload);
      }
      return;
    }
  });

  window.addEventListener('hashchange', () => {
    if (enabled) {
      const currentKey = storageKeyForThisPage();
      
      if (currentKey !== PAGE_KEY) {
        setEnabled(false); 
      }
    }
  });
  
})();