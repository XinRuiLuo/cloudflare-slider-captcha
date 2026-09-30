/* ============================================================
 * 可调参数（config）
 * 这里是验证码唯一的参数来源，改这里即可调整难度/时长/配额。
 * 默认值即线上生产值，修改前请先读 README 的「配置」一节。
 * ============================================================ */

export const captchaConfig = {
  // 一道题的存活时间（秒）。超时后必须重新出题。
  ttlSeconds: 300,

  // 单道题允许答错的次数；用尽即作废，需刷新重来。
  maxAttempts: 3,

  // 落点与正确缺口中心的允许误差（px）。
  tolerance: 4,

  // 画布（背景）尺寸，SVG 逻辑单位。
  stageWidth: 320,
  stageHeight: 180,

  // 拼图块基准尺寸（px）。实际宽度取 size * 1.18，为右侧凸起留空间。
  pieceSize: 50,

  // 每道题画的缺口数量范围（大小各不相同，只有一块与拼图同尺寸）。
  minGaps: 2,
  maxGaps: 3,

  // 单 IP 每分钟出题上限（写进 D1 计数，跨 isolate 全局生效）。
  issueLimitPerMinute: 12,

  // 单块拼图的最少耗时（毫秒）。看题+判断+拖动不可能快于此值。
  minMsPerPiece: 520,

  // 通用请求限流（进程内，单 IP 每分钟）。
  requestLimitPerMinute: 60,

  // 是否校验请求同源（拒绝跨站 POST，防止他站盗用接口）。
  enforceSameOrigin: true
};