// 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// CSP nonce 生成，保持 32 字符字母数字形态。
// nonce 必须不可预测：一旦可被猜测，注入脚本就能绕过 CSP 的 script-src 白名单，
// 所以熵源用操作系统的 CSPRNG（crypto.randomBytes）而非 Math.random。
import { randomBytes } from 'node:crypto';

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Generate a 32-character nonce suitable for a CSP `script-src` allowance. */
export function createNonce(): string {
  const bytes = randomBytes(32);
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += NONCE_CHARS[bytes[i] % NONCE_CHARS.length];
  }
  return text;
}
