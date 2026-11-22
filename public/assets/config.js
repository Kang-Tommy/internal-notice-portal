/**
 * 前端唯一需要改的配置文件。
 * 部署 Worker 后，把 API_BASE 换成你的 Worker 地址（自定义域名或 xxx.workers.dev）。
 */
window.APP_CONFIG = {
  API_BASE: 'https://notice-api.example.com',

  // 顶部展示信息
  ORG_NAME: '示例科技有限公司',
  SYSTEM_NAME: '内部信息发布平台',
  FOOTER_TEXT: '本平台内容仅限内部查阅，禁止以任何形式外传、复制、截图或录屏。',

  // 阅后即焚页面的策略
  BURN: {
    // true = 页面失去焦点/切到后台立即黑屏（保密级别最高，但切窗即失效）
    blackOnBlur: true,
    // 打开后自动关闭的秒数，0 = 不自动关闭
    autoCloseSeconds: 300,
    // 动态水印内容（会重复平铺），留空则不显示
    watermark: '内部机密 · 禁止外传',
    // 异常行为上报到后端，便于留痕审计
    reportBreach: true,
  },
};
