/* GET /api/captcha/new —— 出题 */
import { ensureCaptchaSchema, issueChallenge, json, requireSameOrigin } from '../../../src/captcha.js';

export async function onRequestGet({ request, env }) {
  const guard = requireSameOrigin(request);
  if (guard) return guard;
  if (!env.DB) return json({ error: 'D1 绑定 "DB" 未配置' }, 500);
  await ensureCaptchaSchema(env);
  return issueChallenge(request, env);
}