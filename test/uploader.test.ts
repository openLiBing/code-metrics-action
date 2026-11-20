/**
 * 上报器纯逻辑单测（不发起网络请求）。
 */
// CJS 测试文件中 Jest 会自动注入全局 `jest`，从 @jest/globals 再解构同名 const
// 会触发 "Identifier 'jest' has already been declared"；tsconfig types 又未含
// jest 全局类型（TS2304），因此以别名 jestRef 解构使用（与全局 jest 为同一实现）。
const { test, expect, jest: jestRef } = require('@jest/globals');

// mock esdk-obs-nodejs：模块导出即 ObsClient 构造函数。
// 必须写在 require CoderepoUploader 之前：后者模块级 require esdk-obs-nodejs，
// mock 注册晚于模块加载则拿到真实 SDK。工厂只在那时执行，早于本文件任何
// const 声明（TDZ），因此工厂内不能引用外部变量；构造出的桩对象由测试内
// 通过 ObsClient.mockImplementation 注入。
jestRef.mock('esdk-obs-nodejs', () => jestRef.fn());

const CoderepoUploader = require('../src/uploaders/CoderepoUploader');
// require 得到的即 mock 工厂产物（唯一的 jestRef.fn 构造器实例）
const ObsClient = require('esdk-obs-nodejs');

// OBS 桩方法：由 upload 测试通过 ObsClient.mockImplementation 挂到 new 出的实例上
const mockPutObject = jestRef.fn().mockResolvedValue({ CommonMsg: { Status: 200 } });
const mockClose = jestRef.fn().mockResolvedValue();

test('extractOwnerRepo 支持 https 与 ssh 形式仓库地址', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  expect(uploader.extractOwnerRepo('https://gitcode.com/openlibing/code-metrics-action.git')).toBe('openlibing/code-metrics-action');
  expect(uploader.extractOwnerRepo('https://gitcode.com/openlibing/code-metrics-action/')).toBe('openlibing/code-metrics-action');
  expect(uploader.extractOwnerRepo('git@gitcode.com:openlibing/code-metrics-action.git')).toBe('openlibing/code-metrics-action');
  expect(uploader.extractOwnerRepo('')).toBe('');
  expect(uploader.extractOwnerRepo('not-a-repo')).toBe('');
});

test('buildObjectKey 按固定格式拼接 OBS 对象 key', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  const key = uploader.buildObjectKey({
    gitUrl: 'https://gitcode.com/openlibing/code-metrics-action.git',
    pipelineRunId: '123'
  });
  expect(key).toMatch(/^code-metrics-action\/openlibing\/code-metrics-action\/123\/\d{14}-metrics\.json$/);

  const manual = uploader.buildObjectKey({ gitUrl: '', pipelineRunId: '' });
  expect(manual).toMatch(/^code-metrics-action\/unknown\/manual\/\d{14}-metrics\.json$/);
});

test('formatDateTime 输出 UTC 的 yyyyMMddHHmmss', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  expect(uploader.formatDateTime(new Date('2026-11-10T01:02:03Z'))).toBe('20261110010203');
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
  expect(encoded.content).toBeUndefined();
  expect(encoded.contentB64).toBe(Buffer.from('hello', 'utf8').toString('base64'));
  expect(encoded.filePath).toBe('a.js');
});

test('encodeB64 幂等：已编码内容不会被二次编码', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  const b64 = Buffer.from('hello', 'utf8').toString('base64');
  expect(uploader.encodeB64('hello')).toBe(b64);
  expect(uploader.encodeB64(b64)).toBe(b64);
  expect(uploader.encodeB64('')).toBe('');
});

test('clipOversizeContent 超长内容按行省略并保留首尾', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com' });
  expect(uploader.clipOversizeContent('short', 100)).toBe('short');

  const content = Array.from({ length: 40 }, (_: any, i: any) => `line_${i + 1}_abcdefghij`).join('\n');
  const clipped = uploader.clipOversizeContent(content, 100);
  expect(clipped.length).toBeLessThanOrEqual(content.length);
  expect(clipped).toMatch(/lines omitted/);
  expect(clipped).toMatch(/line_1_/);
  expect(clipped).toMatch(/line_40_/);
});

test('buildUrl 按认证模式拼接新旧接口前缀', () => {
  const oidc = new CoderepoUploader({ coderepoUrl: 'https://api.example.com/', useOidc: true });
  expect(oidc.buildUrl('/metrics/code/report')).toBe('https://api.example.com/action-api/metrics/code/report');

  const aksk = new CoderepoUploader({ coderepoUrl: 'https://api.example.com', useOidc: false });
  expect(aksk.buildUrl('/metrics/code/report')).toBe('https://api.example.com/openlibing-coderepo/metrics/code/report');
});

test('obsBucket 支持显式配置覆盖平台默认桶', () => {
  const uploader = new CoderepoUploader({ coderepoUrl: 'https://api.example.com', obsBucket: 'custom-bucket' });
  expect(uploader.obsBucket).toBe('custom-bucket');
  expect(uploader.obsEndpoint).toBe('obs.cn-southwest-2.myhuaweicloud.com');
});

// ============ report / upload 集成路径（mock 网络与 OBS SDK，不发真实请求） ============

test('report AK/SK 模式完成 APIG 签名并在业务成功时返回 recordId', async () => {
  const axios = require('axios');
  const postSpy = jestRef.spyOn(axios, 'post').mockResolvedValue({
    data: { code: 200, msg: 'ok', data: { recordId: 42, detailLink: 'https://example.com/detail', tip: '' } }
  });
  try {
    const uploader = new CoderepoUploader({
      coderepoUrl: 'https://apig.example.com',
      useOidc: false,
      apigAppKey: 'test-ak',
      apigAppSecret: 'test-sk'
    });
    // URL 带 query 覆盖 canonical query 组装分支
    const result = await uploader.report(
      'https://apig.example.com/openlibing-coderepo/metrics/code/report?a=1&b=2',
      JSON.stringify({ x: 1 })
    );

    expect(result.success).toBe(true);
    expect(result.recordId).toBe(42);
    expect(result.detailLink).toBe('https://example.com/detail');

    // 校验签名请求头：APIG SDK-HMAC-SHA256 授权头 + 时间戳头
    expect(postSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, , config] = postSpy.mock.calls[0];
    expect(calledUrl).toContain('/metrics/code/report');
    expect(config.headers.Authorization).toMatch(/^SDK-HMAC-SHA256 Access=test-ak,/);
    expect(config.headers['X-Sdk-Date']).toBeTruthy();
  } finally {
    postSpy.mockRestore();
  }
});

test('upload AK/SK 模式走 OBS 中转并单次 report 元数据', async () => {
  const axios = require('axios');
  const postSpy = jestRef.spyOn(axios, 'post').mockResolvedValue({
    data: { code: 200, msg: 'ok', data: { recordId: 43 } }
  });
  // new ObsClient(...) 返回可控桩实例（工厂阶段无法引用外部变量，故在此注入）
  ObsClient.mockImplementation(() => ({ putObject: mockPutObject, close: mockClose }));
  try {
    const uploader = new CoderepoUploader({
      coderepoUrl: 'https://apig.example.com',
      useOidc: false,
      apigAppKey: 'test-ak',
      apigAppSecret: 'test-sk',
      obsAk: 'obs-ak',
      obsSk: 'obs-sk'
    });
    const result = await uploader.upload(
      { fileDetails: [{ filePath: 'a.js', loc: 10 }], totalLines: 10 },
      {
        gitUrl: 'https://gitcode.com/owner/repo.git',
        branchName: 'master',
        pipelineRunId: 'run-1',
        commitId: 'abc123',
        runNumber: '7',
        startTime: '2026-11-20 10:00:00',
        endTime: '2026-11-20 10:00:05',
        status: 0
      }
    );

    expect(result.success).toBe(true);
    expect(result.recordId).toBe(43);
    // obsUrl 为固定格式下载链接（桶名.域名/对象 key）
    expect(result.obsUrl).toMatch(/^https:\/\/openlibing-gitcode-action\.obs\.cn-southwest-2\.myhuaweicloud\.com\/code-metrics-action\/owner\/repo\/run-1\//);
    // OBS 上传参数：平台默认桶 + 按 objectKey 规则生成 key
    expect(mockPutObject).toHaveBeenCalledTimes(1);
    expect(mockPutObject.mock.calls[0][0].Bucket).toBe('openlibing-gitcode-action');
    expect(mockPutObject.mock.calls[0][0].Key).toContain('code-metrics-action/owner/repo/run-1/');
    expect(mockClose).toHaveBeenCalled();
    // report 只上报元数据 + obsUrl（单次调用）
    expect(postSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(postSpy.mock.calls[0][1]);
    expect(body.obsUrl).toBe(result.obsUrl);
    expect(body.pipelineRunId).toBe('run-1');
  } finally {
    postSpy.mockRestore();
    ObsClient.mockReset();
    mockPutObject.mockClear();
    mockClose.mockClear();
  }
});

export {};
