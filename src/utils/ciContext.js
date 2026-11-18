const fs = require('fs');
const core = require('@actions/core');

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
      // GitCode 的 ATOMGIT_HEAD_REF 是 PR 源分支，目标分支必须取 ATOMGIT_BASE_REF
      baseRef: 'ATOMGIT_BASE_REF',
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

/**
 * git 分支名兜底：游离 HEAD（字面量 HEAD）或空值时回落到平台上下文分支。
 * GitHub PR 事件 checkout refs/pull/<n>/merge 后 `git rev-parse --abbrev-ref HEAD` 返回字面量 HEAD，
 * 必须视为取不到分支，改用平台上下文（PR 事件即目标分支），避免上报 branch_name=HEAD。
 *
 * @param {string} gitBranch git 命令解析出的分支名（或 tag 名）
 * @param {string} ciBranch 平台上下文给出的分支名
 * @returns {string} 用于上报的分支名
 */
function resolveBranchName(gitBranch, ciBranch) {
  const branch = String(gitBranch || '').trim();
  if (!branch || branch === 'HEAD') {
    return ciBranch || '';
  }
  return branch;
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

/**
 * 平台自适应写 step output。
 * GitCode 不识别 GitHub 的 ::set-output 协议（core.setOutput 在 GitCode 下不生效），
 * 必须显式写 ATOMGIT_OUTPUT；GitHub 继续走 core.setOutput。
 *
 * @param {string} name 输出名
 * @param {string|number} value 输出值
 */
function setCiOutput(name, value) {
  if (IS_GITHUB) {
    core.setOutput(name, value);
    return;
  }
  const outputFile = process.env.ATOMGIT_OUTPUT;
  if (!outputFile) {
    core.warning(`ATOMGIT_OUTPUT 未设置，无法写入 step output: ${name}`);
    return;
  }
  try {
    fs.appendFileSync(outputFile, `${name}=${String(value)}\n`, 'utf8');
  } catch (e) {
    core.warning(`写入 step output 失败（${name}）: ${e.message}`);
  }
}

module.exports = { IS_GITHUB, ciEnv, resolveCiBranch, resolveBranchName, resolveRepoUrlFromEnv, setCiOutput };
