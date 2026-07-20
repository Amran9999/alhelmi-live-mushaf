const params = new URLSearchParams(window.location.search);
const roomId = params.get('room') || 'demo';
const roleParam = (params.get('role') || 'student').trim().toLowerCase();
const role = roleParam === 'teacher' || roleParam === 'guru' ? 'teacher' : 'student';
const viewerUserId = (params.get('userid') || params.get('userId') || '').trim();

const ZOOM_KEY = 'alhelmi-mushaf-zoom';
const FOLLOW_KEY = `alhelmi-mushaf-follow:${roomId}`;
const MENU_COLLAPSED_KEY = 'alhelmi-mushaf-menu-collapsed';
const ZOOM_MIN = 70;
const ZOOM_MAX = 180;
const ZOOM_STEP = 10;
const MUSHAF_BASE_WIDTH = 900;
const MUSHAF_FETCH_WIDTH = 1200;
const TEACHER_DEFAULT_ZOOM = 100;
const STUDENT_DEFAULT_ZOOM = 100;

const els = {
  roomLabel: document.getElementById('room-label'),
  roleLabel: document.getElementById('role-label'),
  teacherToolbar: document.getElementById('teacher-toolbar'),
  studentToolbar: document.getElementById('student-toolbar'),
  hiddenScreen: document.getElementById('hidden-screen'),
  hiddenScope: document.getElementById('hidden-scope'),
  viewerShell: document.getElementById('viewer-shell'),
  viewerScale: document.getElementById('viewer-scale'),
  mushafHost: document.getElementById('mushaf-host'),
  mushafFrame: document.getElementById('mushaf-frame'),
  locationLabel: document.getElementById('location-label'),
  mushafCtxJuz: document.getElementById('mushaf-ctx-juz'),
  mushafCtxPage: document.getElementById('mushaf-ctx-page'),
  mushafCtxSurah: document.getElementById('mushaf-ctx-surah'),
  statusLabel: document.getElementById('status-label'),
  surahSearch: document.getElementById('surah-search'),
  surahResults: document.getElementById('surah-results'),
  surahCombo: document.getElementById('surah-combo'),
  surahSelectionHint: document.getElementById('surah-selection-hint'),
  juzGrid: document.getElementById('juz-grid'),
  juzSearch: document.getElementById('juz-search'),
  pageInput: document.getElementById('page-input'),
  scopeInput: document.getElementById('scope-input'),
  zoomLabel: document.getElementById('zoom-label'),
  studentZoomLabel: document.getElementById('student-zoom-label'),
  pageLabel: document.getElementById('page-label'),
  studentModeLabel: document.getElementById('student-mode-label'),
  studentPageLabel: document.getElementById('student-page-label'),
  studentHint: document.getElementById('student-hint'),
  studentFollowSeg: document.getElementById('student-follow-seg'),
  studentModeFree: document.getElementById('student-mode-free'),
  studentModeFollow: document.getElementById('student-mode-follow'),
  studentPageNav: document.getElementById('student-page-nav'),
  syncZoom: document.getElementById('sync-zoom'),
  toggleHide: document.getElementById('toggle-hide'),
  webcamTeacher: document.getElementById('webcam-teacher'),
  webcamStudents: document.getElementById('webcam-students'),
  toggleMenu: document.getElementById('toggle-menu'),
  toggleMenuLabel: document.getElementById('toggle-menu-label'),
};

let navData = null;
let surahCatalog = [];
let activeNavTab = 'surah';
let selectedSurah = 1;
let selectedJuz = 1;
let surahDropdownIndex = -1;
let roomState = null;
let studentZoom = Number(localStorage.getItem(ZOOM_KEY)) || STUDENT_DEFAULT_ZOOM;
/** Pelajar bebas by default; “Ikut guru” disimpan per bilik. */
let studentFollowTeacher = localStorage.getItem(FOLLOW_KEY) === '1';
let studentLocalPage = 1;
let wasActiveReader = false;
let renderToken = 0;
let lastRenderedPage = null;
let renderInFlightForPage = null;
const pageSvgCache = new Map();
const PAGE_CACHE_MAX = 30;

const socket = io();
const modeLabels = {
  bacaan: 'Bacaan',
  hafazan: 'Hafazan',
};

init();

async function init() {
  els.roomLabel.textContent = `Bilik: ${roomId}`;
  els.roleLabel.textContent = role === 'teacher' ? 'Guru' : 'Pelajar';
  document.body.classList.add(role === 'teacher' ? 'role-teacher' : 'role-student');

  try {
    navData = await fetch('/data/navigation.json').then((r) => r.json());
    populateNavSelects();
    bindUi();
    bindAyahClicks();
  } catch (error) {
    console.error('Init gagal:', error);
    els.statusLabel.textContent = 'Ralat memuatkan kawalan â€” muat semula halaman';
  }

  roomState = {
    mode: 'bacaan',
    page: 1,
    hidden: false,
    teacherZoom: TEACHER_DEFAULT_ZOOM,
    syncZoom: false,
    highlightedVerse: null,
  highlightedAyahs: [],
  scopeLabel: '',
  webcamLayout: 'pip',
  webcamTeacher: false,
  webcamStudents: false,
  activeReaderId: null,
  activeReaderName: '',
};

  updateZoomLabels();
  if (role === 'teacher') {
    initMenuToggle();
    syncTopbarHeight();
    window.addEventListener('resize', syncTopbarHeight);
  }
  socket.emit('join', { roomId, role });
  socket.on('state', applyRoomState);
  socket.on('joined', () => setConnectionStatus(true));
  socket.on('connect', () => setConnectionStatus(true));
  socket.on('disconnect', () => setConnectionStatus(false));
}

function syncTopbarHeight() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  document.documentElement.style.setProperty('--topbar-height', `${topbar.offsetHeight}px`);
}

function setMenuCollapsed(collapsed, { persist = true } = {}) {
  document.body.classList.toggle('menu-collapsed', collapsed);
  if (els.toggleMenu) {
    els.toggleMenu.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    els.toggleMenu.title = collapsed ? 'Paparkan menu kawalan' : 'Sembunyikan menu kawalan';
  }
  if (els.toggleMenuLabel) {
    els.toggleMenuLabel.textContent = collapsed ? 'Kawalan' : 'Sembunyi';
  }
  if (persist) {
    sessionStorage.setItem(MENU_COLLAPSED_KEY, collapsed ? '1' : '0');
  }
}

function toggleMenu() {
  setMenuCollapsed(!document.body.classList.contains('menu-collapsed'));
}

function initMenuToggle() {
  // The mushaf itself is the teaching surface. Start with controls tucked away
  // unless the guru explicitly chose to keep them open in this browser tab.
  const saved = sessionStorage.getItem(MENU_COLLAPSED_KEY);
  const collapsed = saved === null ? true : saved === '1';
  setMenuCollapsed(collapsed, { persist: false });
  els.toggleMenu?.addEventListener('click', toggleMenu);

  const moreBtn = document.getElementById('toolbar-more-btn');
  const morePanel = document.getElementById('toolbar-more');
  moreBtn?.addEventListener('click', () => {
    if (!morePanel) return;
    const open = morePanel.hasAttribute('hidden');
    if (open) morePanel.removeAttribute('hidden');
    else morePanel.setAttribute('hidden', '');
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

function setConnectionStatus(connected) {
  if (connected) {
    els.statusLabel.textContent = 'Disambung';
    els.statusLabel.classList.add('is-live');
  } else {
    els.statusLabel.textContent = 'Terputus â€” cuba sambung semulaâ€¦';
    els.statusLabel.classList.remove('is-live');
  }
}

function populateNavSelects() {
  surahCatalog = [];
  for (let i = 1; i <= 114; i += 1) {
    const name = navData.surahNames[String(i)] || `Surah ${i}`;
    surahCatalog.push({ num: i, name, page: navData.surahStartPage[String(i)] || 1 });
  }

  renderJuzGrid();
  selectSurah(1, { updateInput: true, closeDropdown: true });
}

function renderJuzGrid() {
  if (!els.juzGrid) return;
  els.juzGrid.innerHTML = '';

  for (let j = 1; j <= 30; j += 1) {
    const startPage = navData.juzStartPage[String(j)] || 1;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'juz-chip';
    chip.dataset.juz = String(j);
    chip.dataset.search = `juzuk ${j} hal ${startPage}`;
    chip.setAttribute('role', 'option');
    chip.innerHTML = `${j}<small>hal. ${startPage}</small>`;
    chip.addEventListener('click', () => {
      selectedJuz = j;
      highlightJuzChip(j);
      switchNavTab('juz');
    });
    els.juzGrid.appendChild(chip);
  }
  highlightJuzChip(selectedJuz);
}

function highlightJuzChip(juz) {
  els.juzGrid?.querySelectorAll('.juz-chip').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.juz) === juz);
    chip.setAttribute('aria-selected', chip.classList.contains('active') ? 'true' : 'false');
  });
}

function filterJuzGrid() {
  const query = els.juzSearch?.value.trim().toLowerCase() || '';
  els.juzGrid?.querySelectorAll('.juz-chip').forEach((chip) => {
    const haystack = chip.dataset.search || chip.textContent.toLowerCase();
    chip.hidden = Boolean(query && !haystack.includes(query));
  });
}

function getFilteredSurahs() {
  const query = els.surahSearch?.value.trim().toLowerCase() || '';
  if (!query) return surahCatalog;
  return surahCatalog.filter((item) => {
    const haystack = `${item.num} ${item.name}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderSurahDropdown() {
  const items = getFilteredSurahs();
  els.surahResults.innerHTML = '';
  surahDropdownIndex = -1;

  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.surah = String(item.num);
    li.dataset.index = String(index);
    li.innerHTML = `
      <span><span class="surah-num">${item.num}.</span> ${item.name}</span>
      <span class="surah-page">hal. ${item.page}</span>`;
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectSurah(item.num);
      closeSurahDropdown();
    });
    els.surahResults.appendChild(li);
  });

  const open = items.length > 0;
  els.surahResults.hidden = !open;
  els.surahSearch.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function highlightSurahDropdownItem(index) {
  const items = [...els.surahResults.querySelectorAll('li')];
  items.forEach((li, i) => li.classList.toggle('active', i === index));
  surahDropdownIndex = index;
  items[index]?.scrollIntoView({ block: 'nearest' });
}

function openSurahDropdown() {
  renderSurahDropdown();
}

function closeSurahDropdown() {
  els.surahResults.hidden = true;
  els.surahSearch.setAttribute('aria-expanded', 'false');
  surahDropdownIndex = -1;
}

function selectSurah(num, { updateInput = true, closeDropdown = false } = {}) {
  selectedSurah = num;
  const item = surahCatalog.find((s) => s.num === num);
  if (updateInput && item) {
    els.surahSearch.value = `${item.num}. ${item.name}`;
    els.surahSelectionHint.textContent = `Halaman mula: ${item.page}`;
  }
  if (closeDropdown) closeSurahDropdown();
}

function filterSurahList() {
  openSurahDropdown();
}

function switchNavTab(tab) {
  activeNavTab = tab;
  document.querySelectorAll('[data-nav-tab]').forEach((btn) => {
    const active = btn.getAttribute('data-nav-tab') === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.getElementById('nav-panel-surah').hidden = tab !== 'surah';
  document.getElementById('nav-panel-juz').hidden = tab !== 'juz';
  document.getElementById('nav-panel-page').hidden = tab !== 'page';
}

function syncNavControlsToPage(page) {
  if (role !== 'teacher' || !navData) return;

  const surah = getSurahAtPage(page);
  const juz = getJuzAtPage(page);

  selectedSurah = surah;
  selectedJuz = juz;
  selectSurah(surah, { updateInput: true, closeDropdown: true });
  highlightJuzChip(juz);
  els.pageInput.value = String(page);
}

function getSurahAtPage(page) {
  let surah = 1;
  for (let i = 1; i <= 114; i += 1) {
    const start = navData.surahStartPage[String(i)] || 1;
    if (start <= page) surah = i;
    else break;
  }
  return surah;
}

function getJuzAtPage(page) {
  let juz = 1;
  for (let j = 1; j <= 30; j += 1) {
    const start = navData.juzStartPage[String(j)] || 1;
    if (start <= page) juz = j;
    else break;
  }
  return juz;
}

function getSurahName(num) {
  return navData?.surahNames?.[String(num)] || `Surah ${num}`;
}

function formatSurahBadge(num, name) {
  const label = name
    .toUpperCase()
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${num} ${label}`;
}

function getSurahsOnPageFromSvg(svg) {
  const surahs = new Set();
  svg?.querySelectorAll('[data-ayah]').forEach((node) => {
    const surah = Number(node.getAttribute('data-ayah')?.split(':')[0]);
    if (surah) surahs.add(surah);
  });
  return [...surahs].sort((a, b) => a - b);
}

function getDisplaySurahForPage(page, svg) {
  const surahsOnPage = getSurahsOnPageFromSvg(svg);
  if (surahsOnPage.length === 1) return surahsOnPage[0];

  const startingOnPage = surahsOnPage.filter(
    (num) => (navData?.surahStartPage?.[String(num)] || 0) === page,
  );
  if (startingOnPage.length) return startingOnPage[0];

  if (surahsOnPage.length > 1) return surahsOnPage[surahsOnPage.length - 1];
  return getSurahAtPage(page);
}

function updateLocationLabel(page, svg = null) {
  if (!navData) return;

  const juz = getJuzAtPage(page);
  const surah = svg ? getDisplaySurahForPage(page, svg) : getSurahAtPage(page);
  const surahName = getSurahName(surah);

  if (els.mushafCtxJuz) els.mushafCtxJuz.textContent = `JUZ ${juz}`;
  if (els.mushafCtxPage) els.mushafCtxPage.textContent = String(page);
  if (els.mushafCtxSurah) els.mushafCtxSurah.textContent = formatSurahBadge(surah, surahName);

  if (els.locationLabel) {
    els.locationLabel.textContent = `Lokasi: ${surahName} Â· Juzuk ${juz} Â· Hal. ${page}`;
  }
}

function resolveSurahFromFilter() {
  const query = els.surahSearch.value.trim().toLowerCase();
  if (!query) return selectedSurah || 1;

  const filtered = getFilteredSurahs();
  if (filtered.length === 1) return filtered[0].num;

  const exact = surahCatalog.find((item) => {
    const haystack = `${item.num} ${item.name}`.toLowerCase();
    return haystack === query || String(item.num) === query;
  });
  if (exact) return exact.num;

  return filtered[0]?.num || selectedSurah || 1;
}

function clampPage(value) {
  return Math.min(604, Math.max(1, Number(value) || 1));
}

function bindUi() {
  if (role === 'teacher') {
    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        document.querySelectorAll('[data-mode]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        teacherPatch({ mode });
      });
    });

    document.querySelectorAll('[data-nav-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchNavTab(btn.getAttribute('data-nav-tab')));
    });

    els.surahSearch.addEventListener('input', filterSurahList);
    els.surahSearch.addEventListener('focus', openSurahDropdown);
    els.surahSearch.addEventListener('keydown', (event) => {
      const items = [...els.surahResults.querySelectorAll('li')];
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (els.surahResults.hidden) openSurahDropdown();
        highlightSurahDropdownItem(Math.min(surahDropdownIndex + 1, items.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlightSurahDropdownItem(Math.max(surahDropdownIndex - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (surahDropdownIndex >= 0 && items[surahDropdownIndex]) {
          selectSurah(Number(items[surahDropdownIndex].dataset.surah));
          closeSurahDropdown();
        }
        goNavigation();
      } else if (event.key === 'Escape') {
        closeSurahDropdown();
      }
    });

    document.addEventListener('click', (event) => {
      if (!els.surahCombo.contains(event.target)) {
        closeSurahDropdown();
      }
    });

    els.juzSearch?.addEventListener('input', filterJuzGrid);

    els.pageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        switchNavTab('page');
        goNavigation();
      }
    });

    document.getElementById('page-input-inc')?.addEventListener('click', () => {
      els.pageInput.value = String(clampPage(Number(els.pageInput.value) + 1));
      switchNavTab('page');
    });
    document.getElementById('page-input-dec')?.addEventListener('click', () => {
      els.pageInput.value = String(clampPage(Number(els.pageInput.value) - 1));
      switchNavTab('page');
    });

    document.getElementById('go-nav').addEventListener('click', goNavigation);
    document.getElementById('zoom-in').addEventListener('click', () => changeTeacherZoom(ZOOM_STEP));
    document.getElementById('zoom-out').addEventListener('click', () => changeTeacherZoom(-ZOOM_STEP));
    document.getElementById('page-prev')?.addEventListener('click', () => changePage(-1));
    document.getElementById('page-next')?.addEventListener('click', () => changePage(1));
    document.getElementById('mushaf-page-prev')?.addEventListener('click', () => changePage(-1));
    document.getElementById('mushaf-page-next')?.addEventListener('click', () => changePage(1));
    bindPagePrefetch('mushaf-page-prev', -1);
    bindPagePrefetch('mushaf-page-next', 1);
    bindPagePrefetch('page-prev', -1);
    bindPagePrefetch('page-next', 1);
    document.getElementById('toggle-hide').addEventListener('click', toggleHide);
    document.getElementById('clear-highlight').addEventListener('click', () => {
      teacherPatch({ highlightedVerse: null, highlightedAyahs: [], highlightedWords: [] });
    });
    document.getElementById('fullscreen').addEventListener('click', toggleFullscreen);
    els.syncZoom.addEventListener('change', () => {
      teacherPatch({ syncZoom: els.syncZoom.checked, teacherZoom: roomState?.teacherZoom ?? 100 });
    });
    els.scopeInput.addEventListener('change', () => {
      teacherPatch({ scopeLabel: els.scopeInput.value.trim() });
    });
    bindWebcamControls();

    document.addEventListener('keydown', (event) => {
      if (event.target.closest('input, textarea, select')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        changePage(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        changePage(1);
      }
    });
  } else {
    document.getElementById('student-zoom-in').addEventListener('click', () => changeStudentZoom(ZOOM_STEP));
    document.getElementById('student-zoom-out').addEventListener('click', () => changeStudentZoom(-ZOOM_STEP));
    document.getElementById('student-fullscreen')?.addEventListener('click', toggleFullscreen);
    els.studentModeFree?.addEventListener('click', () => setStudentFollow(false));
    els.studentModeFollow?.addEventListener('click', () => setStudentFollow(true));
    document.getElementById('student-page-prev')?.addEventListener('click', () => changePage(-1));
    document.getElementById('student-page-next')?.addEventListener('click', () => changePage(1));
    document.getElementById('mushaf-page-prev')?.addEventListener('click', () => changePage(-1));
    document.getElementById('mushaf-page-next')?.addEventListener('click', () => changePage(1));
    bindPagePrefetch('student-page-prev', -1);
    bindPagePrefetch('student-page-next', 1);
    bindPagePrefetch('mushaf-page-prev', -1);
    bindPagePrefetch('mushaf-page-next', 1);
    document.addEventListener('keydown', (event) => {
      if (event.target.closest('input, textarea, select')) return;
      if (isStudentTurnLocked() || isStudentFollowing()) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        changePage(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        changePage(1);
      }
    });
    updateStudentFollowUi();
  }
}

/** Giliran aktif: kunci ikut guru sahaja. */
function isStudentTurnLocked() {
  if (role !== 'student' || !viewerUserId || !roomState) return false;
  const activeReaderId = roomState.activeReaderId ? String(roomState.activeReaderId) : null;
  return Boolean(activeReaderId && activeReaderId === viewerUserId);
}

/** Ikut halaman/highlight guru (pilihan atau dikunci). */
function isStudentFollowing() {
  if (role !== 'student') return false;
  return isStudentTurnLocked() || studentFollowTeacher;
}

function getEffectivePage() {
  if (!roomState) return 1;
  if (role === 'teacher' || isStudentFollowing()) return roomState.page || 1;
  return studentLocalPage || roomState.page || 1;
}

function setStudentFollow(follow) {
  if (role !== 'student') return;
  if (isStudentTurnLocked()) {
    studentFollowTeacher = true;
    updateStudentFollowUi();
    return;
  }
  studentFollowTeacher = Boolean(follow);
  localStorage.setItem(FOLLOW_KEY, studentFollowTeacher ? '1' : '0');
  if (studentFollowTeacher && roomState?.page) {
    studentLocalPage = roomState.page;
  }
  updateStudentFollowUi();
  renderMushaf();
}

function updateStudentFollowUi() {
  if (role !== 'student') return;
  const locked = isStudentTurnLocked();
  const following = isStudentFollowing();
  const page = getEffectivePage();

  els.studentModeFree?.classList.toggle('active', !following);
  els.studentModeFollow?.classList.toggle('active', following);
  els.studentModeFree && (els.studentModeFree.disabled = locked);
  els.studentModeFollow && (els.studentModeFollow.disabled = locked);
  els.studentFollowSeg?.classList.toggle('is-locked', locked);
  els.studentPageNav?.classList.toggle('is-disabled', following);
  document.getElementById('student-page-prev') &&
    (document.getElementById('student-page-prev').disabled = following || page <= 1);
  document.getElementById('student-page-next') &&
    (document.getElementById('student-page-next').disabled = following || page >= 604);
  if (els.studentPageLabel) els.studentPageLabel.textContent = `${page} / 604`;

  document.body.classList.toggle('student-follow', following);
  document.body.classList.toggle('student-free', !following);
  document.body.classList.toggle('student-turn-locked', locked);

  updatePageNavButtons(page);

  ['mushaf-page-prev', 'mushaf-page-next', 'student-page-prev', 'student-page-next'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (following) {
      btn.disabled = true;
      return;
    }
    if (id.includes('prev')) btn.disabled = page <= 1;
    else btn.disabled = page >= 604;
  });

  if (els.studentHint) {
    if (locked) {
      els.studentHint.textContent =
        'Giliran anda — mushaf dikunci ikut guru sehingga giliran tamat.';
    } else if (following) {
      els.studentHint.textContent =
        'Mengikut halaman guru. Tukar ke “Baca sendiri” untuk navigasi bebas.';
    } else {
      els.studentHint.textContent =
        'Baca sendiri — pilih “Ikut guru” jika mahu ikut halaman kelas.';
    }
  }
}

function bindWebcamControls() {
  document.querySelectorAll('[data-webcam-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const layout = btn.getAttribute('data-webcam-layout');
      if (!layout) return;
      document.querySelectorAll('[data-webcam-layout]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      teacherPatch({ webcamLayout: layout });
    });
  });

  els.webcamTeacher?.addEventListener('change', () => {
    teacherPatch({ webcamTeacher: els.webcamTeacher.checked });
  });
  els.webcamStudents?.addEventListener('change', () => {
    teacherPatch({ webcamStudents: els.webcamStudents.checked });
  });
}

function notifyParentBbb(state) {
  if (role !== 'teacher' || window.parent === window) return;
  window.parent.postMessage(
    {
      source: 'alhelmi-mushaf',
      type: 'bbb-control',
      webcamLayout: state.webcamLayout ?? 'pip',
      webcamTeacher: Boolean(state.webcamTeacher),
      webcamStudents: Boolean(state.webcamStudents),
      roomId,
    },
    '*',
  );
}

function syncWebcamControls(state) {
  const layout = state.webcamLayout || 'pip';
  document.querySelectorAll('[data-webcam-layout]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-webcam-layout') === layout);
  });
  if (els.webcamTeacher) els.webcamTeacher.checked = Boolean(state.webcamTeacher);
  if (els.webcamStudents) els.webcamStudents.checked = Boolean(state.webcamStudents);
}

function bindAyahClicks() {
  if (role !== 'teacher') return;

  els.mushafHost.addEventListener('click', (event) => {
    const node = event.target.closest('[data-ayah]');
    if (!node) return;

    const key = node.getAttribute('data-ayah');
    if (!key) return;

    const [surah, verse] = key.split(':').map(Number);
    if (!surah || !verse) return;

    toggleAyahHighlight(key);
  });
}

function toggleAyahHighlight(key) {
  const current = new Set(roomState?.highlightedAyahs || []);
  if (current.has(key)) {
    current.delete(key);
  } else {
    current.add(key);
  }

  const list = [...current];
  let highlightedVerse = null;
  if (list.length) {
    const last = list[list.length - 1];
    const [s, v] = last.split(':').map(Number);
    highlightedVerse = { surah: s, verse: v };
  }

  if (roomState) {
    roomState.highlightedAyahs = list;
    roomState.highlightedVerse = highlightedVerse;
    applyAyahHighlights();
  }

  teacherPatch({
    highlightedAyahs: list,
    highlightedVerse,
    highlightedWords: [],
  });
}

function goNavigation() {
  let page = 1;

  if (activeNavTab === 'juz') {
    page = navData.juzStartPage[String(selectedJuz)] || 1;
  } else if (activeNavTab === 'page') {
    page = clampPage(els.pageInput.value);
  } else {
    const surah = resolveSurahFromFilter();
    page = navData.surahStartPage[String(surah)] || 1;
    selectSurah(surah, { updateInput: true, closeDropdown: true });
  }

  teacherPatch({ page });
}

function changePage(delta) {
  if (role === 'student') {
    if (isStudentTurnLocked() || isStudentFollowing()) return;
    const page = Math.min(604, Math.max(1, getEffectivePage() + delta));
    studentLocalPage = page;
    updateStudentFollowUi();
    updateLocationLabel(page);
    renderMushaf();
    return;
  }

  const page = Math.min(604, Math.max(1, (roomState?.page || 1) + delta));
  if (roomState) roomState.page = page;
  els.pageLabel.textContent = `Halaman ${page} / 604`;
  syncNavControlsToPage(page);
  updatePageNavButtons(page);
  updateLocationLabel(page);
  renderMushaf();
  teacherPatch({ page });
}

function prefetchPage(page) {
  if (page < 1 || page > 604 || pageSvgCache.has(page)) return;
  fetchPageSvg(page).catch(() => {});
}

function prefetchAroundPage(page) {
  prefetchPage(page - 1);
  prefetchPage(page + 1);
  prefetchPage(page + 2);
}

function rememberPageSvg(page, svgText) {
  if (pageSvgCache.has(page)) pageSvgCache.delete(page);
  pageSvgCache.set(page, svgText);
  while (pageSvgCache.size > PAGE_CACHE_MAX) {
    const oldest = pageSvgCache.keys().next().value;
    pageSvgCache.delete(oldest);
  }
}

async function fetchPageSvg(page) {
  if (pageSvgCache.has(page)) {
    const cached = pageSvgCache.get(page);
    pageSvgCache.delete(page);
    pageSvgCache.set(page, cached);
    return cached;
  }
  const res = await fetch(`/mushaf/page/${page}.svg?width=${MUSHAF_FETCH_WIDTH}&theme=light`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const svgText = await res.text();
  rememberPageSvg(page, svgText);
  return svgText;
}

function mountPageSvg(svgText, page) {
  els.mushafHost.innerHTML = svgText;
  const svg = els.mushafHost.querySelector('svg');
  if (svg) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Mushaf halaman ${page}`);
    svg.classList.add('mushaf-svg');
    fixBismillahLayout(svg, page);
    stripSvgPageChrome(svg);
    applyMushafPageTheme(svg);
    enhanceSurahHeaders(svg, page);
    updateLocationLabel(page, svg);
  }
  lastRenderedPage = page;
  applyZoomTransform();
  applyAyahHighlights();
  prefetchAroundPage(page);
}

function bindPagePrefetch(buttonId, delta) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.addEventListener('mouseenter', () => {
    const target = getEffectivePage() + delta;
    prefetchPage(target);
  });
  btn.addEventListener('focus', () => {
    const target = getEffectivePage() + delta;
    prefetchPage(target);
  });
}

function updatePageNavButtons(page) {
  const atStart = page <= 1;
  const atEnd = page >= 604;
  ['page-prev', 'page-next', 'mushaf-page-prev', 'mushaf-page-next'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (id.includes('prev')) btn.disabled = atStart;
    else btn.disabled = atEnd;
  });
}

function changeTeacherZoom(delta) {
  const current = roomState?.teacherZoom ?? 100;
  const next = clampZoom(current + delta);
  if (roomState) roomState.teacherZoom = next;
  applyZoomTransform();
  teacherPatch({ teacherZoom: next });
}

function changeStudentZoom(delta) {
  studentZoom = clampZoom(studentZoom + delta);
  localStorage.setItem(ZOOM_KEY, String(studentZoom));
  applyZoomTransform();
}

function toggleHide() {
  const hidden = !(roomState?.hidden ?? false);
  teacherPatch({ hidden });
}

function teacherPatch(patch) {
  socket.emit('teacher_update', patch);
  if (roomState) {
    roomState = { ...roomState, ...patch };
    if (
      patch.webcamLayout !== undefined
      || patch.webcamTeacher !== undefined
      || patch.webcamStudents !== undefined
    ) {
      notifyParentBbb(roomState);
    }
  }
}

function applyRoomState(state) {
  if (state.mode === 'tajwid') {
    state = { ...state, mode: 'bacaan' };
  }
  roomState = state;

  const activeReaderId = state.activeReaderId ? String(state.activeReaderId) : null;
  const activeReaderName = state.activeReaderName || '';
  const isActiveBatchReader =
    role === 'student' && activeReaderId && viewerUserId && activeReaderId === viewerUserId;
  const batchWaiting =
    role === 'student' && activeReaderId && viewerUserId && activeReaderId !== viewerUserId;
  const batchNoReaderYet = role === 'student' && !activeReaderId && viewerUserId;

  if (role === 'student') {
    if (isActiveBatchReader && !wasActiveReader) {
      // Giliran bermula → kunci ikut guru
      studentFollowTeacher = true;
    } else if (!isActiveBatchReader && wasActiveReader) {
      // Giliran tamat → bebaskan semula
      studentFollowTeacher = false;
      localStorage.setItem(FOLLOW_KEY, '0');
    }
    wasActiveReader = isActiveBatchReader;

    if (isStudentFollowing() && state.page) {
      studentLocalPage = state.page;
    }
  }

  if (role === 'teacher') {
    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === state.mode);
    });
    els.scopeInput.value = state.scopeLabel || '';
    els.syncZoom.checked = Boolean(state.syncZoom);
    els.toggleHide.textContent = state.hidden
      ? 'Tunjukkan mushaf pelajar'
      : 'Sembunyikan mushaf pelajar';
    els.pageLabel.textContent = `Halaman ${state.page} / 604`;
    syncNavControlsToPage(state.page);
    updatePageNavButtons(state.page);
    syncWebcamControls(state);
  } else {
    els.studentModeLabel.textContent = `Mod: ${modeLabels[state.mode] || state.mode}`;
    updateStudentFollowUi();
  }

  const displayPage = getEffectivePage();
  updateLocationLabel(displayPage);

  // Default: tunjuk mushaf kepada semua pelajar. Sembunyi hanya bila guru tekan toggle.
  const studentShouldHide = role === 'student' && state.hidden;

  if (role === 'teacher') {
    els.hiddenScreen.hidden = true;
    els.viewerShell.hidden = false;
    if (els.mushafFrame) els.mushafFrame.hidden = false;
    if (activeReaderName) {
      els.statusLabel.textContent = `Pembaca aktif: ${activeReaderName}`;
    }
  } else {
    els.hiddenScreen.hidden = !studentShouldHide;
    els.viewerShell.hidden = studentShouldHide;
    if (els.mushafFrame) els.mushafFrame.hidden = studentShouldHide;
    if (isActiveBatchReader && !studentShouldHide) {
      els.statusLabel.textContent = 'Giliran anda — sila baca (mushaf dikunci ikut guru)';
    } else if (batchNoReaderYet && !studentShouldHide) {
      els.statusLabel.textContent = isStudentFollowing()
        ? 'Mengikut guru — atau tukar ke Baca sendiri.'
        : 'Baca sendiri — atau pilih Ikut guru.';
    } else if (batchWaiting && !studentShouldHide) {
      els.statusLabel.textContent = isStudentFollowing()
        ? `${activeReaderName || 'Pelajar lain'} membaca — anda ikut guru.`
        : `${activeReaderName || 'Pelajar lain'} sedang membaca. Anda bebas navigasi.`;
    }
  }

  if (studentShouldHide) {
    els.hiddenScope.textContent =
      state.scopeLabel ||
      'Guru menyembunyikan mushaf (contoh: ujian hafazan). Minta guru tekan “Tunjukkan mushaf pelajar” untuk ikut bacaan.';
    return;
  }

  const svg = els.mushafHost.querySelector('.mushaf-svg');
  const pageChanged = displayPage !== lastRenderedPage;

  if ((pageChanged || !svg) && renderInFlightForPage !== displayPage) {
    renderMushaf();
    return;
  }

  applyZoomTransform();
  applyAyahHighlights();
  updateLocationLabel(displayPage, svg);
}

function applyZoomTransform() {
  const zoom = getEffectiveZoom();
  const displayWidth = Math.round(MUSHAF_BASE_WIDTH * (zoom / 100));
  const svg = els.mushafHost.querySelector('.mushaf-svg');

  if (svg) {
    svg.style.width = `${displayWidth}px`;
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
  }

  els.viewerScale.style.transform = 'none';
  document.documentElement.style.setProperty(
    '--mushaf-width',
    `${displayWidth + 80}px`,
  );
  updateZoomLabels();
  applyAyahHighlights();
}

async function renderMushaf() {
  if (!roomState) return;

  const page = getEffectivePage();
  const token = ++renderToken;
  renderInFlightForPage = page;
  const hasCachedSvg = pageSvgCache.has(page);
  const hasVisibleSvg = Boolean(els.mushafHost.querySelector('.mushaf-svg'));

  if (hasCachedSvg) {
    mountPageSvg(pageSvgCache.get(page), page);
    renderInFlightForPage = null;
    return;
  }

  els.mushafHost.classList.add('is-loading');
  if (!hasVisibleSvg) {
    els.mushafHost.innerHTML = '<p class="mushaf-loading">Memuatkan halaman mushafâ€¦</p>';
  }

  try {
    const svgText = await fetchPageSvg(page);
    if (token !== renderToken) return;
    mountPageSvg(svgText, page);
  } catch {
    if (token !== renderToken) return;
    lastRenderedPage = null;
    els.mushafHost.innerHTML = `
      <p class="mushaf-error">
        Gagal memuatkan halaman ${page}.
        <button type="button" class="btn" id="retry-mushaf">Cuba lagi</button>
      </p>`;
    document.getElementById('retry-mushaf')?.addEventListener('click', () => renderMushaf());
  } finally {
    if (token === renderToken) {
      els.mushafHost.classList.remove('is-loading');
      renderInFlightForPage = null;
    }
  }
}

const BISMILLAH_UTS = '\u0628\u0633\u0645 \u0627\u0644\u0644\u0647 \u0627\u0644\u0631\u062d\u0645\u0646 \u0627\u0644\u0631\u062d\u064a\u0645';
const MUSHAF_BRAND_TITLE = 'AlHelmi Quran';
const MUSHAF_PAGE_BG = '#e8f5e9';
const MUSHAF_SURAH_BAND = '#b8ddb8';
const MUSHAF_SURAH_BAND_STROKE = '#7aab8a';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Buang header margin SVG â€” info sudah ada di bar teal (JUZ Â· hal Â· surah). */
function stripSvgPageChrome(svg) {
  svg.querySelectorAll('text').forEach((node) => {
    const y = Number(node.getAttribute('y') || 0);
    if (y > 35) return;

    const text = node.textContent?.trim() || '';
    const isHizb = /^HIZB\s*\d/i.test(text);
    const isJuz = /^JUZ\s*\d/i.test(text);
    const isBrand = /islamic\.app/i.test(text) || text === MUSHAF_BRAND_TITLE;

    if (isHizb || isJuz || isBrand) {
      node.remove();
    }
  });
}

function applyMushafPageTheme(svg) {
  if (svg.classList.contains('alhelmi-themed')) return;
  svg.classList.add('alhelmi-themed');

  const pageBg = svg.querySelector(':scope > rect');
  if (pageBg) pageBg.setAttribute('fill', MUSHAF_PAGE_BG);

  svg.querySelectorAll('[fill="#faf7f0"],[fill="#fcf2d9"],[fill="#fffbf0"],[fill="#f2e19f"],[fill="#eedc9a"],[fill="#f2f8f2"],[fill="#e3efe3"]').forEach((node) => {
    node.setAttribute('fill', MUSHAF_PAGE_BG);
  });
}

function getSurahsStartingOnPage(page) {
  if (!navData?.surahStartPage) return [];
  return Object.entries(navData.surahStartPage)
    .filter(([, start]) => Number(start) === page)
    .map(([num]) => Number(num))
    .sort((a, b) => a - b);
}

function isSurahTitleText(node) {
  if (node.closest('.alhelmi-surah-title')) return false;
  if (node.getAttribute('data-ayah') || node.querySelector('[data-ayah]')) return false;
  if ((node.getAttribute('fill') || '') === '#998d77') return false;

  const size = Number(node.getAttribute('font-size') || 0);
  return node.getAttribute('font-weight') === 'bold'
    && size >= 14
    && size <= 22
    && node.getAttribute('direction') === 'rtl';
}

function findSurahHeaderRect(svg, headerText) {
  const ty = Number(headerText.getAttribute('y') || 0);
  return [...svg.querySelectorAll('rect[rx]')].find((rect) => {
    const ry = Number(rect.getAttribute('y') || 0);
    const rh = Number(rect.getAttribute('height') || 0);
    const rw = Number(rect.getAttribute('width') || 0);
    return rw > 200 && ty >= ry - 4 && ty <= ry + rh + 6;
  });
}

function enhanceSurahHeaders(svg, page) {
  if (svg.classList.contains('alhelmi-surah-enhanced')) return;
  svg.classList.add('alhelmi-surah-enhanced');

  const headers = [...svg.querySelectorAll('text')].filter(isSurahTitleText);
  const startingSurahs = getSurahsStartingOnPage(page);
  const surahsOnPage = getSurahsOnPageFromSvg(svg);

  headers.forEach((node, index) => {
    const surahNum = startingSurahs[index]
      || startingSurahs[0]
      || surahsOnPage[index]
      || surahsOnPage[0]
      || getSurahAtPage(page);
    const malayName = getSurahName(surahNum);
    const arabicText = node.textContent?.trim() || '';

    const oldSize = Number(node.getAttribute('font-size') || 16);
    const newSize = Math.round(oldSize * 1.35);
    const centerX = Number(node.getAttribute('x') || 450);
    const lineY = Number(node.getAttribute('y') || 0);
    const arabicFont = node.getAttribute('font-family') || '"Noto Naskh Arabic", "Amiri", serif';

    const band = findSurahHeaderRect(svg, node);
    if (band) {
      band.setAttribute('fill', MUSHAF_SURAH_BAND);
      band.setAttribute('fill-opacity', '0.92');
      band.setAttribute('stroke', MUSHAF_SURAH_BAND_STROKE);
      band.setAttribute('stroke-opacity', '0.55');
    }

    const title = svg.ownerDocument.createElementNS(SVG_NS, 'text');
    title.setAttribute('class', 'alhelmi-surah-title');
    title.setAttribute('x', String(centerX));
    title.setAttribute('y', String(lineY));
    title.setAttribute('text-anchor', 'middle');
    title.setAttribute('direction', 'ltr');

    const tMalay = svg.ownerDocument.createElementNS(SVG_NS, 'tspan');
    tMalay.setAttribute('class', 'alhelmi-surah-malay');
    tMalay.setAttribute('font-family', '"Plus Jakarta Sans", "Segoe UI", sans-serif');
    tMalay.setAttribute('font-size', '13');
    tMalay.setAttribute('font-weight', '600');
    tMalay.setAttribute('fill', '#2d5a45');
    tMalay.textContent = `Surah ${malayName}`;

    const tSep = svg.ownerDocument.createElementNS(SVG_NS, 'tspan');
    tSep.setAttribute('class', 'alhelmi-surah-sep');
    tSep.setAttribute('font-family', '"Plus Jakarta Sans", "Segoe UI", sans-serif');
    tSep.setAttribute('font-size', '13');
    tSep.setAttribute('font-weight', '700');
    tSep.setAttribute('fill', '#5a8a6a');
    tSep.textContent = '  Â·  ';

    const tArabic = svg.ownerDocument.createElementNS(SVG_NS, 'tspan');
    tArabic.setAttribute('class', 'alhelmi-surah-arabic');
    tArabic.setAttribute('font-family', arabicFont);
    tArabic.setAttribute('font-size', String(newSize));
    tArabic.setAttribute('font-weight', 'bold');
    tArabic.setAttribute('fill', '#1c1208');
    tArabic.setAttribute('direction', 'rtl');
    tArabic.setAttribute('unicode-bidi', 'embed');
    tArabic.textContent = arabicText;

    title.append(tMalay, tSep, tArabic);
    node.replaceWith(title);
  });
}

/**
 * Al-Fatihah (halaman 1): asal SVG gabung Bismillah + ayat 2 pada satu baris.
 * Pisahkan seperti mushaf cetak â€” Bismillah atas sekali selepas tajuk surah.
 */
function fixBismillahLayout(svg, page) {
  if (page !== 1 || svg.querySelector('.alhelmi-bismillah')) return;

  const ayah1 = svg.querySelector('tspan[data-ayah="1:1"]');
  const ayah2 = svg.querySelector('tspan[data-ayah="1:2"]');
  if (!ayah1 || !ayah2 || ayah1.closest('text') !== ayah2.closest('text')) return;

  const verseBlock = ayah1.closest('text');
  if (!verseBlock) return;

  const bismGroup = buildBismillahGroup(svg.ownerDocument, {
    ayahKey: '1:1',
    centerX: getSvgCenterX(svg),
  });
  verseBlock.parentNode.insertBefore(bismGroup, verseBlock);

  ayah1.remove();

  const firstVerseY = 251.45;
  const currentY = Number(verseBlock.getAttribute('y') || 170.45);
  const shift = firstVerseY - currentY;
  if (shift <= 0) return;

  shiftSvgTextsDown(svg, verseBlock, shift);
  growSvgCanvas(svg, shift);
}

function getSvgCenterX(svg) {
  const vb = svg?.viewBox?.baseVal;
  if (vb && Number.isFinite(vb.x) && Number.isFinite(vb.width) && vb.width > 0) {
    return vb.x + vb.width / 2;
  }
  const widthAttr = Number(svg?.getAttribute('width') || 0);
  if (Number.isFinite(widthAttr) && widthAttr > 0) return widthAttr / 2;
  return 450;
}

function buildBismillahGroup(doc, { ayahKey, centerX = 450 } = {}) {
  const leftLineX1 = centerX - 243;
  const leftLineX2 = centerX - 215;
  const leftDotX = centerX - 207;
  const rightDotX = centerX + 207;
  const rightLineX1 = centerX + 215;
  const rightLineX2 = centerX + 243;
  const g = doc.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'alhelmi-bismillah');

  const leftLine = doc.createElementNS(SVG_NS, 'line');
  leftLine.setAttribute('x1', String(leftLineX1));
  leftLine.setAttribute('y1', '164.375');
  leftLine.setAttribute('x2', String(leftLineX2));
  leftLine.setAttribute('y2', '164.375');
  leftLine.setAttribute('stroke', '#d4a574');
  leftLine.setAttribute('stroke-opacity', '0.55');
  leftLine.setAttribute('stroke-width', '0.8');

  const leftDot = doc.createElementNS(SVG_NS, 'circle');
  leftDot.setAttribute('cx', String(leftDotX));
  leftDot.setAttribute('cy', '164.375');
  leftDot.setAttribute('r', '2.5');
  leftDot.setAttribute('fill', '#d4a574');

  const rightLine = doc.createElementNS(SVG_NS, 'line');
  rightLine.setAttribute('x1', String(rightLineX1));
  rightLine.setAttribute('y1', '164.375');
  rightLine.setAttribute('x2', String(rightLineX2));
  rightLine.setAttribute('y2', '164.375');
  rightLine.setAttribute('stroke', '#d4a574');
  rightLine.setAttribute('stroke-opacity', '0.55');
  rightLine.setAttribute('stroke-width', '0.8');

  const rightDot = doc.createElementNS(SVG_NS, 'circle');
  rightDot.setAttribute('cx', String(rightDotX));
  rightDot.setAttribute('cy', '164.375');
  rightDot.setAttribute('r', '2.5');
  rightDot.setAttribute('fill', '#d4a574');

  const text = doc.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(centerX));
  text.setAttribute('y', '178.55');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('direction', 'rtl');
  text.setAttribute(
    'font-family',
    '"Noto Naskh Arabic", "Scheherazade New", "Amiri", "Traditional Arabic", serif',
  );
  text.setAttribute('font-size', '40.5');
  text.setAttribute('fill', '#1c1208');
  text.textContent = BISMILLAH_UTS;
  if (ayahKey) text.setAttribute('data-ayah', ayahKey);

  g.append(leftLine, leftDot, rightLine, rightDot, text);
  return g;
}

function shiftSvgTextsDown(svg, fromText, shift) {
  let node = fromText;
  while (node) {
    if (node.tagName === 'text' && node.getAttribute('y')) {
      const y = Number(node.getAttribute('y'));
      node.setAttribute('y', String(y + shift));
    }
    node = node.nextElementSibling;
  }

  const footer = [...svg.querySelectorAll('text')].find(
    (el) => el.getAttribute('fill') === '#998d77' && el.textContent.includes('â€”'),
  );
  if (footer) {
    footer.setAttribute('y', String(Number(footer.getAttribute('y')) + shift));
  }
}

function growSvgCanvas(svg, extraHeight) {
  const height = Number(svg.getAttribute('height') || 900);
  const viewBox = (svg.getAttribute('viewBox') || `0 0 900 ${height}`).split(/\s+/).map(Number);
  svg.setAttribute('height', String(height + extraHeight));
  viewBox[3] = (viewBox[3] || height) + extraHeight;
  svg.setAttribute('viewBox', viewBox.join(' '));

  const frame = svg.querySelector('rect[stroke="#d4a574"][stroke-width="2.5"]');
  if (frame) {
    frame.setAttribute('height', String(Number(frame.getAttribute('height')) + extraHeight));
  }
  const innerFrame = frame?.nextElementSibling;
  if (innerFrame?.tagName === 'rect') {
    innerFrame.setAttribute('height', String(Number(innerFrame.getAttribute('height')) + extraHeight));
  }
  const dashFrame = innerFrame?.nextElementSibling;
  if (dashFrame?.tagName === 'rect') {
    dashFrame.setAttribute('height', String(Number(dashFrame.getAttribute('height')) + extraHeight));
  }
}

function mergeBBoxes(boxes) {
  if (!boxes.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  boxes.forEach((box) => {
    x1 = Math.min(x1, box.x);
    y1 = Math.min(y1, box.y);
    x2 = Math.max(x2, box.x + box.width);
    y2 = Math.max(y2, box.y + box.height);
  });
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function getHighlightedAyahKeys() {
  return new Set(roomState?.highlightedAyahs || []);
}

function ensureHighlightLayer(svg) {
  let layer = svg.querySelector('g.alhelmi-highlight-layer');
  if (!layer) {
    layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', 'alhelmi-highlight-layer');
    layer.setAttribute('pointer-events', 'none');
    const pageBg = svg.querySelector(':scope > rect');
    if (pageBg?.nextSibling) {
      svg.insertBefore(layer, pageBg.nextSibling);
    } else {
      svg.prepend(layer);
    }
  }
  layer.replaceChildren();
  return layer;
}

function applyAyahHighlights() {
  const host = els.mushafHost;
  const svg = host.querySelector('svg');
  host.querySelectorAll('[data-ayah].ayah-highlight').forEach((node) => {
    node.classList.remove('ayah-highlight');
  });
  host.querySelectorAll('.ayah-highlight-bg').forEach((node) => node.remove());

  // Bebas baca: jangan paksa highlight guru
  if (role === 'student' && !isStudentFollowing()) return;

  const keys = getHighlightedAyahKeys();
  if (!svg || !keys.size) return;

  const layer = ensureHighlightLayer(svg);

  keys.forEach((key) => {
    const nodes = [...host.querySelectorAll(`[data-ayah="${key}"]`)];
    if (!nodes.length) return;

    nodes.forEach((node) => node.classList.add('ayah-highlight'));

    const byLine = new Map();
    nodes.forEach((node) => {
      const line = node.closest('text');
      if (!line) return;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(node);
    });

    byLine.forEach((tspans) => {
      const boxes = tspans
        .map((tspan) => {
          try {
            return tspan.getBBox();
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const box = mergeBBoxes(boxes);
      if (!box || box.width <= 0 || box.height <= 0) return;

      const padX = 6;
      const padY = 3;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'ayah-highlight-bg');
      rect.setAttribute('data-ayah-highlight', key);
      rect.setAttribute('x', String(box.x - padX));
      rect.setAttribute('y', String(box.y - padY));
      rect.setAttribute('width', String(box.width + padX * 2));
      rect.setAttribute('height', String(box.height + padY * 2));
      rect.setAttribute('rx', '5');
      rect.setAttribute('fill', 'rgba(255, 193, 7, 0.3)');
      rect.setAttribute('stroke', 'rgba(245, 158, 11, 0.75)');
      rect.setAttribute('stroke-width', '1.5');
      layer.appendChild(rect);
    });
  });
}

function getEffectiveZoom() {
  if (role === 'teacher') {
    return roomState?.teacherZoom ?? 100;
  }
  if (roomState?.syncZoom) {
    return roomState.teacherZoom ?? 100;
  }
  return studentZoom;
}

function updateZoomLabels() {
  const zoom = getEffectiveZoom();
  if (els.zoomLabel) {
    els.zoomLabel.textContent = role === 'teacher' && zoom === TEACHER_DEFAULT_ZOOM
      ? `${zoom}% (mushaf)`
      : `${zoom}%`;
  }
  if (els.studentZoomLabel) {
    const label = roomState?.syncZoom ? `${zoom}% (ikut guru)` : `${studentZoom}%`;
    els.studentZoomLabel.textContent = label;
  }
}

function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

function toggleFullscreen() {
  const target = document.documentElement;
  if (!document.fullscreenElement) {
    target.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}
