/**
 * guard.js —— 阅后即焚页面的防截屏 / 防录屏 / 防复制风控
 *
 * ⚠️ 先说清楚能力边界（很重要，不要对外承诺过头）：
 *   浏览器只能"感知"有限的几类行为，无法从系统层面禁止截图。
 *   - 能拦：页面内的右键/复制/打印、浏览器截图快捷键（PrintScreen、Cmd+Shift+3/4/5）、
 *          开发者工具、脚本调起的屏幕共享/录制（getDisplayMedia）、页面失焦（打开截图/录屏工具通常会失焦）。
 *   - 拦不住：Windows「Win+Shift+S」系统截图、第三方截图工具全局热键、
 *          直接抓桌面的录屏软件、手机拍屏、外接采集卡。
 *   所以这套机制的定位是：一次性销毁 + 抬高成本 + 触发即黑屏 + 留痕追责，
 *   而不是"绝对无法泄露"。真正的保密要靠 DLP、设备管控和保密协议。
 *
 * 用法：
 *   BurnGuard.start({ blackOnBlur, autoCloseSeconds, watermark, reportUrl, token, onBreach })
 */

(function (global) {
  'use strict';

  const state = {
    active: false,
    breached: false,
    reason: '',
    startAt: 0,
    opts: {},
    cleanup: [],
    timers: [],
    countdownTimer: null,
  };

  const LOCK_TEXT = {
    title: '页面已锁定',
    sub: '检测到可能造成内容外泄的操作，本次内容已销毁且无法恢复。如确需查阅，请向信息发布人重新申请。',
  };

  /* ---------------- 内部工具 ---------------- */

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    state.cleanup.push(() => target.removeEventListener(type, fn, opts));
  }

  function clearSensitive() {
    document.querySelectorAll('[data-sensitive]').forEach((node) => {
      try {
        node.textContent = '';
        node.removeAttribute('src');
        node.removeAttribute('href');
        node.innerHTML = '';
      } catch (_) {}
    });
  }

  function wipeClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText('该内容受保护，已禁止复制').catch(() => {});
      }
    } catch (_) {}
  }

  function report(reason) {
    const o = state.opts;
    if (!o.reportBreach || !o.reportUrl) return;
    try {
      fetch(o.reportUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason, token: o.token || '' }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  function blackout(reason) {
    if (!state.active || state.breached) return;
    state.breached = true;
    state.reason = reason || '未知原因';
    stopTimers();

    // 1. 清掉敏感内容（防止打印、截图时残留）
    clearSensitive();
    wipeClipboard();

    // 2. 停止正在进行的媒体流（如果是页面内发起的）
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        // 不做实际断开，只做提示；页面上的流由业务方自行处理
      }
    } catch (_) {}

    // 3. 全屏黑色遮罩
    const box = document.createElement('div');
    box.id = 'guard-blackout';
    box.innerHTML =
      '<div class="lock">🔒</div>' +
      '<div class="t">' + LOCK_TEXT.title + '</div>' +
      '<div class="s">' + LOCK_TEXT.sub + '</div>' +
      '<div class="s" style="opacity:.5">触发原因：' + escapeHtml(state.reason) + '</div>';
    document.body.appendChild(box);
    document.body.style.overflow = 'hidden';
    document.title = '页面已锁定';

    // 4. 移除水印，避免遮罩下仍有内容
    const wm = document.getElementById('guard-watermark');
    if (wm) wm.remove();

    report(state.reason);
    if (typeof state.opts.onBreach === 'function') {
      try {
        state.opts.onBreach(state.reason);
      } catch (_) {}
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function stopTimers() {
    state.timers.forEach((t) => clearInterval(t));
    state.timers = [];
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
  }

  /* ---------------- 水印 ---------------- */

  function buildWatermark(text) {
    if (!text) return;
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    const w = 320;
    const h = 160;
    const cv = document.createElement('canvas');
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-22 * Math.PI / 180);
    ctx.fillText(text, 0, 0);
    ctx.font = '400 11px -apple-system, "PingFang SC", sans-serif';
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    ctx.fillText(stamp, 0, 26);

    const layer = document.createElement('div');
    layer.id = 'guard-watermark';
    layer.style.backgroundImage = 'url(' + cv.toDataURL('image/png') + ')';
    (document.body || document.documentElement).appendChild(layer);
  }

  /* ---------------- 各类检测 ---------------- */

  function installKeyboardGuards() {
    on(document, 'keydown', (e) => {
      const key = String(e.key || '').toLowerCase();
      const meta = e.metaKey || e.ctrlKey;

      // 系统截图键：PrintScreen（Windows）/ macOS Cmd+Shift+3、4、5
      if (key === 'printscreen' || key === 'snapshot') {
        e.preventDefault();
        blackout('检测到截图按键（PrintScreen）');
        return;
      }
      if (e.metaKey && e.shiftKey && ['3', '4', '5', '6'].includes(key)) {
        blackout('检测到 macOS 截图组合键');
        return;
      }
      // Windows 截图工具 Win+Shift+S 无法被页面拦截，但能记录按键痕迹做威慑
      if (e.metaKey === false && e.ctrlKey === false && e.altKey === false && e.shiftKey && key === 's') {
        // 不直接黑屏，避免误伤正常的 Shift+S；仅上报
        report('可疑按键 Shift+S（可能为截图工具）');
      }

      // 开发者工具 / 打印 / 保存源码
      if (key === 'f12') {
        e.preventDefault();
        blackout('检测到开发者工具（F12）');
        return;
      }
      if (meta && e.shiftKey && ['i', 'j', 'c'].includes(key)) {
        e.preventDefault();
        blackout('检测到开发者工具');
        return;
      }
      if (meta && ['u', 's', 'p'].includes(key)) {
        e.preventDefault();
        report('拦截快捷键 Ctrl/Cmd+' + key.toUpperCase());
      }
    });
  }

  function installMouseGuards() {
    on(document, 'contextmenu', (e) => {
      e.preventDefault();
      report('右键菜单');
    });
    on(document, 'dragstart', (e) => e.preventDefault());
    on(document, 'selectstart', (e) => {
      // 允许点击按钮，但禁止框选文本
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      e.preventDefault();
    });
    on(document, 'copy', (e) => {
      e.preventDefault();
      try {
        e.clipboardData.setData('text/plain', '该内容受保护，禁止复制');
      } catch (_) {}
      report('复制操作');
    });
    on(document, 'cut', (e) => {
      e.preventDefault();
      report('剪切操作');
    });
  }

  function installFocusGuards(blackOnBlur) {
    if (!blackOnBlur) return;
    // 失焦 = 切窗（打开截图工具、录屏软件、远程控制台通常都会失焦）
    on(global, 'blur', () => {
      if (Date.now() - state.startAt < 800) return;
      blackout('页面失去焦点（疑似切换窗口/截图/录屏）');
    });
    on(document, 'visibilitychange', () => {
      if (document.hidden) blackout('页面被切换到后台');
    });
    on(global, 'pagehide', () => {
      if (!state.breached) report('页面关闭/离开');
    });
  }

  function installPrintGuards() {
    on(global, 'beforeprint', () => blackout('检测到打印操作'));
    try {
      const mq = global.matchMedia('print');
      if (mq && mq.addEventListener) {
        on(mq, 'change', (e) => {
          if (e.matches) blackout('检测到打印操作');
        });
      }
    } catch (_) {}
  }

  function installCaptureGuards() {
    // 1) 拦截页面脚本发起的屏幕共享 / 录屏
    try {
      const md = navigator.mediaDevices;
      if (md && md.getDisplayMedia) {
        const original = md.getDisplayMedia.bind(md);
        md.getDisplayMedia = function () {
          blackout('检测到屏幕共享/录屏请求');
          return Promise.reject(new DOMException('Not allowed', 'NotAllowedError'));
        };
        state.cleanup.push(() => {
          md.getDisplayMedia = original;
        });
      }
    } catch (_) {}

    // 2) 画中画 / 画面被外部接管
    on(document, 'enterpictureinpicture', () => blackout('检测到画中画'));
  }

  function installDevtoolsGuards() {
    if (!global.matchMedia || !global.matchMedia('(pointer:fine)').matches) return; // 移动端不检测

    // 窗口尺寸差（开发者工具停靠时最可靠的特征）
    const sizeTimer = setInterval(() => {
      const dw = Math.abs((global.outerWidth || 0) - (global.innerWidth || 0));
      const dh = Math.abs((global.outerHeight || 0) - (global.innerHeight || 0));
      if (dw > 220 || dh > 220) blackout('检测到开发者工具（窗口尺寸异常）');
    }, 900);
    state.timers.push(sizeTimer);

    // debugger 断点耗时检测
    const dtTimer = setInterval(() => {
      const t0 = performance.now();
      try {
        // eslint-disable-next-line no-debugger
        debugger;
      } catch (_) {}
      if (performance.now() - t0 > 120) blackout('检测到调试器暂停');
    }, 1500);
    state.timers.push(dtTimer);
  }

  function installIframeGuard() {
    try {
      if (global.top !== global.self) blackout('页面被嵌入到其它站点');
    } catch (_) {
      // 跨域访问 top 抛错，也说明被嵌入了
      blackout('页面被嵌入到其它站点');
    }
  }

  /* ---------------- 自动关闭 ---------------- */

  function startCountdown(seconds) {
    if (!seconds || seconds <= 0) return;
    let left = Math.floor(seconds);
    const el = document.getElementById('burn-countdown');
    const tick = () => {
      if (el) {
        const m = String(Math.floor(left / 60)).padStart(2, '0');
        const s = String(left % 60).padStart(2, '0');
        el.textContent = '本次内容将在 ' + m + ':' + s + ' 后自动销毁';
      }
      if (left <= 0) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
        clearSensitive();
        blackout('查看时长已结束');
        return;
      }
      left -= 1;
    };
    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  /* ---------------- 对外 API ---------------- */

  const BurnGuard = {
    start(opts) {
      if (state.active) return;
      state.opts = opts || {};
      state.active = true;
      state.startAt = Date.now();
      state.breached = false;

      buildWatermark(state.opts.watermark || '');
      installIframeGuard();
      installKeyboardGuards();
      installMouseGuards();
      installFocusGuards(state.opts.blackOnBlur !== false);
      installPrintGuards();
      installCaptureGuards();
      installDevtoolsGuards();
      startCountdown(state.opts.autoCloseSeconds);

      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';
    },

    /** 业务侧可主动触发（例如检测到异常请求） */
    breach(reason) {
      blackout(reason || '业务侧触发');
    },

    blackout,
    isBreached: () => state.breached,

    stop() {
      state.active = false;
      stopTimers();
      state.cleanup.forEach((fn) => {
        try {
          fn();
        } catch (_) {}
      });
      state.cleanup = [];
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    },
  };

  global.BurnGuard = BurnGuard;
})(window);
