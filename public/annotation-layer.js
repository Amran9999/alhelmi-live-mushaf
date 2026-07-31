/**
 * Layer anotasi lukisan di atas mushaf (pen merah/hijau + pemadam).
 * Koordinat normal (0–1) relatif kepada kotak SVG mushaf.
 */

const PEN_RED = '#e11d48';
const PEN_GREEN = '#16a34a';
const DEFAULT_PEN_WIDTH = 0.0075;
const ERASER_WIDTH = 0.028;
const MIN_POINT_DIST = 0.002;

export function createAnnotationLayer({
  socket,
  getRole,
  getPage,
  mushafHost,
  viewerShell,
}) {
  /** @type {Map<number, object[]>} */
  const strokesByPage = new Map();
  let tool = 'off'; // off | pen-red | pen-green | eraser
  let canvas = null;
  let ctx = null;
  let drawing = false;
  let currentStroke = null;
  let resizeObserver = null;
  let bound = false;
  let toolbar = null;

  function pageKey(page = getPage()) {
    return Math.min(604, Math.max(1, Number(page) || 1));
  }

  function getStrokes(page = pageKey()) {
    const key = pageKey(page);
    if (!strokesByPage.has(key)) strokesByPage.set(key, []);
    return strokesByPage.get(key);
  }

  function setStrokes(page, strokes) {
    strokesByPage.set(pageKey(page), Array.isArray(strokes) ? strokes.slice() : []);
  }

  function ensureCanvas() {
    if (!mushafHost) return null;
    const svg = mushafHost.querySelector('.mushaf-svg');
    if (!svg) {
      if (canvas) {
        canvas.remove();
        canvas = null;
        ctx = null;
      }
      return null;
    }

    if (!canvas || !mushafHost.contains(canvas)) {
      canvas = document.createElement('canvas');
      canvas.className = 'annotation-layer';
      canvas.setAttribute('aria-hidden', 'true');
      mushafHost.appendChild(canvas);
      ctx = canvas.getContext('2d');
      bindCanvasEvents();
    }

    syncCanvasSize();
    updateCanvasInteractivity();
    return canvas;
  }

  function syncCanvasSize() {
    if (!canvas || !mushafHost) return;
    const svg = mushafHost.querySelector('.mushaf-svg');
    if (!svg) return;

    const hostRect = mushafHost.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    if (hostRect.width < 2 || hostRect.height < 2 || svgRect.width < 2) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(1, Math.round(svgRect.width));
    const cssH = Math.max(1, Math.round(svgRect.height));
    const left = svgRect.left - hostRect.left + mushafHost.scrollLeft;
    const top = svgRect.top - hostRect.top + mushafHost.scrollTop;

    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;

    const needW = Math.round(cssW * dpr);
    const needH = Math.round(cssH * dpr);
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
    }
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    redraw();
  }

  function normFromEvent(event) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function strokeStyle(stroke) {
    if (!canvas) return { color: stroke.color, lineWidth: 2 };
    const w = canvas.getBoundingClientRect().width || 1;
    return {
      color: stroke.color,
      lineWidth: Math.max(1.5, (stroke.width || DEFAULT_PEN_WIDTH) * w),
    };
  }

  function drawStroke(stroke, { preview = false } = {}) {
    if (!ctx || !stroke?.points?.length) return;
    const { color, lineWidth } = strokeStyle(stroke);
    ctx.save();
    if (stroke.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
    }
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const pts = stroke.points;
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i += 1) {
      ctx.lineTo(pts[i].x * w, pts[i].y * h);
    }
    if (pts.length === 1) {
      ctx.lineTo(pts[0].x * w + 0.01, pts[0].y * h);
    }
    ctx.stroke();
    ctx.restore();
    if (preview) {
      /* no-op marker for readability */
    }
  }

  function redraw() {
    if (!ctx || !canvas) return;
    const cssW = canvas.getBoundingClientRect().width;
    const cssH = canvas.getBoundingClientRect().height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    const dpr = canvas.width / Math.max(1, cssW);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const stroke of getStrokes()) {
      drawStroke(stroke);
    }
    if (currentStroke) drawStroke(currentStroke, { preview: true });
  }

  function updateCanvasInteractivity() {
    if (!canvas) return;
    const active = getRole() === 'teacher' && tool !== 'off';
    canvas.classList.toggle('is-drawing', active);
    canvas.style.pointerEvents = active ? 'auto' : 'none';
    document.body.classList.toggle('annotation-drawing', active);
    if (toolbar) {
      toolbar.querySelectorAll('[data-anno-tool]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-anno-tool') === tool);
      });
      toolbar.hidden = getRole() !== 'teacher';
    }
  }

  function setTool(next) {
    if (getRole() !== 'teacher') {
      tool = 'off';
    } else {
      tool = next === tool ? 'off' : next;
    }
    if (tool === 'off') {
      drawing = false;
      currentStroke = null;
    }
    updateCanvasInteractivity();
    ensureCanvas();
    redraw();
  }

  function beginStroke(event) {
    if (getRole() !== 'teacher' || tool === 'off') return;
    const pt = normFromEvent(event);
    if (!pt) return;
    event.preventDefault();
    drawing = true;
    currentStroke = {
      id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      page: pageKey(),
      tool: tool === 'eraser' ? 'eraser' : 'pen',
      color: tool === 'pen-green' ? PEN_GREEN : PEN_RED,
      width: tool === 'eraser' ? ERASER_WIDTH : DEFAULT_PEN_WIDTH,
      points: [pt],
    };
    canvas?.setPointerCapture?.(event.pointerId);
    redraw();
  }

  function extendStroke(event) {
    if (!drawing || !currentStroke) return;
    const pt = normFromEvent(event);
    if (!pt) return;
    event.preventDefault();
    const last = currentStroke.points[currentStroke.points.length - 1];
    const dx = pt.x - last.x;
    const dy = pt.y - last.y;
    if (dx * dx + dy * dy < MIN_POINT_DIST * MIN_POINT_DIST) return;
    currentStroke.points.push(pt);
    redraw();
  }

  function endStroke(event) {
    if (!drawing || !currentStroke) return;
    if (event) {
      try {
        canvas?.releasePointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
    }
    drawing = false;
    const stroke = currentStroke;
    currentStroke = null;
    if (!stroke.points.length) {
      redraw();
      return;
    }
    getStrokes(stroke.page).push(stroke);
    redraw();
    socket.emit('annotation_add', stroke);
  }

  function bindCanvasEvents() {
    if (!canvas || canvas.dataset.bound === '1') return;
    canvas.dataset.bound = '1';
    canvas.addEventListener('pointerdown', beginStroke);
    canvas.addEventListener('pointermove', extendStroke);
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);
    canvas.addEventListener('pointerleave', (e) => {
      if (drawing) endStroke(e);
    });
  }

  function ensureToolbar() {
    if (!viewerShell) return;
    toolbar = document.getElementById('annotation-toolbar');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = 'annotation-toolbar';
      toolbar.className = 'annotation-toolbar teacher-only';
      toolbar.setAttribute('role', 'toolbar');
      toolbar.setAttribute('aria-label', 'Alat anotasi mushaf');
      toolbar.innerHTML = `
        <span class="annotation-toolbar-label">Anotasi</span>
        <button type="button" class="annotation-tool annotation-tool-red" data-anno-tool="pen-red" title="Pen merah (kesalahan)" aria-label="Pen merah">●</button>
        <button type="button" class="annotation-tool annotation-tool-green" data-anno-tool="pen-green" title="Pen hijau" aria-label="Pen hijau">●</button>
        <button type="button" class="annotation-tool" data-anno-tool="eraser" title="Pemadam" aria-label="Pemadam">⌫</button>
        <button type="button" class="annotation-tool annotation-tool-clear" data-anno-action="clear" title="Kosongkan anotasi halaman ini" aria-label="Kosongkan halaman">Kosong</button>
        <button type="button" class="annotation-tool annotation-tool-off" data-anno-tool="off" title="Tamat lukisan / pilih ayat" aria-label="Tamat lukisan">✋</button>
      `;
      const ctx = viewerShell.querySelector('.mushaf-context-bar');
      if (ctx) ctx.insertAdjacentElement('afterend', toolbar);
      else viewerShell.prepend(toolbar);
    }

    if (toolbar.dataset.bound === '1') {
      updateCanvasInteractivity();
      return;
    }
    toolbar.dataset.bound = '1';
    toolbar.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-anno-tool], [data-anno-action]');
      if (!btn || getRole() !== 'teacher') return;
      const action = btn.getAttribute('data-anno-action');
      if (action === 'clear') {
        clearPage(pageKey());
        return;
      }
      const next = btn.getAttribute('data-anno-tool');
      if (next) setTool(next);
    });
    updateCanvasInteractivity();
  }

  function clearPage(page = pageKey()) {
    if (getRole() !== 'teacher') return;
    const p = pageKey(page);
    setStrokes(p, []);
    currentStroke = null;
    drawing = false;
    if (p === pageKey()) redraw();
    socket.emit('annotation_clear', { page: p });
  }

  function onAnnotationsSync(payload) {
    if (!payload || typeof payload !== 'object') return;
    const page = pageKey(payload.page);
    setStrokes(page, payload.strokes || []);
    if (page === pageKey()) {
      ensureCanvas();
      redraw();
    }
  }

  function onAnnotationAdd(stroke) {
    if (!stroke || typeof stroke !== 'object') return;
    const page = pageKey(stroke.page);
    const list = getStrokes(page);
    if (list.some((s) => s.id === stroke.id)) return;
    list.push(stroke);
    if (page === pageKey()) {
      ensureCanvas();
      redraw();
    }
  }

  function onAnnotationClear(payload) {
    const page = pageKey(payload?.page);
    setStrokes(page, []);
    if (page === pageKey()) {
      currentStroke = null;
      redraw();
    }
  }

  function requestPage(page = pageKey()) {
    socket.emit('annotation_request', { page: pageKey(page) });
  }

  function onPageRendered() {
    ensureToolbar();
    ensureCanvas();
    requestPage();
    redraw();
  }

  function onRoomPageChanged() {
    currentStroke = null;
    drawing = false;
    ensureCanvas();
    requestPage();
    redraw();
  }

  function bindSocket() {
    if (bound) return;
    bound = true;
    socket.on('annotations_sync', onAnnotationsSync);
    socket.on('annotation_add', onAnnotationAdd);
    socket.on('annotation_clear', onAnnotationClear);
  }

  function start() {
    bindSocket();
    ensureToolbar();
    ensureCanvas();

    if (typeof ResizeObserver !== 'undefined' && mushafHost && !resizeObserver) {
      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          ensureCanvas();
          redraw();
        });
      });
      resizeObserver.observe(mushafHost);
    }

    window.addEventListener('resize', () => {
      window.requestAnimationFrame(() => {
        ensureCanvas();
        redraw();
      });
    });

    // Parent classroom dock boleh hantar alat anotasi.
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source !== 'alhelmi-classroom') return;
      if (data.type === 'annotation-tool' && typeof data.tool === 'string') {
        setTool(data.tool);
      }
      if (data.type === 'annotation-clear') {
        clearPage(pageKey());
      }
    });
  }

  return {
    start,
    onPageRendered,
    onRoomPageChanged,
    setTool,
    clearPage,
    refresh: () => {
      ensureToolbar();
      ensureCanvas();
      redraw();
    },
  };
}
