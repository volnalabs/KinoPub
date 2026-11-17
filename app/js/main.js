/*
 * CDNViewer — открывает сайт на весь экран Samsung Smart TV (Tizen).
 * Адрес берётся из remote-config.json на GitHub (см. app-config.js),
 * последний полученный адрес хранится на телевизоре.
 * Настройки: долгое нажатие OK на пульте.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var DEFAULT_URL = normalizeUrl(CFG.defaultUrl) || 'https://cdnservices.link';
  var CHECK_INTERVAL_MS = Math.max(1, +CFG.checkIntervalMinutes || 15) * 60000;
  var RETRY_AFTER_FAIL_MS = Math.min(CHECK_INTERVAL_MS, 2 * 60000);
  var REQUEST_TIMEOUT_MS = +CFG.requestTimeoutMs || 8000;
  var STARTUP_WAIT_MS = +CFG.startupWaitMs || 5000;
  var LONG_PRESS_MS = +CFG.longPressMs || 1200;
  var SETTINGS_WINDOW_MS = +CFG.settingsWindowMs || 2500;
  var STORE_KEY = 'cdnviewer.state.v1';

  var KEY = {
    ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    IME_DONE: 65376, IME_CANCEL: 65385
  };

  /* ===================== Хранилище ===================== */

  var state = loadState();

  function loadState() {
    var s = null;
    try { s = JSON.parse(window.localStorage.getItem(STORE_KEY)); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') { s = {}; }
    return {
      autoUpdate: s.autoUpdate !== false,
      manualUrl: normalizeUrl(s.manualUrl),
      remoteUrl: normalizeUrl(s.remoteUrl),
      lastCheck: +s.lastCheck || 0,
      lastCheckOk: !!s.lastCheckOk,
      lastError: typeof s.lastError === 'string' ? s.lastError : '',
      // false — сайт открывается напрямую в окне приложения (как в официальных Tizen-клиентах),
      // true — внутри iframe (адрес проверяется каждые 15 минут, пока приложение открыто)
      embed: s.embed === true,
      // Хосты, до которых с этого ТВ не устанавливается HTTPS (устаревшие корневые сертификаты)
      plainHttp: (s.plainHttp && typeof s.plainHttp === 'object') ? s.plainHttp : {},
      noFrame: (s.noFrame && typeof s.noFrame === 'object') ? s.noFrame : {}
    };
  }

  function saveState() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* хранилище недоступно */ }
  }

  function normalizeUrl(v) {
    if (typeof v !== 'string') { return null; }
    v = v.replace(/^\s+|\s+$/g, '');
    if (!v) { return null; }
    if (!/^[a-z][a-z0-9+.\-]*:\/\//i.test(v)) { v = 'https://' + v; }
    if (!/^https?:\/\/[a-z0-9¡-￿.\-]+(:\d{1,5})?([\/?#]\S*)?$/i.test(v)) { return null; }
    return v;
  }

  function urlKey(u) {
    return String(u || '').replace(/\/+$/, '').toLowerCase();
  }

  function sameUrl(a, b) {
    return !!a && !!b && urlKey(a) === urlKey(b);
  }

  // Адрес, который должен быть открыт при текущих настройках
  function targetUrl() {
    if (!state.autoUpdate && state.manualUrl) { return state.manualUrl; }
    return state.remoteUrl || DEFAULT_URL;
  }

  function targetSource() {
    if (!state.autoUpdate && state.manualUrl) { return 'вручную'; }
    return state.remoteUrl ? 'GitHub' : 'встроенный';
  }

  /* ===================== GitHub ===================== */

  function remoteSources() {
    var owner = CFG.githubOwner, repo = CFG.githubRepo;
    var ref = CFG.githubRef || 'HEAD';
    var path = String(CFG.configPath || 'remote-config.json').replace(/^\/+/, '');
    var encPath = path.split('/').map(encodeURIComponent).join('/');
    var bust = '_=' + new Date().getTime();
    return [
      {
        url: 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + ref + '/' + encPath + '?' + bust,
        headers: {}
      },
      {
        url: 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + encPath +
          '?' + (ref !== 'HEAD' ? 'ref=' + encodeURIComponent(ref) + '&' : '') + bust,
        headers: { 'Accept': 'application/vnd.github.raw' }
      }
    ];
  }

  function httpGet(url, headers, timeoutMs, cb) {
    var done = false, xhr = null, timer = null;
    function finish(err, text) {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      cb(err, text);
    }
    timer = setTimeout(function () {
      try { xhr.abort(); } catch (e) { /* ignore */ }
      finish(new Error('тайм-аут'));
    }, timeoutMs);
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      for (var h in headers) {
        if (headers.hasOwnProperty(h)) { xhr.setRequestHeader(h, headers[h]); }
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) { return; }
        if (xhr.status >= 200 && xhr.status < 300) { finish(null, xhr.responseText); }
        else if (xhr.status === 0) { finish(new Error('нет связи')); }
        else { finish(new Error('HTTP ' + xhr.status)); }
      };
      xhr.onerror = function () { finish(new Error('нет связи')); };
      xhr.send(null);
    } catch (e) {
      finish(e);
    }
  }

  function decodeBase64Utf8(b64) {
    var bin = window.atob(String(b64).replace(/\s+/g, ''));
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }

  function parseRemote(text) {
    if (typeof text !== 'string' || !text) { throw new Error('пустой ответ'); }
    var obj;
    try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error('неверный JSON'); }
    // Ответ GitHub API без raw-формата: { content: base64, encoding: "base64" }
    if (obj && typeof obj.content === 'string' && obj.encoding === 'base64') {
      try { obj = JSON.parse(decodeBase64Utf8(obj.content).replace(/^﻿/, '')); } catch (e) { throw new Error('неверный JSON'); }
    }
    var u = obj && typeof obj === 'object' ? normalizeUrl(obj.url) : null;
    if (!u) { throw new Error('в JSON нет корректного поля "url"'); }
    return u;
  }

  var checkCallbacks = null;

  // Запрашивает remote-config.json. cb(err, url)
  function checkRemote(cb) {
    if (checkCallbacks) { checkCallbacks.push(cb); return; }
    checkCallbacks = [cb];
    var sources = remoteSources();
    var i = 0, lastErr = null;

    function done(err, url) {
      state.lastCheck = new Date().getTime();
      state.lastCheckOk = !err;
      state.lastError = err ? String(err.message || err) : '';
      if (!err) { state.remoteUrl = url; }
      saveState();
      var list = checkCallbacks;
      checkCallbacks = null;
      for (var k = 0; k < list.length; k++) {
        try { if (list[k]) { list[k](err, url); } } catch (e) { /* ignore */ }
      }
    }

    (function next() {
      if (i >= sources.length) { done(lastErr || new Error('GitHub недоступен')); return; }
      var src = sources[i++];
      httpGet(src.url, src.headers, REQUEST_TIMEOUT_MS, function (err, text) {
        if (!err) {
          try { done(null, parseRemote(text)); return; } catch (e) { err = e; }
        }
        lastErr = lastErr || err;
        next();
      });
    })();
  }

  /* ===================== Отображение сайта ===================== */

  var loadingEl, loadingTextEl, frame = null, currentUrl = null;
  var frameLoaded = false, loadingTimer = null, retryTimer = null;
  var directTimer = null, pendingDirectUrl = null, pendingOpenUrl = null, waitingOnline = false;

  function showLoading(on, text) {
    loadingEl.className = on ? 'loading' : 'loading hidden';
    loadingTextEl.textContent = text || (on && hold.active ? HINT_TEXT : '');
    if (hintEl) { updateHint(); }
  }

  function openWhenOnline(url) {
    if (navigator.onLine === false) {
      waitingOnline = true;
      currentUrl = url;
      showLoading(true, 'Нет подключения к сети');
      return;
    }
    openUrl(url);
  }

  function openUrl(url) {
    if (!url) { return; }
    // Пока открыты настройки, сайт не перезагружаем (он забрал бы фокус пульта)
    if (settingsOpen) { pendingOpenUrl = url; currentUrl = url; return; }
    pendingOpenUrl = null;
    pendingDirectUrl = null;
    unreachableUrl = null;
    waitingOnline = false;
    currentUrl = url;
    clearTimeout(retryTimer);
    clearTimeout(directTimer);
    showLoading(true);
    var token = ++openToken;
    resolveScheme(url, function (finalUrl, reachable) {
      if (token !== openToken) { return; }
      if (settingsOpen) { pendingOpenUrl = url; return; } // продолжим после закрытия настроек
      if (!reachable) { showUnreachable(url, finalUrl); return; }
      openResolved(finalUrl);
    });
  }

  function openResolved(finalUrl) {
    unreachableUrl = null;
    clearTimeout(retryTimer);
    openedUrl = finalUrl;
    if (!state.embed || state.noFrame[urlKey(finalUrl)]) { openDirect(finalUrl); } else { openFrame(finalUrl); }
  }

  // Сайт не отвечает с этого ТВ ни по HTTPS, ни по HTTP (чаще всего — блокировка провайдером).
  // Вместо чёрного экрана показываем причину и повторяем попытку; OK — открыть всё равно.
  var unreachableUrl = null;

  function showUnreachable(url, finalUrl) {
    unreachableUrl = finalUrl;
    var host = (/^[a-z]+:\/\/([^\/?#]+)/i.exec(finalUrl) || [])[1] || finalUrl;
    showLoading(true, 'Сайт ' + host + ' не отвечает с этого телевизора — возможно, его блокирует провайдер.\n' +
      'Повтор через 15 с. OK — открыть всё равно, удерживайте OK — настройки');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { if (unreachableUrl && !settingsOpen) { openUrl(url); } }, 15000);
  }

  /* ----- Проверка доступности конкретного URL -----
   * Не проверяем корень домена и произвольные favicon-файлы: CDN может отдавать
   * изображение, даже если главная страница и стандартные иконки недоступны.
   * Ошибка предварительной проверки не должна блокировать прямое открытие URL. */
  var openToken = 0, openedUrl = null;
  var PROBE_TIMEOUT_MS = 6000;

  function isImageUrl(url) {
    var path = String(url || '').split(/[?#]/)[0].toLowerCase();
    return /\\.(avif|bmp|gif|jpe?g|png|svg|webp)$/.test(path);
  }

  // Проверяет именно запрошенный ресурс. Для изображений Image() не требует CORS.
  // Для страниц используем no-cors fetch, а при его отсутствии — обычный XHR.
  function probeUrl(url, cb) {
    var done = false, pending = 0, timer = null;

    function finish(ok) {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      cb(ok);
    }

    function fail() {
      if (done) { return; }
      pending--;
      if (pending <= 0) { finish(false); }
    }

    timer = setTimeout(function () { finish(false); }, PROBE_TIMEOUT_MS);

    if (isImageUrl(url)) {
      var img = new Image();
      img.onload = function () { finish(true); };
      img.onerror = function () { finish(false); };
      img.src = url;
      return;
    }

    if (typeof window.fetch === 'function') {
      pending++;
      try {
        window.fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' })
          .then(function () { finish(true); }, fail);
      } catch (e) { fail(); }
    }

    pending++;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onreadystatechange = function () {
        if (done || xhr.readyState !== 4) { return; }
        if (xhr.status > 0) { finish(true); }
        else { fail(); }
      };
      xhr.onerror = fail;
      xhr.ontimeout = fail;
      xhr.send(null);
    } catch (e) { fail(); }
  }

  function resolveScheme(url, cb) {
    var m = /^https:\\/\\/([^\\/?#]+)(.*)$/i.exec(url);
    if (!m) { cb(url, true); return; }

    var host = m[1].toLowerCase();
    var httpUrl = 'http://' + m[1] + m[2];

    probeUrl(url, function (httpsOk) {
      if (httpsOk) {
        if (state.plainHttp[host]) { delete state.plainHttp[host]; saveState(); }
        cb(url, true);
        return;
      }

      // Переходим на HTTP только когда именно этот ресурс там действительно доступен.
      probeUrl(httpUrl, function (httpOk) {
        if (httpOk) {
          if (!state.plainHttp[host]) { state.plainHttp[host] = true; saveState(); }
          cb(httpUrl, true);
          return;
        }

        // Тайм-аут, CORS или неподдерживаемый probe API не доказывают,
        // что сам адрес недоступен. Передаём исходный URL браузеру в любом случае.
        cb(state.plainHttp[host] ? httpUrl : url, true);
      });
    });
  }

  function openFrame(url) {
    showLoading(true);
    frameLoaded = false;

    if (frame && frame.parentNode) { frame.parentNode.removeChild(frame); }
    frame = document.createElement('iframe');
    frame.id = 'site';
    frame.setAttribute('allowfullscreen', 'true');
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('scrolling', 'no');
    frame.onload = onFrameLoad;
    frame.src = url;
    document.body.insertBefore(frame, document.body.firstChild);

    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(function () { showLoading(false); focusSite(); }, 20000);

    probeFraming(url);
  }

  function frameHref() {
    try { return String(frame.contentWindow.location.href); } catch (e) { return null; }
  }

  function onFrameLoad() {
    var href = frameHref();
    if (href === 'about:blank') { return; }
    // Страница ошибки браузера (сайт не ответил) — пробуем ещё раз
    if (href && /^(chrome-error:|data:text\/html,chromewebdata)/i.test(href)) {
      showLoading(true, 'Сайт не отвечает, повтор…');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(function () { openUrl(currentUrl); }, 10000);
      return;
    }
    frameLoaded = true;
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(function () { showLoading(false); }, 300);
    if (!settingsOpen && !hold.active) { focusSite(); }
  }

  function focusSite() {
    if (!frame || settingsOpen || hold.active) { return; }
    try { frame.focus(); } catch (e) { /* ignore */ }
    try { frame.contentWindow.focus(); } catch (e) { /* ignore */ }
  }

  // Проверка запрета встраивания (X-Frame-Options / CSP frame-ancestors).
  // В Tizen-приложении запросы к доменам из <access> не ограничены CORS, поэтому заголовки доступны.
  function probeFraming(url) {
    var xhr, decided = false;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onreadystatechange = function () {
        if (decided || xhr.readyState < 2) { return; }
        decided = true;
        var blocked = false;
        try {
          var xfo = (xhr.getResponseHeader('X-Frame-Options') || '').toLowerCase();
          var csp = (xhr.getResponseHeader('Content-Security-Policy') || '').toLowerCase();
          if (xfo && xfo.indexOf('allowall') === -1) { blocked = true; }
          var m = /frame-ancestors([^;]*)/.exec(csp);
          if (m && !/(^|\s)\*(\s|$)/.test(m[1])) { blocked = true; }
        } catch (e) { blocked = false; }
        try { xhr.abort(); } catch (e) { /* ignore */ }
        var k = urlKey(url);
        if (blocked && !state.noFrame[k]) {
          state.noFrame[k] = true;
          saveState();
          if (sameUrl(url, openedUrl)) { openDirect(url); }
        } else if (!blocked && state.noFrame[k] && xhr.status) {
          delete state.noFrame[k];
          saveState();
        }
      };
      xhr.send(null);
    } catch (e) { /* ignore */ }
  }

  // Прямой режим: сайт загружается в само окно приложения (без iframe).
  // Настройки доступны при запуске — удержанием OK на экране загрузки.
  function openDirect(url) {
    if (frame && frame.parentNode) { frame.parentNode.removeChild(frame); }
    frame = null;
    frameLoaded = false;
    pendingDirectUrl = url;
    showLoading(true, HINT_TEXT);
    if (state.embed) { probeFraming(url); }
    clearTimeout(directTimer);
    directTimer = setTimeout(goDirect, 0);
  }

  function goDirect() {
    clearTimeout(directTimer);
    if (!pendingDirectUrl || settingsOpen) { return; } // продолжится после закрытия настроек
    if (hold.active) { directTimer = setTimeout(goDirect, 200); return; } // ждём окончания окна настроек
    var u = pendingDirectUrl;
    pendingDirectUrl = null;
    window.location.replace(u);
    // Если телевизор не дал перейти на сайт, страница приложения остаётся на экране —
    // показываем причину и повторяем попытку
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      showLoading(true, 'Не удалось открыть ' + u + ' — повтор… Удерживайте OK — настройки');
      pendingDirectUrl = u;
      directTimer = setTimeout(goDirect, 15000);
    }, 15000);
  }

  function applyTarget(force) {
    var u = targetUrl();
    if (force || !sameUrl(u, currentUrl)) { openWhenOnline(u); }
  }

  /* ===================== Окно доступа к настройкам ===================== */

  // Пока фокус у сайта (iframe другого домена), Tizen доставляет все клавиши только сайту.
  // Поэтому при запуске и при возврате в приложение фокус ненадолго остаётся у приложения:
  // в это время удержание OK открывает настройки.
  var hold = { active: false, timer: null, guard: null };
  var hintEl, focusEl;

  function grabFocus() {
    try { window.focus(); } catch (e) { /* ignore */ }
    try { focusEl.focus(); } catch (e) { /* ignore */ }
  }

  function holdFocus(ms) {
    if (settingsOpen) { return; }
    hold.active = true;
    clearTimeout(hold.timer);
    hold.timer = setTimeout(releaseHold, ms);
    grabFocus();
    // Сайт при загрузке сам ставит фокус на свои элементы — возвращаем его приложению
    clearInterval(hold.guard);
    hold.guard = setInterval(function () {
      if (!hold.active) { clearInterval(hold.guard); return; }
      if (!settingsOpen && (document.activeElement !== focusEl || !document.hasFocus())) { grabFocus(); }
    }, 100);
    updateHint();
  }

  function endHold() {
    hold.active = false;
    clearTimeout(hold.timer);
    clearInterval(hold.guard);
    updateHint();
  }

  function releaseHold() {
    clearTimeout(hold.timer);
    // OK ещё удерживается — ждём, чем закончится нажатие
    // или пока виден экран загрузки
    if ((press.active && !press.fired) || (frame && !frameLoaded)) {
      hold.timer = setTimeout(releaseHold, 250);
      return;
    }
    if (!hold.active) { return; }
    endHold();
    focusSite();
  }

  function updateHint() {
    var loadingShown = loadingEl.className.indexOf('hidden') === -1;
    hintEl.className = (hold.active && !settingsOpen && !loadingShown) ? 'hint' : 'hint hidden';
    if (loadingShown && !loadingTextEl.textContent && hold.active) { loadingTextEl.textContent = HINT_TEXT; }
  }

  var HINT_TEXT = 'Удерживайте OK — настройки';

  /* ===================== Клавиши и долгое нажатие OK ===================== */

  var press = { active: false, released: false, fired: false, longTimer: null, releaseTimer: null, last: 0 };

  function stopEvent(e) {
    try { e.preventDefault(); } catch (x) { /* ignore */ }
    try { e.stopPropagation(); } catch (x) { /* ignore */ }
    try { if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); } } catch (x) { /* ignore */ }
  }

  function resetPress() {
    clearTimeout(press.longTimer);
    clearTimeout(press.releaseTimer);
    press.active = false;
    press.fired = false;
  }

  // true — это новое нажатие OK, false — автоповтор удерживаемой кнопки
  function enterDown(e) {
    var now = new Date().getTime();
    var continuation = false;
    if (press.active) {
      if (e.repeat === true) {
        continuation = true;
      } else if (!press.released) {
        // keyup ещё не было: автоповтор (движки без e.repeat) или потерянный keyup
        continuation = typeof e.repeat !== 'boolean' && (now - press.last) < 1000;
      }
    }
    press.last = now;
    if (continuation) {
      press.released = false;
      clearTimeout(press.releaseTimer);
      return false;
    }
    clearTimeout(press.longTimer);
    clearTimeout(press.releaseTimer);
    press.active = true;
    press.released = false;
    press.fired = false;
    press.longTimer = setTimeout(function () {
      if (!press.active) { return; }
      press.fired = true;
      if (!settingsOpen) { openSettings(); }
    }, LONG_PRESS_MS);
    return true;
  }

  // true — отпускание после долгого нажатия (событие нужно поглотить)
  function enterUp() {
    press.last = new Date().getTime();
    press.released = true;
    var wasLong = press.fired;
    clearTimeout(press.releaseTimer);
    press.releaseTimer = setTimeout(function () {
      clearTimeout(press.longTimer);
      press.active = false;
    }, 150);
    return wasLong;
  }

  // Сюда приходят только клавиши, пока фокус у приложения: экран загрузки,
  // окно доступа к настройкам или сами настройки. Остальное время клавиши получает сайт.
  function onKeyDown(e) {
    var code = e.keyCode;
    if (code !== KEY.ENTER && press.active) { resetPress(); }

    if (settingsOpen) {
      if (code === KEY.ENTER && !enterDown(e)) { stopEvent(e); return; }
      settingsKeyDown(e);
      return;
    }

    stopEvent(e);
    if (code === KEY.ENTER) { enterDown(e); return; }
    if ((code === KEY.BACK || code === KEY.ESC) && !(frame && frameLoaded)) {
      exitApp();
      return;
    }
    // Любая другая клавиша — сразу отдаём управление сайту
    if (frame && frameLoaded) { endHold(); focusSite(); }
  }

  function onKeyUp(e) {
    if (e.keyCode !== KEY.ENTER) { return; }
    stopEvent(e);
    var wasLong = enterUp();
    if (!wasLong && !settingsOpen && unreachableUrl) {
      openResolved(unreachableUrl);
      return;
    }
    // Короткое OK в окне настроек — отдаём управление сайту
    if (!wasLong && !settingsOpen && hold.active && frame && frameLoaded) {
      endHold();
      focusSite();
    }
  }

  function registerTvKeys() {
    var dev = window.tizen && window.tizen.tvinputdevice;
    if (!dev) { return; }
    var wanted = ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward',
      'MediaRewind', 'MediaTrackPrevious', 'MediaTrackNext', 'ColorF0Red', 'ColorF1Green',
      'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown'];
    var supported = null;
    try {
      var list = dev.getSupportedKeys();
      supported = {};
      for (var i = 0; i < list.length; i++) { supported[list[i].name] = true; }
    } catch (e) { supported = null; }
    for (var j = 0; j < wanted.length; j++) {
      if (supported && !supported[wanted[j]]) { continue; }
      try { dev.registerKey(wanted[j]); } catch (e) { /* ignore */ }
    }
  }

  function exitApp() {
    try { window.tizen.application.getCurrentApplication().exit(); return; } catch (e) { /* ignore */ }
    try { window.close(); } catch (e) { /* ignore */ }
  }

  /* ===================== Настройки ===================== */

  var settingsEl, items, focusIndex = 0, settingsOpen = false;
  var inputEl, switchEl, embedSwitchEl, statusEl, statusMsg = null;

  function initSettings() {
    settingsEl = document.getElementById('settings');
    inputEl = document.getElementById('url-input');
    switchEl = document.getElementById('auto-switch');
    embedSwitchEl = document.getElementById('embed-switch');
    statusEl = document.getElementById('status');
    items = settingsEl.querySelectorAll('.item');
    inputEl.addEventListener('blur', function () {
      if (settingsOpen) { setTimeout(function () { if (settingsOpen && document.activeElement !== inputEl) { settingsEl.focus(); } }, 0); }
    }, false);
    settingsEl.setAttribute('tabindex', '-1');
  }

  function openSettings() {
    if (settingsOpen) { return; }
    settingsOpen = true;
    endHold();
    clearTimeout(directTimer);
    statusMsg = null;
    inputEl.value = currentUrl || targetUrl();
    renderSettings();
    settingsEl.className = 'settings';
    focusIndex = 0;
    updateFocus();
    focusSettings();
  }

  function closeSettings() {
    if (!settingsOpen) { return; }
    settingsOpen = false;
    try { inputEl.blur(); } catch (e) { /* ignore */ }
    settingsEl.className = 'settings hidden';
    if (pendingOpenUrl) { openWhenOnline(pendingOpenUrl); return; }
    if (unreachableUrl) { openWhenOnline(currentUrl); return; }
    if (pendingDirectUrl) { directTimer = setTimeout(goDirect, 100); return; }
    focusSite();
  }

  function focusSettings() {
    try { window.focus(); } catch (e) { /* ignore */ }
    try { settingsEl.focus(); } catch (e) { /* ignore */ }
  }

  function updateFocus() {
    for (var i = 0; i < items.length; i++) {
      items[i].className = items[i].className.replace(/\s*focused/g, '') + (i === focusIndex ? ' focused' : '');
    }
  }

  function moveFocus(d) {
    focusIndex = Math.max(0, Math.min(items.length - 1, focusIndex + d));
    updateFocus();
  }

  function fmtTime(ts) {
    if (!ts) { return 'ещё не было'; }
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderSettings() {
    switchEl.className = state.autoUpdate ? 'switch on' : 'switch';
    embedSwitchEl.className = state.embed ? 'switch on' : 'switch';
    while (statusEl.firstChild) { statusEl.removeChild(statusEl.firstChild); }
    function line(text, cls) {
      var s = document.createElement('div');
      if (cls) { s.className = cls; }
      s.textContent = text;
      statusEl.appendChild(s);
    }
    if (statusMsg) { line(statusMsg.text, statusMsg.cls); }
    var shown = currentUrl || targetUrl();
    var hm = /^https:\/\/([^\/?#]+)/i.exec(shown);
    line('Адрес: ' + shown + ' (' + targetSource() + ')' +
      (hm && state.plainHttp[hm[1].toLowerCase()] ? ' — HTTPS на этом ТВ не работает, открывается по HTTP' : ''));
    if (state.remoteUrl) { line('Адрес в GitHub: ' + state.remoteUrl); }
    line('Проверка GitHub: ' + fmtTime(state.lastCheck) +
      (state.lastCheck ? (state.lastCheckOk ? ' — успешно' : ' — ошибка (' + state.lastError + ')') : ''));
  }

  function setStatus(text, cls) {
    statusMsg = text ? { text: text, cls: cls || '' } : null;
    if (settingsOpen) { renderSettings(); }
  }

  function editing() {
    return document.activeElement === inputEl;
  }

  function stopEditing() {
    try { inputEl.blur(); } catch (e) { /* ignore */ }
    focusSettings();
  }

  function settingsKeyDown(e) {
    var code = e.keyCode;

    if (editing()) {
      if (code === KEY.ENTER || code === KEY.IME_DONE) {
        stopEvent(e); stopEditing(); focusIndex = 2; updateFocus();
      } else if (code === KEY.IME_CANCEL || code === KEY.BACK || code === KEY.ESC) {
        stopEvent(e); stopEditing();
      } else if (code === KEY.UP || code === KEY.DOWN) {
        stopEvent(e); stopEditing(); moveFocus(code === KEY.UP ? -1 : 1);
      }
      return;
    }

    stopEvent(e);
    switch (code) {
      case KEY.UP: moveFocus(-1); break;
      case KEY.DOWN: moveFocus(1); break;
      case KEY.LEFT:
      case KEY.RIGHT:
        if (items[focusIndex].getAttribute('data-action') === 'toggle') {
          setAuto(code === KEY.RIGHT);
        } else if (items[focusIndex].getAttribute('data-action') === 'embed') {
          setEmbed(code === KEY.RIGHT);
        }
        break;
      case KEY.ENTER: activate(items[focusIndex].getAttribute('data-action')); break;
      case KEY.BACK:
      case KEY.ESC:
      case KEY.BACKSPACE:
        closeSettings();
        break;
    }
  }

  function activate(action) {
    switch (action) {
      case 'toggle': setAuto(!state.autoUpdate); break;
      case 'embed': setEmbed(!state.embed); break;
      case 'edit':
        try { inputEl.focus(); inputEl.select(); } catch (e) { /* ignore */ }
        break;
      case 'save': saveManual(); break;
      case 'check': forceCheck(); break;
      case 'github': backToGithub(); break;
      case 'close': closeSettings(); break;
    }
  }

  function setAuto(on) {
    if (on === state.autoUpdate) { return; }
    if (on) {
      state.autoUpdate = true;
      saveState();
      setStatus('Автообновление включено. Проверка GitHub…');
      checkRemote(function (err) {
        setStatus(err ? 'GitHub недоступен, используется сохранённая ссылка' : 'Ссылка получена из GitHub', err ? 'err' : 'ok');
        applyTarget(false);
        renderSettings();
      });
    } else {
      // Текущий адрес закрепляется как ручной, GitHub больше не меняет его
      state.manualUrl = state.manualUrl || currentUrl || targetUrl();
      state.autoUpdate = false;
      saveState();
      inputEl.value = state.manualUrl;
      setStatus('Автообновление выключено');
      applyTarget(false);
    }
  }

  function setEmbed(on) {
    if (on === state.embed) { return; }
    state.embed = on;
    saveState();
    renderSettings();
    setStatus(on ? 'Сайт откроется внутри приложения (iframe) после закрытия настроек'
      : 'Сайт откроется напрямую после закрытия настроек', 'ok');
    openUrl(currentUrl || targetUrl()); // отложится до закрытия настроек
  }

  function saveManual() {
    var u = normalizeUrl(inputEl.value);
    if (!u) { setStatus('Неверный адрес. Пример: https://example.com', 'err'); return; }
    state.manualUrl = u;
    state.autoUpdate = false;
    saveState();
    inputEl.value = u;
    setStatus('Ссылка сохранена', 'ok');
    applyTarget(false);
    closeSettings();
  }

  function forceCheck() {
    setStatus('Проверка GitHub…');
    checkRemote(function (err, url) {
      if (err) {
        setStatus('GitHub недоступен: ' + (err.message || err), 'err');
        return;
      }
      if (state.autoUpdate) {
        var changed = !sameUrl(url, currentUrl);
        setStatus(changed ? 'Новая ссылка из GitHub откроется после закрытия настроек' : 'Ссылка не изменилась', 'ok');
        if (changed) { applyTarget(false); renderSettings(); }
      } else {
        setStatus('В GitHub: ' + url + '. Включите автообновление или «Вернуться к ссылке GitHub»', 'ok');
      }
    });
  }

  function backToGithub() {
    state.autoUpdate = true;
    state.manualUrl = null;
    saveState();
    setStatus('Проверка GitHub…');
    checkRemote(function (err) {
      setStatus(err ? 'GitHub недоступен, открыта сохранённая ссылка GitHub' : 'Открыта ссылка из GitHub', err ? 'err' : 'ok');
      inputEl.value = targetUrl();
      applyTarget(false);
      closeSettings();
    });
  }

  /* ===================== Периодическая проверка ===================== */

  function periodicCheck() {
    if (waitingOnline && navigator.onLine !== false) { openUrl(currentUrl); }
    if (!state.autoUpdate) { return; }
    var now = new Date().getTime();
    var due = state.lastCheck + (state.lastCheckOk ? CHECK_INTERVAL_MS : RETRY_AFTER_FAIL_MS);
    if (now >= due || state.lastCheck > now) {
      checkRemote(function () { switchIfChanged(); });
    } else {
      switchIfChanged();
    }
  }

  // Открывает новый адрес из GitHub, если он изменился
  function switchIfChanged() {
    if (!state.autoUpdate || sameUrl(targetUrl(), currentUrl)) { return; }
    if (settingsOpen) { return; } // откроется после закрытия настроек
    applyTarget(false);
  }

  /* ===================== Запуск ===================== */

  function start() {
    loadingEl = document.getElementById('loading');
    loadingTextEl = document.getElementById('loading-text');
    hintEl = document.getElementById('hint');
    focusEl = document.getElementById('focus-target');
    initSettings();
    registerTvKeys();

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    // Фокус ушёл в сайт, пока он нужен приложению — сразу возвращаем
    window.addEventListener('blur', function () {
      setTimeout(function () {
        if (settingsOpen && document.activeElement !== inputEl) { focusSettings(); }
        else if (hold.active) { grabFocus(); }
      }, 0);
    }, false);
    var onVisibility = function () {
      var hidden = typeof document.hidden === 'boolean' ? document.hidden : document.webkitHidden;
      if (!hidden) {
        resetPress();
        if (frame && !settingsOpen) { holdFocus(SETTINGS_WINDOW_MS); }
        periodicCheck();
      }
    };
    document.addEventListener('visibilitychange', onVisibility, false);
    document.addEventListener('webkitvisibilitychange', onVisibility, false);
    window.addEventListener('online', function () {
      if (waitingOnline) { openUrl(currentUrl); }
      periodicCheck();
    }, false);

    // Пока открыты настройки, сайт не должен забирать фокус пульта
    setInterval(function () {
      if (settingsOpen && document.activeElement !== inputEl &&
          (document.activeElement === frame || !document.hasFocus())) { focusSettings(); }
    }, 200);
    setInterval(periodicCheck, 60000);
    holdFocus(SETTINGS_WINDOW_MS);

    if (!state.autoUpdate) {
      openWhenOnline(targetUrl());
      return;
    }

    var opened = false;
    var waitTimer = setTimeout(openNow, STARTUP_WAIT_MS);
    function openNow() {
      if (opened) { return; }
      opened = true;
      clearTimeout(waitTimer);
      openWhenOnline(targetUrl());
    }
    checkRemote(function () {
      if (!opened) { openNow(); } else { switchIfChanged(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, false);
  } else {
    start();
  }
})();
