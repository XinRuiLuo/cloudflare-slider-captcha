/* POST /api/demo/submit —— 演示用业务接口：消费 ticket
 * 真实项目里把这三行搬进你自己的注册 / 登录 / 评论等接口即可。 */
import { consumeTicket, ensureCaptchaSchema, json, requireSameOrigin } from '../../../src/captcha.js';

export async function onRequestPost({ request, env }) {
  const guard = requireSameOrigin(request);
  if (guard) return guard;
  if (!env.DB) return json({ error: 'D1 绑定 "DB" 未配置' }, 500);
  await ensureCaptchaSchema(env);

  const data = await request.json().catch(() => null);
  // 消费 ticket：一次性，用过即失效
  if (!(await consumeTicket(data?.captchaToken, request, env))) {
    return json({ error: '请先完成人机验证 / Please complete the CAPTCHA first' }, 400);
  }
  return json({ success: true, message: '验证通过，业务已受理 / Verified' });
}