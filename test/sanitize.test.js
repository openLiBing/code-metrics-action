const { test, expect } = require('@jest/globals');

const { sanitize } = require('../src/utils/sanitize');

test('sanitize 折叠控制字符、压缩空白并截断超长输出，非字符串原样返回', () => {
  // 正常值清洗前后逐字节一致（恒等变换）
  expect(sanitize('refs/heads/master')).toBe('refs/heads/master');
  // 控制字符折叠为单空格，连续空格压缩
  expect(sanitize('line1\r\nline2\tline3')).toBe('line1 line2 line3');
  // 非字符串直接返回，不做类型转换
  expect(sanitize(0)).toBe(0);
  expect(sanitize(null)).toBeNull();
  // 超长输出截断并追加标记，防止刷屏
  const truncated = sanitize('x'.repeat(2100));
  expect(truncated.length).toBe(2048 + '...(truncated)'.length);
  expect(truncated.endsWith('...(truncated)')).toBe(true);
});
