/**
 * app.js —— 三个页面共用的小工具
 */
(function (global) {
  'use strict';

  const CFG = global.APP_CONFIG || {};
  const API = String(CFG.API_BASE || '').replace(/\/+$/, '');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, options) {
    const opt = options || {};
    const headers = { ...(opt.headers || {}) };
    if (opt.body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    if (opt.token) headers.authorization = 'Bearer ' + opt.token;

    let res;
    try {
      res = await fetch(API + path, {
        method: opt.method || 'GET',
        headers,
        body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error('网络请求失败，请检查 Worker 地址或跨域配置');
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      throw new Error('服务返回内容无法解析（HTTP ' + res.status + '）');
    }
    if (!res.ok || (data && data.ok === false)) {
      const msg = (data && (data.message || data.error)) || ('请求失败 HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const diff = Date.now() - t;
    const min = 60 * 1000;
    if (diff < min) return '刚刚';
    if (diff < 60 * min) return Math.floor(diff / min) + ' 分钟前';
    if (diff < 24 * 60 * min) return Math.floor(diff / (60 * min)) + ' 小时前';
    if (diff < 30 * 24 * 60 * min) return Math.floor(diff / (24 * 60 * min)) + ' 天前';
    return fmtDate(iso, false);
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return withTime === false ? date : date + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 填充顶部与页脚的公司名，避免每页写死 */
  function applyBranding() {
    document.querySelectorAll('[data-org]').forEach((n) => { n.textContent = CFG.ORG_NAME || '内部平台'; });
    document.querySelectorAll('[data-system]').forEach((n) => { n.textContent = CFG.SYSTEM_NAME || '内部信息发布平台'; });
    document.querySelectorAll('[data-footer]').forEach((n) => { n.textContent = CFG.FOOTER_TEXT || ''; });
  }

  global.App = { CFG, API, esc, api, timeAgo, fmtDate, applyBranding };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyBranding);
  } else {
    applyBranding();
  }
})(window);
