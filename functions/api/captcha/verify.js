/* POST /api/captcha/verify —— 校验落点与轨迹，通过后签发一次性 ticket */
import { ensureCaptchaSchema, json, requireSameOrigin, verifyChallenge } from '../../../src/captcha.js';

export async function onRequestPost({ request, env }) {
  const guard = requireSameOrigin(request);
  if (guard) return guard;
  if (!env.DB) return json({ error: 'D1 绑定 "DB" 未配置' }, 500);
  await ensureCaptchaSchema(env);
  return verifyChallenge(request, env);
}