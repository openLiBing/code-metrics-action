const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitize } = require("../src/utils/sanitize");

test("sanitize 折叠控制字符、压缩空白并截断超长输出，非字符串原样返回", () => {
  // 正常值清洗前后逐字节一致（恒等变换）
  assert.equal(sanitize("refs/heads/master"), "refs/heads/master");
  // 控制字符折叠为单空格，连续空格压缩
  assert.equal(sanitize("line1\r\nline2\tline3"), "line1 line2 line3");
  // 非字符串直接返回，不做类型转换
  assert.equal(sanitize(0), 0);
  assert.equal(sanitize(null), null);
  // 超长输出截断并追加标记，防止刷屏
  const truncated = sanitize("x".repeat(2100));
  assert.equal(truncated.length, 2048 + "...(truncated)".length);
  assert.ok(truncated.endsWith("...(truncated)"));
});
