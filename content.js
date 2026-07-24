(() => {
  'use strict';

  if (window.__waInjected) return;
  window.__waInjected = true;

  const api = globalThis.browser || globalThis.chrome;

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

    // Sort remaining params
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

  function buildAnchorFromRange(range) {
    const fullText = getFullText();
    const startOffset = globalOffsetOf(range.startContainer, range.startOffset);
    const endOffset = globalOffsetOf(range.endContainer, range.endOffset);
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

  function paintHighlight(range, id, color) {
    const textNodes = getTextNodesInRange(range);
    const spans = [];
    textNodes.forEach((node) => {
      if (!node.parentNode) return;
      const nodeRange = document.createRange();
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.textContent.length;
      if (start === end) return;
      nodeRange.setStart(node, start);
      nodeRange.setEnd(node, end);
      const span = document.createElement('span');
      span.className = 'wa-highlight';
      span.dataset.waId = id;
      span.style.backgroundColor = color;
      nodeRange.surroundContents(span);
      spans.push(span);
    });
    spans.forEach((span) => {
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        openNotePopover(id, span);
      });
    });
    return spans;
  }

  function buildNoteIcon(id) {
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
        spans[spans.length - 1].insertAdjacentElement('afterend', buildNoteIcon(h.id));
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
      pageData.highlights = pageData.highlights.filter((h) => h.id !== id);
      removeHighlight(id);
      await savePageData();
      closePopover();
    };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'wa-save';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = async () => {
      highlight.note = textarea.value.trim();
      highlight.updatedAt = Date.now();
      await savePageData();
      renderAllHighlights();
      closePopover();
    };

    row.append(closeBtn, deleteBtn, saveBtn);
    pop.append(textarea, row);
    document.body.appendChild(pop);
    activePopover = pop;
    textarea.focus();
  }

  document.addEventListener('click', (e) => {
    if (activePopover && !activePopover.contains(e.target)) closePopover();
  });

  // Drawing overlay

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let drawLayer = null;
  let currentPath = null;
  let currentPoints = [];
  let drawColor = '#e11d48';
  let resizeObserverAttached = false;

  function ensureDrawLayer() {
    if (drawLayer) return drawLayer;
    drawLayer = document.createElementNS(SVG_NS, 'svg');
    drawLayer.id = 'wa-draw-layer';
    document.body.appendChild(drawLayer);
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
  }

  function resizeDrawLayer() {
    if (!drawLayer) return;
    const w = document.documentElement.scrollWidth;
    const h = document.documentElement.scrollHeight;
    drawLayer.setAttribute('width', w);
    drawLayer.setAttribute('height', h);
    drawLayer.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

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

  function renderDrawing(d) {
    const layer = ensureDrawLayer();
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pointsToPathD(d.points));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', d.color);
    path.setAttribute('stroke-width', String(d.width || 3));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.dataset.waId = d.id;
    layer.appendChild(path);
  }

  function renderAllDrawings() {
    if (drawLayer) drawLayer.innerHTML = '';
    pageData.drawings.forEach(renderDrawing);
  }

  function startDrawing(e) {
    if (!enabled) return;
    currentPoints = [{ x: e.pageX, y: e.pageY }];
    currentPath = document.createElementNS(SVG_NS, 'path');
    currentPath.setAttribute('fill', 'none');
    currentPath.setAttribute('stroke', drawColor);
    currentPath.setAttribute('stroke-width', '3');
    currentPath.setAttribute('stroke-linecap', 'round');
    currentPath.setAttribute('stroke-linejoin', 'round');
    ensureDrawLayer().appendChild(currentPath);
  }

  function continueDrawing(e) {
    if (!currentPath) return;
    currentPoints.push({ x: e.pageX, y: e.pageY });
    currentPath.setAttribute('d', pointsToPathD(currentPoints));
  }

  async function endDrawing() {
    if (!currentPath || currentPoints.length < 2) {
      if (currentPath) currentPath.remove();
      currentPath = null;
      return;
    }
    const id = 'd_' + Math.random().toString(36).slice(2, 10);
    currentPath.dataset.waId = id;
    pageData.drawings.push({ id, color: drawColor, width: 3, points: currentPoints, createdAt: Date.now() });
    await savePageData();
    currentPath = null;
    currentPoints = [];
  }

  function setDrawMode(active) {
    const layer = ensureDrawLayer();
    layer.classList.toggle('wa-draw-active', active);
    if (active) {
      layer.addEventListener('pointerdown', startDrawing);
      layer.addEventListener('pointermove', continueDrawing);
      layer.addEventListener('pointerup', endDrawing);
      layer.addEventListener('pointerleave', endDrawing);
    } else {
      layer.removeEventListener('pointerdown', startDrawing);
      layer.removeEventListener('pointermove', continueDrawing);
      layer.removeEventListener('pointerup', endDrawing);
      layer.removeEventListener('pointerleave', endDrawing);
    }
  }

  // Toolbar

  const COLORS = ['#fde047', '#86efac', '#93c5fd', '#fca5a5', '#d8b4fe'];
  let mode = 'off'; // 'off' | 'highlight' | 'draw'
  let highlightColor = COLORS[0];
  let toolbarHost = null;
  // Remembers where the user last dragged the toolbar
  let toolbarPos = null;

  function buildToolbar() {
    if (toolbarHost) return;

    const host = document.createElement('div');
    host.id = 'wa-toolbar-host';
    if (toolbarPos) {
      host.style.cssText = `position: fixed; top: ${toolbarPos.top}px; left: ${toolbarPos.left}px; z-index: 2147483647;`;
    } else {
      host.style.cssText = `position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;`;
    }
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .bar { display:flex; align-items:center; gap:6px; background:#1f2937; padding:8px;
             border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.3);
             font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .handle { cursor: grab; color: #9ca3af; padding: 0 4px; user-select: none; touch-action: none; }
      .handle:active { cursor: grabbing; }
      button { border:none; border-radius:6px; padding:6px 10px; cursor:pointer; color:#fff;
               background:#374151; }
      button.active { background:#2563eb; }
      .swatch { width:18px; height:18px; border-radius:50%; cursor:pointer; border:2px solid transparent; }
      .swatch.active { border-color:#fff; }
    `;

    const bar = document.createElement('div');
    bar.className = 'bar';

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.textContent = '::';
    handle.title = 'Drag to move';

    const highlightBtn = document.createElement('button');
    highlightBtn.textContent = 'Highlight';
    const drawBtn = document.createElement('button');
    drawBtn.textContent = 'Draw';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear page';

    const swatches = COLORS.map((c) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (c === highlightColor ? ' active' : '');
      sw.style.background = c;
      sw.onclick = () => {
        highlightColor = c;
        drawColor = c;
        shadow.querySelectorAll('.swatch').forEach((el) => el.classList.remove('active'));
        sw.classList.add('active');
      };
      return sw;
    });

    highlightBtn.onclick = () => {
      mode = mode === 'highlight' ? 'off' : 'highlight';
      highlightBtn.classList.toggle('active', mode === 'highlight');
      drawBtn.classList.remove('active');
      setDrawMode(false);
    };

    drawBtn.onclick = () => {
      mode = mode === 'draw' ? 'off' : 'draw';
      drawBtn.classList.toggle('active', mode === 'draw');
      highlightBtn.classList.remove('active');
      setDrawMode(mode === 'draw');
    };

    clearBtn.onclick = async () => {
      if (!confirm('Remove all highlights and drawings on this page?')) return;
      pageData = { highlights: [], drawings: [] };
      await savePageData();
      renderAllHighlights();
      renderAllDrawings();
    };

    bar.append(handle, highlightBtn, drawBtn, ...swatches, clearBtn);
    shadow.append(style, bar);
    document.body.appendChild(host);
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
    mode = 'off';
  }

  // Selection handling to create a highlight

  document.addEventListener('mouseup', async () => {
    if (!enabled || mode !== 'highlight') return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!range.toString().trim()) return;

    const anchor = buildAnchorFromRange(range);
    const id = 'h_' + Math.random().toString(36).slice(2, 10);
    const record = { id, anchor, color: highlightColor, note: '', createdAt: Date.now() };
    pageData.highlights.push(record);

    paintHighlight(range, id, highlightColor);
    selection.removeAllRanges();
    await savePageData();
  });

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
    } else {
      closePopover();
      setDrawMode(false);
      destroyToolbar();
      clearRenderedAnnotations();
      destroyDrawLayer();
    }
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'wa-toggle') setEnabled(Boolean(msg.enabled));
  });

})();
