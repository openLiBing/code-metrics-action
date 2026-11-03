/**
 * CI 平台上下文适配。
 * 进程启动时一次性判定平台，之后只读取该平台的变量，不跨平台混用：
 * - GitHub Actions：GITHUB_ACTIONS=true，读取 GITHUB_*
 * - GitCode Actions：无该标志，读取 ATOMGIT_*
 */
const IS_GITHUB = process.env.GITHUB_ACTIONS === 'true';

const ENV_KEYS = IS_GITHUB
  ? {
      eventName: 'GITHUB_EVENT_NAME',
      baseRef: 'GITHUB_BASE_REF',
      refName: 'GITHUB_REF_NAME',
      runId: 'GITHUB_RUN_ID',
      runNumber: 'GITHUB_RUN_NUMBER',
      sha: 'GITHUB_SHA',
      workflow: 'GITHUB_WORKFLOW',
      repository: 'GITHUB_REPOSITORY',
      serverUrl: 'GITHUB_SERVER_URL'
    }
  : {
      eventName: 'ATOMGIT_EVENT_NAME',
      baseRef: 'ATOMGIT_HEAD_REF',
      refName: 'ATOMGIT_REF_NAME',
      runId: 'ATOMGIT_RUN_ID',
      runNumber: 'ATOMGIT_RUN_NUMBER',
      sha: 'ATOMGIT_SHA',
      workflow: 'ATOMGIT_WORKFLOW'
    };

/** 读取当前平台的环境变量（未定义时返回空串） */
function ciEnv(key) {
  const envKey = ENV_KEYS[key];
  return envKey ? String(process.env[envKey] || '').trim() : '';
}

/** 当前运行所属分支：PR/MR 事件取目标分支，其余取当前 ref */
function resolveCiBranch() {
  const eventName = ciEnv('eventName').toLowerCase();
  if (eventName === 'pull_request' || eventName === 'pull_request_target' || eventName === 'mr') {
    return ciEnv('baseRef');
  }
  return ciEnv('refName');
}

/** 仓库地址兜底：仅 GitHub 提供仓库环境变量，GitCode 主要由 git 命令获取 */
function resolveRepoUrlFromEnv() {
  if (!IS_GITHUB) {
    return '';
  }
  const repository = ciEnv('repository');
  if (!repository) {
    return '';
  }
  return `${ciEnv('serverUrl') || 'https://github.com'}/${repository}`;
}

module.exports = { IS_GITHUB, ciEnv, resolveCiBranch, resolveRepoUrlFromEnv };
