/**
 * 日志/输出行注入清洗（Ref #64）。
 *
 * 外部可控字符串（环境变量注入的 branchName、git remote 返回的 gitUrl、
 * 服务端响应字段 detailLink/tip/msg/adviceMsg）拼进日志或 ATOMGIT_OUTPUT
 * 输出行前必须过本函数：去掉换行与控制字符（防止 CRLF 伪造日志行/平台输出行），
 * 折叠为单行并做长度截断（防刷屏）。
 *
 * 清洗仅作用于人类可读的日志/输出文本，不改上报 payload JSON 契约。
 * 正常值（无控制字符）清洗前后逐字节一致，属恒等变换。
 * 与 security-compilation-options-action #37 已验证实现同款。
 */

/** 日志/输出行最大长度（字符） */
const MAX_LOG_LINE_LEN = 2048;

function sanitize(value, maxLen = MAX_LOG_LINE_LEN) {
  if (typeof value !== 'string') {
    return value;
  }
  // 控制字符（含 \r \n \t）折叠为单空格，压缩连续空格
  // 匹配控制字符正是本函数的功能本体，豁免 no-control-regex（与 sec-comp #37 同款实现）
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (cleaned.length > maxLen) {
    return cleaned.slice(0, maxLen) + '...(truncated)';
  }
  return cleaned;
}

module.exports = { sanitize };
