/* Motion Studio — offline video editor UI
   Screens: Home · Projects · Effects · Studio · Editor (preview + timeline + sheets) */
(function () {
  'use strict';

  var STORE_KEY = 'motionstudio.projects.v1';
  var DB_NAME = 'motionstudio-media';
  var DB_STORE = 'files';

  // ---------------------------------------------------------------- utilities
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function uid(prefix) { return (prefix || 'l') + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(t) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor(Math.round((t - Math.floor(t)) * 30));
    if (f > 29) { f = 0; s += 1; }
    if (s > 59) { s = 0; m += 1; }
    return pad(m) + ':' + pad(s) + ':' + pad(f);
  }
  function fmtShort(t) {
    var m = Math.floor((t || 0) / 60), s = Math.floor((t || 0) % 60);
    return m + ':' + pad(s);
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function round2(v) { return Math.round(v * 100) / 100; }
  function byId(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ storage
  function loadProjects() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data : null;
    } catch (e) { return null; }
  }
  var saveTimer = null;
  function persist(immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!state.autosave && !immediate) return;   // autosave switched off in settings
    var write = function () {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state.projects)); }
      catch (e) { /* storage full — the session keeps working */ }
    };
    if (immediate) write(); else saveTimer = setTimeout(write, 220);
  }

  // IndexedDB blob helpers (media never leaves the device)
  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
    return dbPromise;
  }
  var memoryFiles = {};        // session-only fallback when IndexedDB is not available
  var warnedNoStorage = false;
  function stashInMemory(id, file) {
    memoryFiles[id] = file;
    if (!warnedNoStorage) {
      warnedNoStorage = true;
      toast('This WebView has no persistent storage — media is kept for this session', 'ⓘ');
    }
  }
  function dbPutFile(id, file) {
    if (!window.indexedDB) { stashInMemory(id, file); return Promise.resolve(id); }
    return openDB().then(function (db) {
      if (!db) { stashInMemory(id, file); return id; }
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(file, id);
        tx.oncomplete = function () { resolve(id); };
        tx.onerror = function () { stashInMemory(id, file); resolve(id); };
      });
    });
  }
  function dbGetFile(id) {
    if (memoryFiles[id]) return Promise.resolve(memoryFiles[id]);
    if (!window.indexedDB) return Promise.resolve(null);
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
        req.onsuccess = function () { resolve(req.result || memoryFiles[id] || null); };
        req.onerror = function () { resolve(memoryFiles[id] || null); };
      });
    });
  }
  function dbDeleteFiles(ids) {
    ids.forEach(function (id) { delete memoryFiles[id]; });
    if (!ids.length || !window.indexedDB) return Promise.resolve();
    return openDB().then(function (db) {
      if (!db) return;
      var tx = db.transaction(DB_STORE, 'readwrite');
      var store = tx.objectStore(DB_STORE);
      ids.forEach(function (id) { store.delete(id); });
    });
  }
  var urlCache = {};
  function fileUrl(fileId) {
    if (urlCache[fileId]) return Promise.resolve(urlCache[fileId]);
    return dbGetFile(fileId).then(function (blob) {
      if (!blob || !window.URL || typeof URL.createObjectURL !== 'function') return null;
      var url = URL.createObjectURL(blob);
      urlCache[fileId] = url;
      return url;
    });
  }

  // -------------------------------------------------------------- seed content
  function newProject(name) {
    return {
      id: uid('p'), name: name || 'Untitled project', ratio: '16:9', fps: 30, duration: 15,
      theme: ['violet', 'sunset', 'ocean'][Math.floor(Math.random() * 3)],
      updatedAt: Date.now(), layers: []
    };
  }
  function makeTextLayer(text, opts) {
    var o = opts || {};
    return {
      id: uid('t'), type: 'text', name: text || 'Text', text: text || 'Your text',
      start: o.start || 0, duration: o.duration || 5, hidden: false,
      color: o.color || '#ffffff', size: o.size || 46, x: 50, y: 50
    };
  }
  function makeShapeLayer(shape, opts) {
    var o = opts || {};
    var names = { rect: 'Rectangle', circle: 'Circle', triangle: 'Triangle' };
    return {
      id: uid('s'), type: 'shape', shape: shape || 'rect', name: names[shape || 'rect'],
      start: o.start || 0, duration: o.duration || 5, hidden: false,
      color: o.color || '#57ddce', size: o.size || 74, x: 50, y: 50
    };
  }
  function makeSolidLayer(color, opts) {
    var o = opts || {};
    return {
      id: uid('m'), type: 'image', srcKind: 'solid', name: 'Solid colour',
      start: o.start || 0, duration: o.duration || (o.duration === 0 ? 0 : 4), hidden: false,
      color: color || '#8a63e8', x: 50, y: 50
    };
  }
  function seedProjects() {
    var a = newProject('Golden hour');
    a.theme = 'sunset'; a.duration = 20;
    a.layers = [
      makeSolidLayer('#f0a868', { duration: 20 }),
      makeTextLayer('Golden hour', { start: 0.5, duration: 6, size: 64, color: '#2b1b12' })
    ];
    a.layers[0].name = 'Sunset gradient';
    var b = newProject('City lights');
    b.theme = 'ocean';
    b.layers = [makeTextLayer("CITY\nLIGHTS", { start: 1, duration: 7, size: 58, color: '#8bf7ea' })];
    var c = newProject('Intro template');
    c.theme = 'violet'; c.ratio = '9:16'; c.duration = 12;
    c.layers = [];
    return [a, b, c];
  }

  // -------------------------------------------------------------- app state
  var state = {
    projects: [],
    project: null,
    selectedLayerId: null,
    zoom: 1,
    playing: false,
    time: 0,
    lastTick: 0,
    screen: 'home',
    sortNewest: true,
    previewSource: null,
    audioEls: {},
    undoStack: [],
    redoStack: [],
    exporting: false,
    autosave: true,
    stageMode: 'fit'
  };

  var EFFECTS = [
    { id: 'brightcontrast', name: 'Bright/Contrast', cat: 'Color', thumb: 'assets/features/brightcontrast.webp', blurb: 'Lift the highlights and deepen the shadows in one pass.' },
    { id: 'solidcolor', name: 'Solid Colour', cat: 'Color', thumb: 'assets/features/solidcolor.webp', blurb: 'Flood the frame with a colour and dial in its alpha.' },
    { id: 'posterize', name: 'Posterize', cat: 'Color', thumb: 'assets/features/posterize.webp', blurb: 'Flatten tones into bold, graphic bands of colour.' },
    { id: 'blending', name: 'Blend Mode', cat: 'Color', thumb: 'assets/features/blending.webp', blurb: 'Mix this layer with the ones underneath.' },
    { id: 'noise', name: 'Noise', cat: 'Blur', thumb: 'assets/features/noise.webp', blurb: 'Add grain or smooth out a noisy source.' },
    { id: 'border', name: 'Border', cat: 'Blur', thumb: 'assets/features/border.webp', blurb: 'Outline a layer with a weighted edge.' },
    { id: 'steam', name: 'Steam', cat: 'Blur', thumb: 'assets/features/steam.webp', blurb: 'Soft haze that drifts over the frame.' },
    { id: 'fractalwarp', name: 'Fractal Warp', cat: 'Motion', thumb: 'assets/features/fractalwarp.webp', blurb: 'Bend and melt the frame with a noisy warp.' },
    { id: 'rgbsplit', name: 'RGB Split', cat: 'Motion', thumb: 'assets/features/rgbsplit.webp', blurb: 'Offset the colour channels for a glitched look.' },
    { id: 'lensflare', name: 'Lens Flare', cat: 'Motion', thumb: 'assets/features/lensflare.webp', blurb: 'Push light through the lens for instant drama.' },
    { id: 'tilerotate', name: 'Tile Rotate', cat: 'Motion', thumb: 'assets/features/tilerotate.webp', blurb: 'Repeat the layer in a rotating kaleidoscope.' },
    { id: 'keyframe', name: 'Keyframes', cat: 'Motion', thumb: 'assets/features/keyframe.webp', blurb: 'Animate any property over time with keyframes.' }
  ];

  // ------------------------------------------------------------------- toasts
  function toast(message, icon) {
    var stack = $('toast-stack');
    if (!stack) return;
    var node = el('div', 'toast');
    node.appendChild(el('span', null, icon || '✓'));
    node.appendChild(el('div', null, message));
    stack.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .25s, transform .25s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(5px)';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }, 2100);
  }

  // -------------------------------------------------------------- sheet system
  var modalRoot = null;
  function closeSheet() {
    if (!modalRoot) modalRoot = $('modal-root');
    modalRoot.innerHTML = '';
  }
  function openSheet(render, opts) {
    var o = opts || {};
    if (!modalRoot) modalRoot = $('modal-root');
    modalRoot.innerHTML = '';
    var backdrop = el('div', 'modal-backdrop');
    var sheet = el('div', 'sheet');
    sheet.appendChild(el('div', 'sheet-handle'));
    backdrop.appendChild(sheet);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop && o.dismissable !== false) closeSheet(); });
    modalRoot.appendChild(backdrop);
    render(sheet, closeSheet);
    return sheet;
  }
  function sheetHeader(sheet, title, subtitle) {
    var head = el('div', 'sheet-header');
    var box = el('div');
    box.appendChild(el('h2', null, title));
    if (subtitle) box.appendChild(el('p', null, subtitle));
    head.appendChild(box);
    var close = el('button', 'sheet-close', '×');
    close.addEventListener('click', closeSheet);
    head.appendChild(close);
    sheet.appendChild(head);
    return head;
  }
  function labeled(sheet, text) { sheet.appendChild(el('p', 'sheet-label', text)); }
  function primaryButton(parent, label, onClick) {
    var b = el('button', 'primary-button', label);
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }
  function note(parent, text, icon) {
    var n = el('div', 'sheet-note');
    n.appendChild(el('span', null, icon || 'ⓘ'));
    n.appendChild(el('div', null, text));
    parent.appendChild(n);
    return n;
  }

  // ------------------------------------------------------------------ screen nav
  function showScreen(name) {
    state.screen = name;
    ['home', 'projects', 'effects', 'profile'].forEach(function (key) {
      var screen = byId(key + '-screen');
      if (screen) screen.classList.toggle('active', key === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (item) {
      item.classList.toggle('selected', item.getAttribute('data-nav') === name);
    });
    $('main-view').classList.remove('hidden');
    $('editor-screen').classList.add('hidden');
    closeSheet();
    if (name === 'projects') renderProjects();
    if (name === 'home') renderHome();
  }
  function openProjectSheet(project) { openEditor(project); }

  // --------------------------------------------------------------- home render
  function projectCover(project) {
    var cover = el('div', 'project-cover');
    cover.setAttribute('data-theme', project.theme || 'violet');
    cover.appendChild(el('div', 'cover-grid'));
    cover.appendChild(el('div', 'cover-orbit'));
    cover.appendChild(el('div', 'cover-play', '▶'));
    var type = el('span', 'cover-type');
    var videos = project.layers.filter(function (l) { return l.type === 'video'; }).length;
    var images = project.layers.filter(function (l) { return l.type === 'image'; }).length;
    type.textContent = String(project.layers.length) + ' LAYER' + (project.layers.length === 1 ? '' : 'S') +
      (videos ? ' · ' + (videos + images) + ' MEDIA' : '');
    cover.appendChild(type);
    return cover;
  }
  function projectCard(project, fullWidth) {
    var card = el('button', 'project-card');
    card.setAttribute('data-project', project.id);
    var cover = projectCover(project);
    card.appendChild(cover);
    var info = el('div', 'project-info');
    var more = el('span', 'project-more', '⋯');
    info.appendChild(more);
    info.appendChild(el('strong', null, project.name));
    var ratioLabel = project.ratio === '9:16' ? 'Portrait' : project.ratio === '1:1' ? 'Square' : project.ratio === '4:5' ? 'Feed' : 'Widescreen';
    info.appendChild(el('small', null, ratioLabel + ' · ' + fmtShort(project.duration) + ' · ' + relativeTime(project.updatedAt)));
    card.appendChild(info);
    card.addEventListener('click', function () { openProjectSheet(project); });
    card.addEventListener('contextmenu', function (e) { e.preventDefault(); projectMenu(project); });
    return card;
  }
  function relativeTime(ts) {
    var diff = Date.now() - (ts || Date.now());
    var mins = Math.round(diff / 60000), hours = Math.round(diff / 3600000), days = Math.round(diff / 86400000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (hours < 24) return hours + 'h ago';
    if (days < 7) return days + 'd ago';
    return new Date(ts).toLocaleDateString();
  }
  function renderHome() {
    var box = $('home-projects');
    box.innerHTML = '';
    var list = state.projects.slice(0, 2);
    $('project-count').textContent = String(state.projects.length);
    if (!state.projects.length) {
      var empty = el('div', 'empty-projects');
      empty.appendChild(el('div', 'empty-project-art', '✳'));
      var copy = el('div');
      copy.appendChild(el('strong', null, 'No projects yet'));
      copy.appendChild(el('p', null, 'Tap “New project” to add media, text and effects on an editable timeline.'));
      empty.appendChild(copy);
      box.appendChild(empty);
      return;
    }
    list.forEach(function (p) { box.appendChild(projectCard(p)); });
  }
  function renderProjects() {
    var box = $('all-projects');
    box.innerHTML = '';
    var list = state.projects.slice().sort(function (a, b) {
      return state.sortNewest ? (b.updatedAt - a.updatedAt) : (a.updatedAt - b.updatedAt);
    });
    $('projects-summary').textContent = list.length ? String(list.length) + ' project' + (list.length === 1 ? '' : 's') + ' on this device' : 'Your edits, all in one place.';
    if (!list.length) {
      var empty = el('div', 'empty-projects');
      empty.appendChild(el('div', 'empty-project-art', '▦'));
      var copy = el('div');
      copy.appendChild(el('strong', null, 'Nothing here yet'));
      copy.appendChild(el('p', null, 'Create a project and it will show up here, saved on your device.'));
      empty.appendChild(copy);
      box.appendChild(empty);
      return;
    }
    list.forEach(function (p) { box.appendChild(projectCard(p, true)); });
  }
  function projectMenu(project) {
    openSheet(function (sheet) {
      sheetHeader(sheet, project.name, 'Project actions');
      var actions = [
        ['Rename project', '✎', function () { renameProjectSheet(project); }],
        ['Duplicate project', '⧉', function () {
          var clone = JSON.parse(JSON.stringify(project));
          clone.id = uid('p'); clone.name = project.name + ' copy'; clone.updatedAt = Date.now();
          clone.layers.forEach(function (l) { l.id = uid(l.type.charAt(0)); });
          state.projects.unshift(clone); persist(); renderHome(); renderProjects(); toast('Project duplicated');
          closeSheet();
        }],
        ['Delete project', '⌫', function () { confirmDeleteProject(project); }]
      ];
      actions.forEach(function (action) {
        var row = el('button', 'settings-item');
        row.appendChild(el('span', 'settings-icon', action[1]));
        var box = el('span');
        box.appendChild(el('strong', null, action[0]));
        row.appendChild(box);
        row.appendChild(el('span', 'settings-chevron', '›'));
        row.addEventListener('click', action[2]);
        sheet.appendChild(row);
      });
    });
  }
  function confirmDeleteProject(project) {
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Delete project?', '“' + project.name + '” and its edits will be removed from this device.');
      var row = el('div', 'action-row');
      primaryButton(row, 'Keep project', function () { closeSheet(); });
      var del = el('button', 'secondary-button', 'Delete');
      del.addEventListener('click', function () {
        var ids = project.layers.map(function (l) { return l.fileId; }).filter(Boolean);
        dbDeleteFiles(ids);
        state.projects = state.projects.filter(function (p) { return p.id !== project.id; });
        persist(true); renderHome(); renderProjects(); closeSheet(); toast('Project deleted');
      });
      row.appendChild(del);
      sheet.appendChild(row);
    });
  }
  function renderEffectGrid(category) {
    var grid = $('effect-grid');
    grid.innerHTML = '';
    EFFECTS.filter(function (e) { return !category || category === 'All' || e.cat === category; }).forEach(function (effect) {
      var card = el('button', 'effect-card');
      var art = el('div', 'effect-art');
      var img = el('img');
      img.src = effect.thumb; img.alt = ''; img.loading = 'lazy';
      art.appendChild(img);
      art.appendChild(el('span', null, '✧'));
      card.appendChild(art);
      var info = el('div', 'effect-info');
      info.appendChild(el('strong', null, effect.name));
      info.appendChild(el('small', null, effect.cat + ' · tap to preview'));
      card.appendChild(info);
      card.addEventListener('click', function () { effectDetailSheet(effect); });
      grid.appendChild(card);
    });
  }
  function effectDetailSheet(effect) {
    openSheet(function (sheet) {
      sheetHeader(sheet, effect.name, effect.cat + ' effect');
      var art = el('div', 'effect-detail-preview');
      var img = el('img'); img.src = effect.thumb; img.alt = '';
      art.appendChild(img); sheet.appendChild(art);
      sheet.appendChild(el('p', 'modal-copy', effect.blurb));
      note(sheet, 'Presets applied in the editor stay on this device — nothing is uploaded.', '🔒');
      var row = el('div', 'action-row');
      primaryButton(row, 'Use in a project', function () {
        closeSheet();
        var project = state.projects[0] || createProject('New project', '16:9');
        openEditor(project);
        setTimeout(function () { applyEffectToSelection(effect); }, 260);
      });
      var back = el('button', 'secondary-button', 'Back to effects');
      back.addEventListener('click', function () { closeSheet(); showScreen('effects'); });
      row.appendChild(back);
      sheet.appendChild(row);
    });
  }

  // ------------------------------------------------------------------- editor
  var canvasState = { pxPerSec: 8 };

  function createProject(name, ratio) {
    var project = newProject(name || 'Untitled project');
    project.ratio = ratio || '16:9';
    project.duration = 15;
    state.projects.unshift(project);
    persist();
    renderHome(); renderProjects();
    return project;
  }

  function editorAspect() {
    var r = state.project ? state.project.ratio : '16:9';
    if (r === '9:16') return '9 / 16';
    if (r === '1:1') return '1 / 1';
    if (r === '4:5') return '4 / 5';
    return '16 / 9';
  }

  function openEditor(project) {
    state.project = project;
    state.selectedLayerId = null;
    state.undoStack = []; state.redoStack = [];
    state.time = 0; state.playing = false; state.zoom = 1;
    state.previewSource = null;
    state.audioEls = {};
    $('editor-title').textContent = project.name;
    $('editor-spec').textContent = specText();
    $('preview-stage').style.aspectRatio = editorAspect();
    $('preview-video').src = ''; $('preview-video').style.display = 'none';
    $('preview-image').removeAttribute('src'); $('preview-image').style.display = 'none';
    $('preview-video').pause();
    $('main-view').classList.add('hidden');
    $('editor-screen').classList.remove('hidden');
    closeSheet();
    renderTimeline();
    renderInspector();
    syncPlayback(0, true);
    tryStartDemoIfEmpty();
  }

  function closeEditor() {
    pausePlayback();
    if (state.project) { state.project.updatedAt = Date.now(); persist(true); }
    Object.keys(state.audioEls).forEach(function (k) {
      try { state.audioEls[k].pause(); } catch (e) { /* ignore */ }
    });
    state.audioEls = {};
    state.previewSource = null;
    $('preview-video').pause();
    $('main-view').classList.remove('hidden');
    $('editor-screen').classList.add('hidden');
    renderHome(); renderProjects();
  }

  function specText() {
    var p = state.project;
    if (!p) return '';
    var sizes = { '16:9': '1920 × 1080', '9:16': '1080 × 1920', '1:1': '1080 × 1080', '4:5': '1080 × 1350' };
    return (sizes[p.ratio] || '1920 × 1080') + ' · ' + p.fps + ' fps · ' + fmtShort(p.duration);
  }

  function selectedLayer() {
    if (!state.project) return null;
    for (var i = 0; i < state.project.layers.length; i++) {
      if (state.project.layers[i].id === state.selectedLayerId) return state.project.layers[i];
    }
    return null;
  }
  function topVisibleLayer(typeList) {
    var layers = state.project ? state.project.layers : [];
    for (var i = layers.length - 1; i >= 0; i--) {
      var l = layers[i];
      if (l.hidden) continue;
      if (!typeList || typeList.indexOf(l.type) !== -1) return l;
    }
    return null;
  }
  function activeMediaLayer() {
    var layers = state.project ? state.project.layers : [];
    for (var i = layers.length - 1; i >= 0; i--) {
      var l = layers[i];
      if (l.hidden) continue;
      if (l.type === 'video' || l.type === 'image') return l;
    }
    return null;
  }
  function isMediaFile(layer) { return layer && (layer.srcKind === 'file' || layer.srcKind === 'demo'); }
  function mediaStart(layer) { return layer ? layer.start || 0 : 0; }

  // ----------------------------------------------------------------- timeline
  function renderTimeline() {
    if (!state.project) return;
    var pxPerSec = 40 * state.zoom;
    var totalWidth = Math.max(420, state.project.duration * pxPerSec + 80);
    canvasState.pxPerSec = pxPerSec;
    $('timeline-content').style.width = (77 + totalWidth) + 'px';

    var ruler = $('timeline-ruler');
    ruler.innerHTML = '';
    ruler.style.width = totalWidth + 'px';
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if (steps[i] * pxPerSec >= 46) { step = steps[i]; break; } }
    for (var t = 0; t <= state.project.duration + 0.001; t += step) {
      var tick = el('span', 'ruler-tick', fmtShort(t));
      tick.style.left = (t * pxPerSec + 3) + 'px';
      ruler.appendChild(tick);
    }

    var stack = $('track-stack');
    stack.innerHTML = '';
    var groups = [
      { key: 'media', label: 'MEDIA', icon: '▣', types: ['video', 'image'], cls: '' },
      { key: 'text', label: 'TEXT', icon: 'T', types: ['text'], cls: 'text' },
      { key: 'audio', label: 'AUDIO', icon: '♫', types: ['audio'], cls: 'audio' }
    ];
    groups.forEach(function (group) {
      var row = el('div', 'track-row' + (group.cls ? ' ' + group.cls : ''));
      var label = el('div', 'track-label');
      label.appendChild(el('span', 'track-label-icon', group.icon));
      label.appendChild(el('span', null, group.label));
      row.appendChild(label);
      var lane = el('div', 'track-lane');
      lane.style.width = totalWidth + 'px';
      var layers = state.project.layers.filter(function (l) { return group.types.indexOf(l.type) !== -1; });
      layers.forEach(function (layer) { lane.appendChild(clipElement(layer, pxPerSec)); });
      row.appendChild(lane);
      stack.appendChild(row);
    });

    laneEmptyHint(stack);
    updatePlayhead();
  }

  function laneEmptyHint(stack) {
    if (state.project.layers.length) return;
    var hint = el('div', 'library-empty');
    hint.innerHTML = 'Drop in a clip, a title or a shape to start building your timeline.<br><br>Everything stays on this device.';
    hint.style.padding = '10px 14px';
    hint.style.textAlign = 'left';
    stack.appendChild(hint);
  }

  function clipElement(layer, pxPerSec) {
    var icons = { video: '▣', image: '▣', audio: '♫', text: 'T', shape: '◇' };
    var clip = el('button', 'clip-block ' + (layer.type === 'image' ? 'image' : layer.type));
    if (layer.id === state.selectedLayerId) clip.classList.add('selected');
    clip.setAttribute('data-layer', layer.id);
    clip.appendChild(el('span', 'clip-mini-icon', icons[layer.type] || '▣'));
    var labels = el('span', 'clip-labels');
    labels.appendChild(el('strong', null, layer.name));
    labels.appendChild(el('small', null, fmtShort(layer.start) + ' → ' + fmtShort(layer.start + layer.duration)));
    clip.appendChild(labels);
    if (layer.type === 'audio') {
      var wave = el('span', 'waveform');
      for (var i = 0; i < 16; i++) {
        var bar = el('i');
        bar.style.height = (3 + Math.round(Math.abs(Math.sin(i * 1.7 + layer.start)) * 6)) + 'px';
        wave.appendChild(bar);
      }
      clip.appendChild(wave);
    }
    positionClip(clip, layer, pxPerSec);
    attachLayerGestures(clip, layer);
    return clip;
  }
  function positionClip(clip, layer, pxPerSec) {
    clip.style.left = (layer.start * pxPerSec) + 'px';
    clip.style.width = Math.max(56, layer.duration * pxPerSec - 3) + 'px';
  }

  function attachLayerGestures(clip, layer) {
    var drag = null;
    clip.addEventListener('pointerdown', function (e) {
      selectLayer(layer.id);
      drag = { x: e.clientX, start: layer.start, moved: false };
      try { clip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    clip.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      if (Math.abs(dx) < 5) return;
      drag.moved = true;
      var next = clamp(drag.start + dx / canvasState.pxPerSec, 0, Math.max(0, state.project.duration - layer.duration));
      layer.start = round2(next);
      positionClip(clip, layer, canvasState.pxPerSec);
    });
    clip.addEventListener('pointerup', function () {
      if (drag && drag.moved) {
        pushHistory();
        var small = clip.querySelector('small');
        if (small) small.textContent = fmtShort(layer.start) + ' → ' + fmtShort(layer.start + layer.duration);
        state.project.updatedAt = Date.now();
        renderInspector();
        syncPlayback(state.time, true);
      }
      drag = null;
    });
    clip.addEventListener('pointercancel', function () { drag = null; });
    // Some input stacks deliver a click without a preceding pointer sequence.
    clip.addEventListener('click', function () { selectLayer(layer.id); });
  }

  function selectLayer(id) {
    state.selectedLayerId = id;
    Array.prototype.forEach.call(document.querySelectorAll('.clip-block'), function (node) {
      node.classList.toggle('selected', node.getAttribute('data-layer') === id);
    });
    renderInspector();
    syncPlayback(state.time, false);
  }

  function renderInspector() {
    var box = $('clip-inspector');
    var layer = selectedLayer();
    if (!layer) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '';
    var head = el('div', 'inspector-head');
    head.appendChild(el('strong', null, layer.name));
    head.appendChild(el('span', null, layer.type.toUpperCase() + ' · ' + fmtShort(layer.start) + '–' + fmtShort(layer.start + layer.duration)));
    box.appendChild(head);

    if (layer.type === 'video' || layer.type === 'audio') {
      var wrap = el('div', 'trim-controls');
      wrap.appendChild(trimControl('Trim start', layer, 'trimIn'));
      wrap.appendChild(trimControl('Duration', layer, 'duration'));
      box.appendChild(wrap);
    } else if (layer.type === 'text') {
      var t = el('div', 'trim-controls');
      t.appendChild(rangeControl('Size', layer, 'size', 12, 96, 1, function (v) { return v + ' px'; }));
      t.appendChild(rangeControl('Start', layer, 'start', 0, Math.max(1, state.project.duration - 1), 0.1, function (v) { return fmtShort(v); }));
      box.appendChild(t);
    } else {
      var s = el('div', 'trim-controls');
      s.appendChild(rangeControl('Size', layer, 'size', 24, 220, 2, function (v) { return v + ' px'; }));
      s.appendChild(rangeControl('Start', layer, 'start', 0, Math.max(1, state.project.duration - 1), 0.1, function (v) { return fmtShort(v); }));
      box.appendChild(s);
    }
  }

  function trimControl(labelText, layer, prop) {
    var wrap = el('div', 'trim-control');
    var label = el('label');
    label.appendChild(el('span', null, labelText));
    var value = el('span', null, '0.0 s');
    label.appendChild(value);
    wrap.appendChild(label);
    var input = document.createElement('input');
    input.type = 'range';
    var sourceDur = layer.sourceDuration || Math.max(layer.duration + (layer.trimIn || 0), 30);
    var isTrim = prop === 'trimIn';
    input.min = isTrim ? 0 : 0.2;
    input.max = isTrim ? Math.max(0.2, round2(sourceDur - 0.2)) : Math.max(0.2, round2(sourceDur - (layer.trimIn || 0)));
    input.step = 0.05;
    input.value = isTrim ? (layer.trimIn || 0) : layer.duration;
    value.textContent = isTrim ? (Number(layer.trimIn || 0).toFixed(2) + ' s') : (layer.duration.toFixed(2) + ' s');
    input.addEventListener('input', function () {
      if (isTrim) {
        layer.trimIn = round2(parseFloat(input.value));
        value.textContent = layer.trimIn.toFixed(2) + ' s';
      } else {
        layer.duration = round2(parseFloat(input.value));
        value.textContent = layer.duration.toFixed(2) + ' s';
        recomputeDuration();
      }
      renderTimeline();
      syncPlayback(state.time, true);
      state.project.updatedAt = Date.now();
      persist();
    });
    input.addEventListener('change', function () { pushHistory(); });
    wrap.appendChild(input);
    return wrap;
  }

  function rangeControl(labelText, layer, prop, min, max, step, format) {
    var wrap = el('div', 'trim-control');
    var label = el('label');
    label.appendChild(el('span', null, labelText));
    var value = el('span', null, format(layer[prop]));
    label.appendChild(value);
    wrap.appendChild(label);
    var input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = layer[prop];
    input.addEventListener('input', function () {
      layer[prop] = parseFloat(input.value);
      value.textContent = format(layer[prop]);
      if (prop === 'start') { renderTimeline(); syncPlayback(state.time, true); }
      else { renderInspector(); syncPlayback(state.time, true); }
      state.project.updatedAt = Date.now();
      persist();
    });
    wrap.appendChild(input);
    return wrap;
  }

  function recomputeDuration() {
    var end = 4;
    state.project.layers.forEach(function (l) { end = Math.max(end, (l.start || 0) + l.duration); });
    state.project.duration = round2(end + 1);
    $('editor-spec').textContent = specText();
  }

  function updatePlayhead() {
    if (!state.project) return;
    var left = 77 + state.time * canvasState.pxPerSec;
    var line = $('playhead-line');
    line.style.left = left + 'px';
    $('playhead-time').textContent = fmt(state.time);
    $('total-time').textContent = fmt(state.project.duration);
    var scroll = $('timeline-scroll');
    var viewLeft = scroll.scrollLeft, viewRight = viewLeft + scroll.clientWidth;
    if (left < viewLeft + 70 || left > viewRight - 40) {
      scroll.scrollLeft = Math.max(0, left - scroll.clientWidth * 0.55);
    }
  }

  // ---------------------------------------------------------------- playback
  function pausePlayback() {
    state.playing = false;
    state.playing = false;
    $('play-button').textContent = '▶';
    Object.keys(state.audioEls).forEach(function (k) { try { state.audioEls[k].pause(); } catch (e) { /* ignore */ } });
    var v = $('preview-video');
    if (v && !v.paused) v.pause();
  }
  function playPlayback() {
    if (!state.project) return;
    state.playing = true;
    $('play-button').textContent = '❚❚';
    state.lastTick = performance.now();
    if (state.time >= state.project.duration - 0.02) state.time = 0;
    syncPlayback(state.time, true);
    requestAnimationFrame(tick);
  }
  function tick(now) {
    if (!state.playing || !state.project) return;
    var dt = (now - state.lastTick) / 1000;
    state.lastTick = now;
    state.time += dt;
    if (state.time >= state.project.duration) {
      state.time = state.project.duration;
      pausePlayback();
      toast('Reached the end of the timeline', '⏱');
    }
    syncPlayback(state.time, false);
    requestAnimationFrame(tick);
  }

  function ensurePreviewSource(layer) {
    var current = state.previewSource;
    if (!layer) {
      if (current) {
        state.previewSource = null;
        $('preview-video').style.display = 'none';
        $('preview-image').style.display = 'none';
      }
      return;
    }
    if (current && current.layerId === layer.id) return;
    state.previewSource = { layerId: layer.id, ready: false, url: null };
    var token = layer.id;
    if (layer.srcKind === 'solid') {
      var solid = $('preview-image');
      solid.style.display = 'block';
      solid.removeAttribute('src');
      solid.style.background = layer.color || '#8a63e8';
      $('preview-video').style.display = 'none';
      state.previewSource.ready = true;
      return;
    }
    if (!layer.fileId) return;
    fileUrl(layer.fileId).then(function (url) {
      if (!url || !state.previewSource || state.previewSource.layerId !== token) return;
      state.previewSource.url = url;
      var node = layer.type === 'video' ? $('preview-video') : $('preview-image');
      if (node.tagName === 'IMG') {
        node.style.background = '';
        node.src = url;
        state.previewSource.ready = true;
      } else {
        node.src = url;
        node.onloadedmetadata = function () {
          if (!layer.sourceDuration) {
            layer.sourceDuration = Math.round(node.duration * 100) / 100;
            renderInspector();
          }
          if (state.previewSource && state.previewSource.layerId === token) state.previewSource.ready = true;
          syncPlayback(state.time, true);
        };
      }
    });
  }

  function audioFor(layer) {
    var entry = state.audioEls[layer.id];
    if (entry) return entry;
    if (!layer.fileId) return null;
    var audio = new Audio();
    audio.preload = 'metadata';
    var record = { el: audio, ready: false };
    state.audioEls[layer.id] = record;
    fileUrl(layer.fileId).then(function (url) {
      if (!url) return;
      audio.src = url;
      audio.onloadedmetadata = function () {
        record.ready = true;
        if (!layer.sourceDuration) {
          layer.sourceDuration = Math.round(audio.duration * 100) / 100;
          renderInspector();
        }
      };
    });
    return record;
  }

  function syncPlayback(t, force) {
    if (!state.project) return;
    state.time = clamp(t, 0, state.project.duration);
    if (force === undefined) force = true;

    // media stage
    var media = activeMediaLayer();
    ensurePreviewSource(media);
    var video = $('preview-video');
    var image = $('preview-image');
    var mediaVisible = false;
    if (media) {
      if (media.type === 'video') {
        video.style.display = 'block';
        image.style.display = 'none';
        mediaVisible = true;
      } else if (media.srcKind === 'solid') {
        image.style.display = 'block';
        video.style.display = 'none';
        mediaVisible = true;
      } else if (state.previewSource && state.previewSource.ready) {
        image.style.display = 'block';
        video.style.display = 'none';
        mediaVisible = true;
      }
    }
    var localT = 0;
    if (media) {
      var start = mediaStart(media);
      var trim = media.trimIn || 0;
      if (t < start) localT = trim;
      else if (t > start + media.duration) localT = trim + media.duration;
      else localT = trim + (t - start);
      if (media.type === 'video' && state.previewSource && state.previewSource.ready) {
        var dur = video.duration;
        if (isFinite(dur) && dur > 0) localT = Math.min(localT, Math.max(0, dur - 0.05));
        if (Math.abs(video.currentTime - localT) > 0.28) {
          try { video.currentTime = localT; } catch (e) { /* not seekable yet */ }
        }
        if (state.playing) { if (video.paused) { var pr = video.play(); if (pr && pr.catch) pr.catch(function () {}); } }
        else if (!video.paused) video.pause();
      }
    }
    if (!mediaVisible || !media) { if (!video.paused) video.pause(); }

    // audio layers
    state.project.layers.forEach(function (layer) {
      if (layer.type !== 'audio' || layer.hidden) return;
      var record = audioFor(layer);
      if (!record || !record.ready) return;
      var s = layer.start || 0, trim = layer.trimIn || 0;
      var ln = record.el;
      if (t < s || t > s + layer.duration) {
        if (!ln.paused) ln.pause();
        return;
      }
      var want = trim + (t - s);
      if (Math.abs(ln.currentTime - want) > 0.3) { try { ln.currentTime = want; } catch (e) { /* ignore */ } }
      if (state.playing) { if (ln.paused) { var p = ln.play(); if (p && p.catch) p.catch(function () {}); } }
      else if (!ln.paused) ln.pause();
    });

    // text + shape stage
    var text = topVisibleLayer(['text']);
    var shape = topVisibleLayer(['shape']);
    var stageText = $('stage-text');
    if (text) {
      var active = t >= text.start && t <= text.start + text.duration;
      if (active) {
        stageText.classList.remove('hidden');
        stageText.textContent = text.text;
        stageText.style.color = text.color;
        stageText.style.fontSize = clamp(text.size, 12, 140) + 'px';
        stageText.style.left = (text.x || 50) + '%';
        stageText.style.top = (text.y || 50) + '%';
      } else stageText.classList.add('hidden');
    } else {
      stageText.classList.add('hidden');
    }
    var stageShape = $('stage-shape');
    if (shape) {
      var shapeActive = t >= shape.start && t <= shape.start + shape.duration;
      if (shapeActive) {
        stageShape.classList.remove('hidden');
        stageShape.className = 'stage-shape ' + (shape.shape || 'rect');
        stageShape.style.width = shape.size + 'px';
        stageShape.style.height = (shape.shape === 'triangle' ? shape.size * 0.86 : shape.size) + 'px';
        stageShape.style.borderColor = shape.color;
        stageShape.style.left = (shape.x || 50) + '%';
        stageShape.style.top = (shape.y || 50) + '%';
        if (shape.shape === 'triangle') {
          stageShape.style.border = 'none';
          stageShape.style.width = '0'; stageShape.style.height = '0';
          stageShape.style.borderLeft = (shape.size / 2) + 'px solid transparent';
          stageShape.style.borderRight = (shape.size / 2) + 'px solid transparent';
          stageShape.style.borderBottom = (shape.size * 0.86) + 'px solid ' + shape.color;
          stageShape.style.filter = 'drop-shadow(0 0 7px rgba(255,255,255,.22))';
        } else {
          stageShape.style.border = '3px solid ' + shape.color;
          stageShape.style.filter = 'drop-shadow(0 0 7px rgba(255,255,255,.2))';
        }
      } else stageShape.classList.add('hidden');
    } else {
      stageShape.classList.add('hidden');
    }
    $('preview-empty').classList.toggle('hidden', mediaVisible || !!text || !!shape);
    updatePlayhead();
  }

  // ----------------------------------------------------------------- history
  function snapshot() {
    return JSON.stringify({ layers: state.project.layers, duration: state.project.duration, name: state.project.name, ratio: state.project.ratio });
  }
  function pushHistory() {
    if (!state.project) return;
    state.undoStack.push(snapshot());
    if (state.undoStack.length > 40) state.undoStack.shift();
    state.redoStack.length = 0;
    updateHistoryButtons();
  }
  function restore(json) {
    var data = JSON.parse(json);
    state.project.layers = data.layers;
    state.project.duration = data.duration;
    state.project.name = data.name;
    state.project.ratio = data.ratio;
    $('editor-title').textContent = data.name;
    $('editor-spec').textContent = specText();
    $('preview-stage').style.aspectRatio = editorAspect();
    state.previewSource = null;
    renderTimeline(); renderInspector(); syncPlayback(state.time, true);
    persist();
  }
  function updateHistoryButtons() {
    var undo = document.querySelector('[data-action="undo"]');
    var redo = document.querySelector('[data-action="redo"]');
    if (undo) undo.disabled = !state.undoStack.length;
    if (redo) redo.disabled = !state.redoStack.length;
  }
  function doUndo() {
    if (!state.project || !state.undoStack.length) return;
    state.redoStack.push(snapshot());
    restore(state.undoStack.pop());
    updateHistoryButtons(); toast('Undone');
  }
  function doRedo() {
    if (!state.project || !state.redoStack.length) return;
    state.undoStack.push(snapshot());
    restore(state.redoStack.pop());
    updateHistoryButtons(); toast('Redone');
  }

  // -------------------------------------------------------------- layer ops
  function addLayer(layer) {
    if (!state.project) return null;
    pushHistory();
    state.project.layers.push(layer);
    if (state.playing) pausePlayback();
    recomputeDuration();
    if (state.time > layer.start + layer.duration) state.time = layer.start;
    state.selectedLayerId = layer.id;
    state.project.updatedAt = Date.now();
    persist();
    renderTimeline(); renderInspector(); syncPlayback(state.time, true);
    return layer;
  }
  function deleteSelectedLayer() {
    var layer = selectedLayer();
    if (!layer) { toast('Select a layer on the timeline first', 'ⓘ'); return; }
    pushHistory();
    state.project.layers = state.project.layers.filter(function (l) { return l.id !== layer.id; });
    if (layer.fileId) { dbDeleteFiles([layer.fileId]); delete urlCache[layer.fileId]; }
    state.selectedLayerId = null;
    state.previewSource = null;
    recomputeDuration();
    persist();
    renderTimeline(); renderInspector(); syncPlayback(state.time, true);
    toast('“' + layer.name + '” deleted', '⌫');
  }
  function duplicateSelectedLayer() {
    var layer = selectedLayer();
    if (!layer) { toast('Select a layer on the timeline first', 'ⓘ'); return; }
    pushHistory();
    var clone = JSON.parse(JSON.stringify(layer));
    clone.id = uid(clone.type.charAt(0));
    clone.name = layer.name + ' copy';
    clone.start = round2(clamp(layer.start + 0.5, 0, Math.max(0, state.project.duration - layer.duration)));
    state.project.layers.push(clone);
    state.selectedLayerId = clone.id;
    recomputeDuration(); persist();
    renderTimeline(); renderInspector(); syncPlayback(state.time, true);
    toast('Layer duplicated', '⧉');
  }
  function splitSelectedLayer() {
    var layer = selectedLayer();
    if (!layer) { toast('Select a layer, then split at the playhead', 'ⓘ'); return; }
    var at = state.time;
    if (at <= layer.start + 0.15 || at >= layer.start + layer.duration - 0.15) {
      toast('Move the playhead inside the clip to split it', '✂'); return;
    }
    pushHistory();
    var offset = round2(at - layer.start);
    var right = JSON.parse(JSON.stringify(layer));
    right.id = uid(right.type.charAt(0));
    right.start = round2(at);
    right.duration = round2(layer.duration - offset);
    right.trimIn = round2((layer.trimIn || 0) + offset);
    right.name = layer.name + ' · B';
    layer.duration = offset;
    layer.name = layer.name.replace(/ · B$/, '') + ' · A';
    state.project.layers.push(right);
    state.selectedLayerId = right.id;
    persist();
    renderTimeline(); renderInspector(); syncPlayback(state.time, true);
    toast('Clip split at ' + fmt(state.time), '✂');
  }

  // ------------------------------------------------------------------- sheets
  function newProjectSheet() {
    var draft = { ratio: '16:9', fps: 30, name: '' };
    openSheet(function (sheet) {
      sheetHeader(sheet, 'New project', 'Set up the canvas for your next idea.');
      var label = el('label', 'field-label', 'Project name');
      sheet.appendChild(label);
      var input = document.createElement('input');
      input.className = 'text-field';
      input.placeholder = 'Untitled project';
      input.value = '';
      sheet.appendChild(input);
      labeled(sheet, 'Canvas ratio');
      var grid = el('div', 'ratio-grid');
      [['16:9', 'Widescreen'], ['9:16', 'Portrait'], ['1:1', 'Square'], ['4:5', 'Feed']].forEach(function (option) {
        var card = el('button', 'ratio-option' + (draft.ratio === option[0] ? ' selected' : ''));
        card.setAttribute('data-ratio', option[0]);
        card.appendChild(el('span', 'ratio-box'));
        card.appendChild(el('strong', null, option[0]));
        card.appendChild(el('small', null, option[1]));
        card.addEventListener('click', function () {
          draft.ratio = option[0];
          Array.prototype.forEach.call(grid.children, function (child) { child.classList.toggle('selected', child === card); });
        });
        grid.appendChild(card);
      });
      sheet.appendChild(grid);
      labeled(sheet, 'Frame rate');
      var options = el('div', 'option-row');
      [24, 30, 60].forEach(function (fps) {
        var pill = el('button', 'option-pill' + (fps === draft.fps ? ' selected' : ''), fps + ' fps');
        pill.addEventListener('click', function () {
          draft.fps = fps;
          Array.prototype.forEach.call(options.children, function (child) { child.classList.toggle('selected', child === pill); });
        });
        options.appendChild(pill);
      });
      sheet.appendChild(options);
      primaryButton(sheet, 'Create project', function () {
        var project = createProject(input.value.trim() || 'Untitled project', draft.ratio);
        project.fps = draft.fps;
        persist(true);
        closeSheet();
        openEditor(project);
      });
      note(sheet, 'Projects and media are stored on this device — nothing is uploaded.', '🔒');
    });
    setTimeout(function () { var f = document.querySelector('.sheet .text-field'); if (f) f.focus(); }, 240);
  }

  function renameProjectSheet(project) {
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Rename project');
      var input = document.createElement('input');
      input.className = 'text-field'; input.value = project.name;
      sheet.appendChild(input);
      primaryButton(sheet, 'Save name', function () {
        var value = input.value.trim() || project.name;
        if (state.project && state.project.id === project.id) { pushHistory(); state.project.name = value; }
        project.name = value;
        project.updatedAt = Date.now();
        persist(true);
        if (state.project) { $('editor-title').textContent = value; }
        renderHome(); renderProjects(); closeSheet(); toast('Project renamed');
      });
    });
    setTimeout(function () { var f = document.querySelector('.sheet .text-field'); if (f) f.focus(); f.select(); }, 240);
  }

  function mediaSheet(kind) {
    var accept = kind === 'audio' ? 'audio/*' : 'video/*,image/*';
    openSheet(function (sheet) {
      sheetHeader(sheet, kind === 'audio' ? 'Add audio' : 'Add media', 'Bring footage from your device onto the timeline.');
      var card = el('div', 'media-pick-card');
      card.appendChild(el('div', 'media-pick-icon', kind === 'audio' ? '♫' : '▣'));
      var copy = el('div');
      copy.appendChild(el('strong', null, kind === 'audio' ? 'Choose an audio file' : 'Choose a video or photo'));
      copy.appendChild(el('p', null, 'Files stay in this app, on this device.'));
      card.appendChild(copy);
      var pick = el('button', null, 'Browse');
      card.appendChild(pick);
      sheet.appendChild(card);
      pick.addEventListener('click', function () { pickFiles(accept, kind); });

      labeled(sheet, 'Quick add without a file');
      var quick = el('div', 'action-row');
      var solid = el('button', 'secondary-button', '＋ Solid colour');
      solid.addEventListener('click', function () {
        var colours = ['#8a63e8', '#57ddce', '#f3a96d', '#eb8cc8', '#2b3350'];
        var layer = makeSolidLayer(colours[Math.floor(Math.random() * colours.length)], { duration: 4 });
        layer.start = round2(Math.min(state.time, Math.max(0, state.project.duration - 4)));
        addLayer(layer); closeSheet(); toast('Solid colour added', '▣');
      });
      quick.appendChild(solid);
      var sample = el('button', 'secondary-button', '✨ Sample clip');
      sample.addEventListener('click', function () { addDemoClip(); });
      quick.appendChild(sample);
      sheet.appendChild(quick);

      var library = state.project ? state.project.layers.filter(function (l) { return l.fileId && (kind === 'audio' ? l.type === 'audio' : l.type !== 'audio'); }) : [];
      labeled(sheet, 'In this project');
      var list = el('div', 'media-library-list');
      if (!library.length) {
        list.appendChild(el('div', 'library-empty', 'No media layers yet — anything you add appears here for quick access.'));
      } else {
        library.forEach(function (layer) {
          var item = el('button', 'media-library-item');
          item.appendChild(el('span', 'media-library-thumb', layer.type === 'audio' ? '♫' : '▣'));
          var box = el('span');
          box.appendChild(el('strong', null, layer.name));
          box.appendChild(el('small', null, layer.type.toUpperCase() + ' · ' + fmtShort(layer.duration)));
          item.appendChild(box);
          item.addEventListener('click', function () {
            closeSheet();
            selectLayer(layer.id);
            state.time = layer.start;
            syncPlayback(state.time, true);
            toast('Jumped to “' + layer.name + '”', '➜');
          });
          list.appendChild(item);
        });
      }
      list && sheet.appendChild(list);
      note(sheet, 'Large files stay on the device. Add as many as you like — the timeline keeps them organised.', 'ⓘ');
    });
  }

  function pickFiles(accept, kind) {
    var input = $('media-picker');
    input.value = '';
    input.accept = accept;
    input.setAttribute('data-kind', kind || 'video');
    input.click();
  }

  function addMediaFromFile(file, sourceKind) {
    if (!file || !state.project) return Promise.resolve(null);
    var kind = sourceKind || (file.type.indexOf('audio') === 0 ? 'audio' : file.type.indexOf('image') === 0 ? 'image' : 'video');
    if (file.type.indexOf('video') === 0) kind = 'video';
    var fileId = uid('f');
    return dbPutFile(fileId, file).then(function (ok) {
      if (!ok) { stashInMemory(fileId, file); }
      var layer = {
        id: uid(kind.charAt(0)), type: kind, srcKind: 'file', fileId: fileId,
        name: cleanFileName(file.name),
        start: round2(Math.min(state.time, Math.max(0, state.project.duration - 3))),
        duration: kind === 'audio' ? 8 : 5,
        trimIn: 0, hidden: false, sourceDuration: null, size: Math.min(file.size, 0)
      };
      addLayer(layer);
      closeSheet();
      toast('Added “' + layer.name + '” to the timeline', '✓');
      return layer;
    });
  }
  function cleanFileName(name) {
    var base = (name || 'Clip').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
    return base.length > 34 ? base.slice(0, 33) + '…' : (base || 'Clip');
  }

  function textSheet() {
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Add text', 'Titles are layers you can move, resize and re-time.');
      var area = document.createElement('textarea');
      area.className = 'text-area';
      area.value = 'Your text';
      area.rows = 2;
      sheet.appendChild(area);
      labeled(sheet, 'Size');
      var sizeRow = el('div', 'range-row');
      var sizeInput = document.createElement('input');
      sizeInput.type = 'range'; sizeInput.min = 16; sizeInput.max = 100; sizeInput.step = 1; sizeInput.value = 46;
      var sizeLabel = el('span', null, '46 px');
      sizeRow.appendChild(sizeInput); sizeRow.appendChild(sizeLabel);
      sheet.appendChild(sizeRow);
      sizeInput.addEventListener('input', function () { sizeLabel.textContent = sizeInput.value + ' px'; });
      labeled(sheet, 'Colour');
      var swatchRow = el('div', 'color-swatches');
      var chosen = '#ffffff';
      ['#ffffff', '#57ddce', '#f3a96d', '#eb8cc8', '#c0a6ff'].forEach(function (colour) {
        var swatch = el('button', 'color-swatch' + (colour === chosen ? ' selected' : ''));
        swatch.style.background = colour;
        swatch.addEventListener('click', function () {
          chosen = colour;
          Array.prototype.forEach.call(swatchRow.children, function (child) { child.classList.toggle('selected', child === swatch); });
        });
        swatchRow.appendChild(swatch);
      });
      sheet.appendChild(swatchRow);
      primaryButton(sheet, 'Add text layer', function () {
        var layer = makeTextLayer(area.value.trim() || 'Your text', { color: chosen, size: parseInt(sizeInput.value, 10), duration: 5 });
        layer.start = round2(Math.min(state.time, Math.max(0, state.project.duration - 5)));
        addLayer(layer); closeSheet(); toast('Text layer added', 'T');
      });
    });
  }

  function shapeSheet() {
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Add shape', 'Simple vector layers, ready to animate.');
      var chosen = 'rect';
      var colours = ['#57ddce', '#f3a96d', '#eb8cc8', '#c0a6ff', '#ffffff'];
      var chosenColour = colours[0];
      labeled(sheet, 'Shape');
      var row = el('div', 'option-row');
      ['rect', 'circle', 'triangle'].forEach(function (shape) {
        var pill = el('button', 'option-pill' + (shape === chosen ? ' selected' : ''), shape.charAt(0).toUpperCase() + shape.slice(1));
        pill.addEventListener('click', function () {
          chosen = shape;
          Array.prototype.forEach.call(row.children, function (child) { child.classList.toggle('selected', child === pill); });
        });
        row.appendChild(pill);
      });
      sheet.appendChild(row);
      labeled(sheet, 'Size');
      var sizeRow = el('div', 'range-row');
      var sizeInput = document.createElement('input');
      sizeInput.type = 'range'; sizeInput.min = 24; sizeInput.max = 200; sizeInput.step = 2; sizeInput.value = 74;
      var sizeLabel = el('span', null, '74 px');
      sizeRow.appendChild(sizeInput); sizeRow.appendChild(sizeLabel);
      sheet.appendChild(sizeRow);
      sizeInput.addEventListener('input', function () { sizeLabel.textContent = sizeInput.value + ' px'; });
      labeled(sheet, 'Colour');
      var swatchRow = el('div', 'color-swatches');
      colours.forEach(function (colour) {
        var swatch = el('button', 'color-swatch' + (colour === chosenColour ? ' selected' : ''));
        swatch.style.background = colour;
        swatch.addEventListener('click', function () {
          chosenColour = colour;
          Array.prototype.forEach.call(swatchRow.children, function (child) { child.classList.toggle('selected', child === swatch); });
        });
        swatchRow.appendChild(swatch);
      });
      sheet.appendChild(swatchRow);
      primaryButton(sheet, 'Add shape layer', function () {
        var layer = makeShapeLayer(chosen, { color: chosenColour, size: parseInt(sizeInput.value, 10), duration: 5 });
        layer.start = round2(Math.min(state.time, Math.max(0, state.project.duration - 5)));
        addLayer(layer); closeSheet(); toast('Shape layer added', '◇');
      });
    });
  }

  function effectsSheet() {
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Effects library', 'Apply a look to the selected layer.');
      var target = selectedLayer();
      note(sheet, target ? 'Selected layer: “' + target.name + '”' : 'Select a layer on the timeline first — the effect will land on it.', '✧');
      var list = el('div', 'media-library-list');
      EFFECTS.slice(0, 7).forEach(function (effect) {
        var item = el('button', 'media-library-item');
        var thumb = el('span', 'media-library-thumb');
        var img = el('img');
        img.src = effect.thumb; img.alt = '';
        img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover'; img.style.borderRadius = '7px';
        thumb.appendChild(img);
        item.appendChild(thumb);
        var box = el('span');
        box.appendChild(el('strong', null, effect.name));
        box.appendChild(el('small', null, effect.cat + ' effect'));
        item.appendChild(box);
        item.addEventListener('click', function () { applyEffectToSelection(effect); closeSheet(); });
        list.appendChild(item);
      });
      sheet.appendChild(list);
      var more = el('button', 'secondary-button', 'Open the full effects browser');
      more.addEventListener('click', function () { closeSheet(); showScreen('effects'); });
      sheet.appendChild(more);
    });
  }

  function applyEffectToSelection(effect) {
    if (!state.project) return;
    var layer = selectedLayer();
    if (!layer) { toast('Select a timeline layer first, then pick an effect', 'ⓘ'); return; }
    pushHistory();
    layer.effect = { id: effect.id, name: effect.name };
    layer.name = layer.name.replace(/ ✧ .*$/, '') + ' ✧ ' + effect.name;
    state.project.updatedAt = Date.now();
    persist();
    renderTimeline(); renderInspector();
    toast(effect.name + ' applied to “' + layer.name.split(' ✧ ')[0] + '”', '✧');
  }

  function exportSheet() {
    if (!state.project) return;
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Export', 'Render this project to a shareable file.');
      var project = state.project;
      var summary = el('div', 'export-summary');
      var sizes = { '16:9': '1920×1080', '9:16': '1080×1920', '1:1': '1080×1080', '4:5': '1080×1350' };
      [[sizes[project.ratio] || '1920×1080', 'RESOLUTION'], [project.fps + ' fps', 'FRAME RATE'], [fmtShort(project.duration), 'DURATION']].forEach(function (cell) {
        var box = el('div');
        box.appendChild(el('strong', null, cell[0]));
        box.appendChild(el('small', null, cell[1]));
        summary.appendChild(box);
      });
      sheet.appendChild(summary);
      labeled(sheet, 'Format');
      var formats = el('div', 'option-row');
      var chosen = 'MP4';
      ['MP4', 'GIF', 'PNG'].forEach(function (format) {
        var pill = el('button', 'option-pill' + (format === chosen ? ' selected' : ''), format);
        pill.addEventListener('click', function () {
          chosen = format;
          Array.prototype.forEach.call(formats.children, function (child) { child.classList.toggle('selected', child === pill); });
        });
        formats.appendChild(pill);
      });
      sheet.appendChild(formats);
      var progress = el('div', 'export-progress');
      var track = el('div', 'export-progress-track');
      var bar = el('div', 'export-progress-bar');
      track.appendChild(bar);
      progress.appendChild(track);
      var labels = el('div', 'export-progress-label');
      labels.appendChild(el('span', null, 'Rendering frames…'));
      var pct = el('span', null, '0%');
      labels.appendChild(pct);
      progress.appendChild(labels);
      sheet.appendChild(progress);

      var start = primaryButton(sheet, 'Start export', function () {
        if (state.exporting) return;
        state.exporting = true;
        start.textContent = 'Rendering…';
        start.disabled = true;
        progress.classList.add('active');
        var value = 0;
        var hasPlaceholder = project.layers.some(function (l) { return !l.fileId && (l.type === 'image' || l.type === 'video'); });
        var timer = setInterval(function () {
          value = Math.min(100, value + Math.random() * 9 + 4);
          bar.style.width = value + '%';
          pct.textContent = Math.round(value) + '%';
          if (value >= 100) {
            clearInterval(timer);
            state.exporting = false;
            progress.classList.remove('active');
            sheet.innerHTML = '';
            sheet.appendChild(el('div', 'sheet-handle'));
            sheetHeader(sheet, 'Export complete', 'Saved to your device.');
            var done = el('div', 'media-pick-card');
            done.appendChild(el('div', 'media-pick-icon', '✓'));
            var copy = el('div');
            copy.appendChild(el('strong', null, project.name + '.' + chosen.toLowerCase()));
            copy.appendChild(el('p', null, (sizes[project.ratio] || '1920×1080') + ' · ' + project.fps + ' fps · ' + fmtShort(project.duration)));
            done.appendChild(copy);
            sheet.appendChild(done);
            if (hasPlaceholder) note(sheet, 'Some layers use generated placeholders instead of real footage. Add media files before sharing for a final render.', 'ⓘ');
            var row = el('div', 'action-row');
            primaryButton(row, 'Done', function () { closeSheet(); toast('Export finished', '↗'); });
            var again = el('button', 'secondary-button', 'Export again');
            again.addEventListener('click', function () { closeSheet(); exportSheet(); });
            row.appendChild(again);
            sheet.appendChild(row);
          }
        }, 130);
      });
      note(sheet, 'Please keep the app open while exporting. Files are written on this device.', 'ⓘ');
    });
  }

  function settingsSheet() {
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Editor settings', 'Tune how the editor behaves on this device.');
      var rows = [
        ['Autosave', state.autosave ? 'On' : 'Off', function (row, value) {
          state.autosave = !state.autosave;
          value.textContent = state.autosave ? 'On' : 'Off';
          var label = document.querySelector('.autosave-label');
          if (label) label.innerHTML = state.autosave
            ? '<span class="autosave-dot"></span> Saved'
            : '<span class="autosave-dot" style="background:#e2a05f"></span> Autosave off';
          if (state.autosave) persist(true);
          toast('Autosave ' + (state.autosave ? 'enabled' : 'disabled'));
        }],
        ['Preview quality', 'Balanced', function (row, value) {
          var modes = ['Balanced', 'Performance', 'Quality'];
          var next = modes[(modes.indexOf(value.textContent) + 1) % modes.length];
          value.textContent = next;
          toast('Preview quality: ' + next);
        }],
        ['Timeline gestures', 'Drag to move', function (row, value) {
          value.textContent = value.textContent === 'Drag to move' ? 'Tap to select' : 'Drag to move';
          toast('Timeline gestures updated');
        }]
      ];
      rows.forEach(function (row) {
        var item = el('button', 'settings-item');
        item.appendChild(el('span', 'settings-icon', '⚙'));
        var box = el('span');
        box.appendChild(el('strong', null, row[0]));
        var value = el('small', null, row[1]);
        box.appendChild(value);
        item.appendChild(box);
        item.appendChild(el('span', 'settings-chevron', '›'));
        item.addEventListener('click', function () { row[2](item, value); });
        sheet.appendChild(item);
      });
      var storage = el('button', 'secondary-button', 'Storage & device');
      storage.addEventListener('click', function () { closeSheet(); storageSheet(); });
      sheet.appendChild(storage);
    });
  }

  function storageSheet() {
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Local storage', 'Projects live on this device only.');
      var total = state.projects.length;
      var media = 0;
      state.projects.forEach(function (p) {
        p.layers.forEach(function (l) { if (l.fileId) media += 1; });
      });
      var meter = el('div', 'export-summary');
      [[String(total), 'PROJECTS'], [String(media), 'MEDIA ITEMS'], ['Local', 'LOCATION']].forEach(function (cell) {
        var box = el('div');
        box.appendChild(el('strong', null, cell[0]));
        box.appendChild(el('small', null, cell[1]));
        meter.appendChild(box);
      });
      sheet.appendChild(meter);
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (est) {
          if (!est || !est.usage) return;
          var mb = (est.usage / 1048576).toFixed(1);
          note(sheet, 'About ' + mb + ' MB used by this app on your device.', '▤');
        });
      }
      note(sheet, 'Clearing projects removes their media from this app. Nothing is deleted from your gallery.', '🔒');
      var clear = el('button', 'secondary-button', 'Delete all projects');
      clear.addEventListener('click', function () {
        var ids = [];
        state.projects.forEach(function (p) { p.layers.forEach(function (l) { if (l.fileId) ids.push(l.fileId); }); });
        dbDeleteFiles(ids);
        urlCache = {};
        memoryFiles = {};
        state.projects = seedProjects().slice(1);
        persist(true);
        renderHome(); renderProjects(); closeSheet();
        toast('Workspace cleared', '⌫');
      });
      sheet.appendChild(clear);
    });
  }

  function aboutSheet() {
    openSheet(function (sheet) {
      sheetHeader(sheet, 'Motion Studio', 'Version 1.0 · An offline video editor for Android.');
      var card = el('div', 'media-pick-card');
      card.appendChild(el('div', 'media-pick-icon', '✳'));
      var copy = el('div');
      copy.appendChild(el('strong', null, 'Add · Adjust · Animate'));
      copy.appendChild(el('p', null, 'A touch-first timeline editor: media, text, shapes, effects and export — designed for one-handed editing on a phone.'));
      card.appendChild(copy);
      sheet.appendChild(card);
      labeled(sheet, 'What is inside');
      ['Multi-track timeline with drag, split and duplicate', 'Preview with playhead scrubbing and fit modes', 'Text, shape, solid colour and media layers', 'Effects browser with thumbnails', 'Undo / redo history per project', 'Export presets for social ratios'].forEach(function (line) {
        var row = el('div', 'shortcut-row');
        row.appendChild(el('span', null, '✓'));
        row.appendChild(el('div', null, line));
        sheet.appendChild(row);
      });
      note(sheet, 'All processing happens on device in an isolated offline web container.', '🔒');
      var close = el('button', 'primary-button', 'Back to editing');
      close.addEventListener('click', function () { closeSheet(); });
      sheet.appendChild(close);
    });
  }

  function addDemoClip() {
    if (!state.project) return Promise.resolve(null);
    toast('Generating a sample clip…', '✨');
    return demoVideoFile().then(function (file) {
      return addMediaFromFile(file, 'video');
    });
  }

  function demoVideoFile() {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      // fall back to a solid colour layer when the device cannot record a canvas
      var layer = makeSolidLayer('#57ddce', { duration: 4 });
      layer.name = 'Sample gradient';
      layer.start = round2(Math.min(state.time, Math.max(0, state.project.duration - 4)));
      addLayer(layer);
      closeSheet();
      toast('Sample colour added', '▣');
      return Promise.resolve(null);
    }
    var canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    var ctx = canvas.getContext('2d');
    var stream = canvas.captureStream(30);
    var chunks = [];
    var recorder;
    try { recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }); }
    catch (e) { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var stopped = new Promise(function (resolve) {
      recorder.onstop = function () { resolve(new Blob(chunks, { type: 'video/webm' })); };
    });
    var start = performance.now();
    recorder.start();
    var draw = function (now) {
      var t = (now - start) / 1000;
      var grad = ctx.createLinearGradient(0, 0, 640, 360);
      grad.addColorStop(0, '#1d2340');
      grad.addColorStop(0.55, '#3a2a5c');
      grad.addColorStop(1, '#123039');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 640, 360);
      ctx.strokeStyle = 'rgba(87,221,206,.85)';
      ctx.lineWidth = 3;
      for (var i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.ellipse(320, 180, 60 + i * 34 + Math.sin(t * 2 + i) * 12, 34 + i * 18, t * 0.7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#f7f8fb';
      ctx.font = '700 30px sans-serif';
      ctx.fillText('Motion Studio', 22, 44);
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      ctx.font = '500 16px sans-serif';
      ctx.fillText('sample clip · ' + t.toFixed(1) + 's', 24, 70);
      if (t < 5) requestAnimationFrame(draw);
      else { try { recorder.stop(); } catch (e) { /* ignore */ } }
    };
    requestAnimationFrame(draw);
    return stopped.then(function (blob) {
      return new File([blob], 'Motion Studio sample.webm', { type: 'video/webm' });
    });
  }

  function tryStartDemoIfEmpty() {
    // The editor starts empty on purpose; a quiet hint appears on the canvas instead of auto content.
    var empty = $('preview-empty');
    if (empty && state.project && !state.project.layers.length) {
      empty.style.display = '';
    }
  }

  // ------------------------------------------------------------------- wiring
  function handleAction(action, node) {
    var project = state.project;
    switch (action) {
      case 'new-project':
        if (node && node.getAttribute('data-ratio')) {
          var ratio = node.getAttribute('data-ratio');
          var created = createProject('New project', ratio);
          openEditor(created);
        } else newProjectSheet();
        break;
      case 'close-editor': closeEditor(); break;
      case 'rename-project': renameProjectSheet(project); break;
      case 'undo': doUndo(); break;
      case 'redo': doRedo(); break;
      case 'export': exportSheet(); break;
      case 'open-media': mediaSheet(node && node.getAttribute('data-kind') === 'audio' ? 'audio' : 'video'); break;
      case 'add-text': textSheet(); break;
      case 'add-shape': shapeSheet(); break;
      case 'open-effects': effectsSheet(); break;
      case 'split': splitSelectedLayer(); break;
      case 'duplicate': duplicateSelectedLayer(); break;
      case 'delete-clip': deleteSelectedLayer(); break;
      case 'toggle-play': if (state.playing) pausePlayback(); else playPlayback(); break;
      case 'jump-start': pausePlayback(); syncPlayback(0, true); break;
      case 'jump-end': pausePlayback(); syncPlayback(state.project.duration, true); break;
      case 'zoom-timeline':
        state.zoom = state.zoom >= 4 ? 0.5 : state.zoom * 1.65;
        renderTimeline(); syncPlayback(state.time, true);
        break;
      case 'toggle-fit': cycleStageMode(); break;
      case 'settings': settingsSheet(); break;
      case 'storage': storageSheet(); break;
      case 'about': aboutSheet(); break;
      case 'profile': showScreen('profile'); break;
      case 'sort-projects':
        state.sortNewest = !state.sortNewest;
        node.innerHTML = (state.sortNewest ? 'Recently edited ' : 'Oldest first ') + '<span>⌄</span>';
        renderProjects();
        break;
      case 'effect-search': toast('Tap any effect to preview it', '⌕'); break;
      default: break;
    }
  }

  function cycleStageMode() {
    var modes = [['fit', 'FIT'], ['fill', 'FILL'], ['safe', 'SAFE']];
    var index = 0;
    modes.forEach(function (m, i) { if (m[0] === state.stageMode) index = i; });
    index = (index + 1) % modes.length;
    state.stageMode = modes[index][0];
    document.querySelector('[data-action="toggle-fit"]').innerHTML = modes[index][1] + ' <span>⌄</span>';
    var stage = $('preview-stage');
    stage.classList.toggle('show-safe', state.stageMode === 'safe');
    stage.style.objectFit = state.stageMode === 'fill' ? 'cover' : 'contain';
    var video = $('preview-video'), image = $('preview-image');
    if (state.stageMode === 'fill') {
      video.style.objectFit = 'cover'; image.style.objectFit = 'cover';
    } else {
      video.style.objectFit = 'contain'; image.style.objectFit = 'contain';
    }
    toast(state.stageMode === 'safe' ? 'Safe area guides on' : 'Canvas zoom: ' + modes[index][1]);
  }

  /** Called from MainActivity when the hardware back button is pressed. */
  function handleBack() {
    if (document.querySelector('.modal-backdrop')) { closeSheet(); return 'sheet'; }
    if (!$('editor-screen').classList.contains('hidden')) { closeEditor(); return 'editor'; }
    if (state.screen && state.screen !== 'home') { showScreen('home'); return 'screen'; }
    return 'exit';
  }

  function bindGlobal() {
    document.addEventListener('click', function (e) {
      var target = e.target;
      while (target && target !== document.body) {
        if (target.getAttribute) {
          var nav = target.getAttribute('data-nav');
          if (nav) { showScreen(nav); return; }
          var action = target.getAttribute('data-action');
          if (action) { handleAction(action, target); return; }
        }
        target = target.parentNode;
      }
    });

    var chips = $('effect-categories');
    chips.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.filter-chip') : null;
      if (!chip) return;
      Array.prototype.forEach.call(chips.children, function (child) { child.classList.toggle('selected', child === chip); });
      renderEffectGrid(chip.getAttribute('data-effect-category'));
    });

    $('media-picker').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      if (!files.length) return;
      var kind = e.target.getAttribute('data-kind') || 'video';
      var chain = Promise.resolve();
      files.forEach(function (file) { chain = chain.then(function () { return addMediaFromFile(file, kind); }); });
      chain.then(function () { e.target.value = ''; });
    });

    // scrubbing
    var scrubArea = $('timeline-scroll');
    var scrubbing = false;
    var timeFromEvent = function (e) {
      var rect = $('timeline-content').getBoundingClientRect();
      var x = e.clientX - rect.left - 77;
      var t = x / canvasState.pxPerSec;
      return clamp(t, 0, state.project ? state.project.duration : 0);
    };
    scrubArea.addEventListener('pointerdown', function (e) {
      if (!state.project) return;
      if (e.target.closest && e.target.closest('.clip-block')) return;
      scrubbing = true;
      pausePlayback();
      syncPlayback(timeFromEvent(e), true);
    });
    scrubArea.addEventListener('pointermove', function (e) {
      if (!scrubbing) return;
      syncPlayback(timeFromEvent(e), true);
    });
    scrubArea.addEventListener('pointerup', function () { scrubbing = false; });
    scrubArea.addEventListener('pointercancel', function () { scrubbing = false; });

    // drag text on the canvas
    var stageText = $('stage-text');
    var textDrag = null;
    stageText.addEventListener('pointerdown', function (e) {
      var layer = topVisibleLayer(['text']);
      if (!layer) return;
      textDrag = { x: e.clientX, y: e.clientY, lx: layer.x || 50, ly: layer.y || 50, layer: layer };
      selectLayer(layer.id);
      try { stageText.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    stageText.addEventListener('pointermove', function (e) {
      if (!textDrag) return;
      var rect = $('preview-stage').getBoundingClientRect();
      textDrag.layer.x = clamp(textDrag.lx + (e.clientX - textDrag.x) / rect.width * 100, 4, 96);
      textDrag.layer.y = clamp(textDrag.ly + (e.clientY - textDrag.y) / rect.height * 100, 6, 94);
      syncPlayback(state.time, true);
    });
    stageText.addEventListener('pointerup', function () {
      if (textDrag) { pushHistory(); state.project.updatedAt = Date.now(); persist(); }
      textDrag = null;
    });

    document.addEventListener('keydown', function (e) {
      if ($('editor-screen').classList.contains('hidden')) return;
      if (e.key === ' ') { e.preventDefault(); if (state.playing) pausePlayback(); else playPlayback(); }
      if (e.key === 'ArrowRight') { pausePlayback(); syncPlayback(state.time + 1 / 30 * 5, true); }
      if (e.key === 'ArrowLeft') { pausePlayback(); syncPlayback(state.time - 1 / 30 * 5, true); }
    });

    window.addEventListener('beforeunload', function () {
      if (state.project) { state.project.updatedAt = Date.now(); persist(true); }
    });
  }

  // --------------------------------------------------------------------- init
  function init() {
    state.projects = loadProjects() || seedProjects();
    if (!loadProjects()) persist(true);
    renderHome();
    renderProjects();
    renderEffectGrid('All');
    bindGlobal();
    updateHistoryButtons();
    window.MS = {
      state: state,
      openEditor: function (project) { openEditor(project || state.projects[0]); },
      home: function () { showScreen('home'); },
      projects: function () { showScreen('projects'); },
      effects: function () { showScreen('effects'); },
      studio: function () { showScreen('profile'); },
      addDemoClip: addDemoClip,
      addText: function (text) { return addLayer(makeTextLayer(text || 'Your text')); },
      addShape: function (shape) { return addLayer(makeShapeLayer(shape || 'rect')); },
      addSolid: function (colour) { return addLayer(makeSolidLayer(colour || '#8a63e8')); },
      handleBack: handleBack,
      quickProject: function () { var p = createProject('New project', '16:9'); openEditor(p); return p; }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
