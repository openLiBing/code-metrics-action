/**
 * 上报器纯逻辑单测（不发起网络请求）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const CoderepoUploader = require('../src/uploaders/CoderepoUploader');

test('extractOwnerRepo 支持 https 与 ssh 形式仓库地址', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  assert.equal(uploader.extractOwnerRepo('https://gitcode.com/openlibing/code-metrics-action.git'), 'openlibing/code-metrics-action');
  assert.equal(uploader.extractOwnerRepo('https://gitcode.com/openlibing/code-metrics-action/'), 'openlibing/code-metrics-action');
  assert.equal(uploader.extractOwnerRepo('git@gitcode.com:openlibing/code-metrics-action.git'), 'openlibing/code-metrics-action');
  assert.equal(uploader.extractOwnerRepo(''), '');
  assert.equal(uploader.extractOwnerRepo('not-a-repo'), '');
});

test('buildObjectKey 按固定格式拼接 OBS 对象 key', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  const key = uploader.buildObjectKey({
    gitUrl: 'https://gitcode.com/openlibing/code-metrics-action.git',
    pipelineRunId: '123'
  });
  assert.match(key, /^code-metrics-action\/openlibing\/code-metrics-action\/123\/\d{14}-metrics\.json$/);

  const manual = uploader.buildObjectKey({ gitUrl: '', pipelineRunId: '' });
  assert.match(manual, /^code-metrics-action\/unknown\/manual\/\d{14}-metrics\.json$/);
});

test('formatDateTime 输出 UTC 的 yyyyMMddHHmmss', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  assert.equal(uploader.formatDateTime(new Date('2026-11-10T01:02:03Z')), '20261110010203');
});

test('encodeOccurrences 将明文 content 编码为 contentB64', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  const [encoded] = uploader.encodeOccurrences([
    {
      groupId: 'g',
      contentHash: 'g',
      occurrenceIndex: 0,
      filePath: 'a.js',
      startLine: 1,
      endLine: 2,
      content: 'hello'
    }
  ]);
  assert.equal(encoded.content, undefined);
  assert.equal(encoded.contentB64, Buffer.from('hello', 'utf8').toString('base64'));
  assert.equal(encoded.filePath, 'a.js');
});

test('encodeB64 幂等：已编码内容不会被二次编码', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  const b64 = Buffer.from('hello', 'utf8').toString('base64');
  assert.equal(uploader.encodeB64('hello'), b64);
  assert.equal(uploader.encodeB64(b64), b64);
  assert.equal(uploader.encodeB64(''), '');
});

test('clipOversizeContent 超长内容按行省略并保留首尾', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  assert.equal(uploader.clipOversizeContent('short', 100), 'short');

  const content = Array.from({ length: 40 }, (_, i) => `line_${i + 1}_abcdefghij`).join('\n');
  const clipped = uploader.clipOversizeContent(content, 100);
  assert.ok(clipped.length <= content.length);
  assert.match(clipped, /lines omitted/);
  assert.match(clipped, /line_1_/);
  assert.match(clipped, /line_40_/);
});

test('buildUrl 按认证模式拼接新旧接口前缀', () => {
  const oidc = new CoderepoUploader({ coderepoUrl: 'https://api.example.com/', useOidc: true });
  assert.equal(oidc.buildUrl('/metrics/code/report'), 'https://api.example.com/action-api/metrics/code/report');

  const aksk = new CoderepoUploader({ coderepoUrl: 'https://api.example.com', useOidc: false });
  assert.equal(aksk.buildUrl('/metrics/code/report'), 'https://api.example.com/openlibing-coderepo/metrics/code/report');
});

test('obsBucket 支持显式配置覆盖平台默认桶', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com', obsBucket: 'custom-bucket' });
  assert.equal(uploader.obsBucket, 'custom-bucket');
  assert.equal(uploader.obsEndpoint, 'obs.cn-southwest-2.myhuaweicloud.com');
});
