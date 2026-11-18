/**
 * CI 平台上下文适配单测。
 * IS_GITHUB 与 ENV_KEYS 在模块加载期求值，每个用例需在独立环境变量下重新加载模块。
 */
// Jest 运行时已注入全局 jest，解构同名变量会重复声明，故起别名
const { test, expect, jest: jestGlobals } = require('@jest/globals');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = require.resolve('../src/utils/ciContext');

/**
 * 在指定 CI 环境变量下加载 ciContext 模块并执行断言，结束后恢复宿主环境。
 *
 * @param {Object} env 本次用例注入的 CI 环境变量
 * @param {Function} fn 断言回调，入参为刚加载的模块
 */
function withCiEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GITHUB_') || key.startsWith('ATOMGIT_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  // Jest 使用自有的模块注册表，重置后才能让模块在最新环境变量下重新求值
  jestGlobals.resetModules();
  const mod = require(MODULE_PATH);
  try {
    fn(mod);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GITHUB_') || key.startsWith('ATOMGIT_')) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
    jestGlobals.resetModules();
  }
}

test('GitHub 平台读取 GITHUB_* 上下文并拼接仓库地址', () => {
  withCiEnv(
    {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_NAME: 'main',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_NUMBER: '2',
      GITHUB_SHA: 'abc',
      GITHUB_WORKFLOW: 'wf',
      GITHUB_REPOSITORY: 'openlibing/code-metrics-action',
      GITHUB_SERVER_URL: 'https://github.com'
    },
    (mod) => {
      expect(mod.IS_GITHUB).toBe(true);
      expect(mod.ciEnv('eventName')).toBe('push');
      expect(mod.ciEnv('refName')).toBe('main');
      expect(mod.ciEnv('baseRef')).toBe('');
      expect(mod.ciEnv('unknown')).toBe('');
      expect(mod.resolveRepoUrlFromEnv()).toBe(
        'https://github.com/openlibing/code-metrics-action'
      );
    }
  );
});

test('GitCode 平台读取 ATOMGIT_* 上下文且无仓库地址兜底', () => {
  withCiEnv(
    {
      ATOMGIT_EVENT_NAME: 'MR',
      ATOMGIT_BASE_REF: 'release_20261116_iter1',
      ATOMGIT_REF_NAME: 'feature',
      ATOMGIT_RUN_ID: '9'
    },
    (mod) => {
      expect(mod.IS_GITHUB).toBe(false);
      expect(mod.ciEnv('baseRef')).toBe('release_20261116_iter1');
      expect(mod.ciEnv('runId')).toBe('9');
      expect(mod.resolveRepoUrlFromEnv()).toBe('');
    }
  );
});

test('PR 事件取目标分支，push 取当前 ref', () => {
  withCiEnv(
    { ATOMGIT_EVENT_NAME: 'MR', ATOMGIT_BASE_REF: 'main', ATOMGIT_REF_NAME: 'feature' },
    (mod) => expect(mod.resolveCiBranch()).toBe('main')
  );
  withCiEnv(
    { ATOMGIT_EVENT_NAME: 'Push', ATOMGIT_BASE_REF: '', ATOMGIT_REF_NAME: 'dev' },
    (mod) => expect(mod.resolveCiBranch()).toBe('dev')
  );
  withCiEnv(
    {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_BASE_REF: 'release',
      GITHUB_REF_NAME: '123/merge'
    },
    (mod) => expect(mod.resolveCiBranch()).toBe('release')
  );
});

test('resolveBranchName 将游离 HEAD 与空值回落平台分支', () => {
  withCiEnv({}, (mod) => {
    expect(mod.resolveBranchName('HEAD', 'main')).toBe('main');
    expect(mod.resolveBranchName('', 'dev')).toBe('dev');
    expect(mod.resolveBranchName(null, '')).toBe('');
    expect(mod.resolveBranchName(' feature ', 'main')).toBe('feature');
  });
});

test('GitCode 平台不写英文 step output（避免与中文概览重复）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-output-'));
  const outputFile = path.join(dir, 'atomegit_output');
  fs.writeFileSync(outputFile, '');
  try {
    withCiEnv({ ATOMGIT_OUTPUT: outputFile }, (mod) => {
      expect(mod.IS_GITHUB).toBe(false);
      mod.setCiOutput('avg-function-loc', null);
      expect(fs.readFileSync(outputFile, 'utf8')).toBe('');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub 平台把 null 输出归一为空字符串', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-output-'));
  const outputFile = path.join(dir, 'github_output');
  fs.writeFileSync(outputFile, '');
  try {
    withCiEnv({ GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputFile }, (mod) => {
      mod.setCiOutput('avg-function-loc', null);
      const content = fs.readFileSync(outputFile, 'utf8');
      expect(content).toMatch(/^avg-function-loc<</m);
      expect(content).not.toMatch(/null/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub 平台仍通过 GITHUB_OUTPUT 写 step output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-output-'));
  const outputFile = path.join(dir, 'github_output');
  fs.writeFileSync(outputFile, '');
  try {
    withCiEnv({ GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputFile }, (mod) => {
      expect(mod.IS_GITHUB).toBe(true);
      mod.setCiOutput('code-scale', 116109);
      // @actions/core 使用 heredoc 格式写入（name<<delimiter），只断言名称与值存在
      const content = fs.readFileSync(outputFile, 'utf8');
      expect(content).toMatch(/^code-scale<</m);
      expect(content).toMatch(/^116109$/m);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
