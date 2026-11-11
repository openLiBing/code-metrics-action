/**
 * CI 平台上下文适配单测。
 * IS_GITHUB 与 ENV_KEYS 在模块加载期求值，每个用例需在独立环境变量下重新加载模块。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

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
  delete require.cache[MODULE_PATH];
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
    delete require.cache[MODULE_PATH];
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
      assert.equal(mod.IS_GITHUB, true);
      assert.equal(mod.ciEnv('eventName'), 'push');
      assert.equal(mod.ciEnv('refName'), 'main');
      assert.equal(mod.ciEnv('baseRef'), '');
      assert.equal(mod.ciEnv('unknown'), '');
      assert.equal(
        mod.resolveRepoUrlFromEnv(),
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
      assert.equal(mod.IS_GITHUB, false);
      assert.equal(mod.ciEnv('baseRef'), 'release_20261116_iter1');
      assert.equal(mod.ciEnv('runId'), '9');
      assert.equal(mod.resolveRepoUrlFromEnv(), '');
    }
  );
});

test('PR 事件取目标分支，push 取当前 ref', () => {
  withCiEnv(
    { ATOMGIT_EVENT_NAME: 'MR', ATOMGIT_BASE_REF: 'main', ATOMGIT_REF_NAME: 'feature' },
    (mod) => assert.equal(mod.resolveCiBranch(), 'main')
  );
  withCiEnv(
    { ATOMGIT_EVENT_NAME: 'Push', ATOMGIT_BASE_REF: '', ATOMGIT_REF_NAME: 'dev' },
    (mod) => assert.equal(mod.resolveCiBranch(), 'dev')
  );
  withCiEnv(
    {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_BASE_REF: 'release',
      GITHUB_REF_NAME: '123/merge'
    },
    (mod) => assert.equal(mod.resolveCiBranch(), 'release')
  );
});

test('resolveBranchName 将游离 HEAD 与空值回落平台分支', () => {
  withCiEnv({}, (mod) => {
    assert.equal(mod.resolveBranchName('HEAD', 'main'), 'main');
    assert.equal(mod.resolveBranchName('', 'dev'), 'dev');
    assert.equal(mod.resolveBranchName(null, ''), '');
    assert.equal(mod.resolveBranchName(' feature ', 'main'), 'feature');
  });
});
