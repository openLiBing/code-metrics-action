const core = require('@actions/core');
const { MetricsScanner, ConfigLoader } = require('./scanner');
const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');
const { execSync } = require('child_process');

// 兼容下划线格式的环境变量名（CI 平台 env 块通常不支持连字符变量名）
// 优先读取 INPUT_<NAME> (连字符)，回退到 INPUT_<NAME> (下划线)
function getInput(name) {
  const hyphenKey = `INPUT_${name.toUpperCase().replace(/-/g, '-')}`;
  const underscoreKey = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  return process.env[hyphenKey] || process.env[underscoreKey] || core.getInput(name) || '';
}

async function cloneRepository(repository, ref, token, targetDir) {
  core.info(`准备克隆仓库: ${repository}`);
  core.info(`分支/标签: ${ref}`);
  core.info(`目标目录: ${targetDir}`);

  if (fs.existsSync(targetDir)) {
    core.info(`目标目录已存在，清理中...`);
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  const git = simpleGit();

  // 使用 x-access-token 作为用户名占位符，token 作为密码
  // 格式: https://x-access-token:<token>@<host>/<owner>/<repo>.git
  const authUrl = repository.replace('https://', `https://x-access-token:${token}@`);

  core.info('开始克隆仓库...');
  await git.clone(authUrl, targetDir, ['--depth', '1', '--branch', ref]);

  core.info(`仓库克隆成功: ${targetDir}`);
  return targetDir;
}

async function run() {
  try {
    // source-dir 改为可选，默认扫描当前目录（线上环境由 checkout 步骤决定扫描内容）
    let sourceDir = getInput('source-dir') || './';
    const configFile = getInput('config-file');
    const excludeDirs = getInput('exclude-dirs')
      ? getInput('exclude-dirs').split(',').map(s => s.trim())
      : [];
    const allowedExtensions = getInput('allowed-extensions')
      ? getInput('allowed-extensions').split(',').map(s => s.trim())
      : [];
    // jscpd 检测阈值：与华为云 cmetrics 官方定义对齐
    // 官方定义："连续超过 10 行代码块在其他地方重复记为一次重复"
    // - minLines=10：连续代码块至少 10 行才算一次重复
    // - minTokens=85：滑动窗口大小
    const minLines = parseInt(getInput('min-lines') || '10', 10);
    const minTokens = parseInt(getInput('min-tokens') || '85', 10);
    const shouldUpload = getInput('upload') === 'true';
    const outputFile = getInput('output') || 'metrics.json';

    // === 扫描目标仓库参数（用于克隆要扫描的代码） ===
    // scan-repository / scan-ref / scan-token 是新参数，明确指定要扫描的目标仓库
    // ref / token 是旧参数，为向后兼容保留
    // 注意：scan-repository 是克隆 URL，与下面的 repository（owner/repo）语义不同，不能混用
    // 只用 scan-repository，不用 repository 作为 fallback（repository 是 owner/repo 不是克隆 URL）
    const scanRepository = getInput('scan-repository') || '';
    const scanRef = getInput('scan-ref') || getInput('ref') || '';
    const scanToken = getInput('scan-token') || getInput('token') || '';

    // atomgit 上下文：当前工作流所属仓的 owner/repo 和分支/标签名
    // GitCode runner 自动注入 ATOMGIT_REPOSITORY / ATOMGIT_REF_NAME / ATOMGIT_TOKEN 等环境变量，
    // 同时兼容 workflow 手动注入的 ATOMGIT_REPO（短名）以支持旧配置
    const atomgitRepo = process.env['ATOMGIT_REPOSITORY'] || '';
    const atomgitRefName = process.env['ATOMGIT_REF_NAME'] || '';

    // 流水线自身所属仓的 owner/repo（用于上报，不是克隆 URL）
    // 优先用 action 输入的 repository（由 workflow 传入 atomgit.repository），
    // 不传则后续 repositoryPath 逻辑会降级用 atomgit 上下文环境变量
    const repository = getInput('repository') || '';

    // 克隆参数：只用显式传入的 scan-repository / scan-ref / scan-token
    // 删除原 atomgit 上下文 fallback：ATOMGIT_REPO 是流水线所属仓（owner/repo），不是要扫描的目标仓，
    // 用它拼克隆 URL 会用错误的 token 去克隆错误的仓库，导致认证失败。
    // 如果 source-dir 不存在且未传 scan-repository，直接报错让用户检查 build/checkout 步骤
    const cloneRepositoryUrl = scanRepository;
    const cloneRef = scanRef;
    const cloneToken = scanToken;

    // 仅当源目录不存在且显式传入了完整的 scan-repository 信息时才执行克隆
    const needsClone = !fs.existsSync(sourceDir) && cloneRepositoryUrl && cloneRef && cloneToken;
    if (needsClone) {
      try {
        sourceDir = await cloneRepository(cloneRepositoryUrl, cloneRef, cloneToken, sourceDir);
      } catch (cloneError) {
        core.error(`克隆仓库失败: ${cloneError.message}`);
        throw new Error(`无法克隆仓库: ${cloneError.message}`);
      }
    } else if (!fs.existsSync(sourceDir)) {
      // source-dir 不存在且未传 scan-repository：说明 checkout 步骤未生成目标目录
      throw new Error(`源代码目录不存在: ${sourceDir}。请检查 workflow 的 checkout 步骤是否正确，或通过 scan-repository 参数指定要克隆的目标仓库。`);
    } else {
      core.info(`源代码目录已存在，跳过克隆: ${sourceDir}`);
    }

    // 从环境变量获取 coderepo 信息（变量名带 CODEMETRICS_ 前缀，避免与其他插件的 APIG 凭证混淆）
    const coderepoUrl = 'https://apig.openlibing.com:443';
    const apigAppKey = process.env['CODEMETRICS_APIG_APP_KEY'] || '';
    const apigAppSecret = process.env['CODEMETRICS_APIG_APP_SECRET'] || '';

    // 上报用 git_url 和 branch_name：
    // gitUrl 解析优先级：
    //   1) scan-repository 入参（用户显式指定的"被扫描目标仓"克隆 URL，最权威）
    //   2) 从 sourceDir 沿目录树向上找 .git（修复：sourceDir 是构建产物子目录如 source-code/target 时，
    //      .git 在 source-code/ 而非 sourceDir 内，旧逻辑只看 sourceDir/.git 会误用工作区根目录的 git）
    //   3) process.cwd() 兜底（仅在 1/2 都不可用时使用，并打 warning 让用户感知可能用错仓库）
    // branchName 仍走原逻辑：scan-repository 没有 ref 信息时，保持原 fallback 行为（不强制用 scanRef 覆盖）
    // 沿目录树向上查找包含 .git 的目录。.git 既可能是目录（普通仓库），
    // 也可能是文件（worktree/submodule 指向真正的 git dir），fs.existsSync 对二者均返回 true。
    // 设置向上查找最大深度为 8 层，避免异常文件系统结构下死循环或越界。
    function findGitRoot(startDir) {
      let cur = path.resolve(startDir);
      const root = path.parse(cur).root; // Windows: "D:\", Linux: "/"
      for (let i = 0; i < 8 && cur && cur !== root; i++) {
        const gitPath = path.join(cur, '.git');
        if (fs.existsSync(gitPath)) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) break; // 已到文件系统根
        cur = parent;
      }
      return ''; // 找不到，返回空字符串让上层 fallback
    }
    let gitUrl = '';
    let branchName = '';
    if (scanRepository) {
      // 优先用用户传入的 scan-repository：清洗掉 URL 中可能内嵌的 token
      gitUrl = scanRepository.replace(/https:\/\/[^@]+@/, 'https://');
    } else {
      const gitRoot = findGitRoot(sourceDir);
      const gitCwd = gitRoot || process.cwd();
      if (!gitRoot) {
        core.warning(`未在 sourceDir(${sourceDir}) 的上级目录找到 .git，将使用工作区根目录的 git remote，可能与被扫描仓库不一致`);
      }
      try {
        const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8', cwd: gitCwd }).trim();
        // 清洗掉 url 中可能存在的 token（https://x-access-token:xxx@host/...）
        gitUrl = remoteUrl.replace(/https:\/\/[^@]+@/, 'https://');
        branchName = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd: gitCwd }).trim();
        // detached HEAD（如 checkout 了 tag）时尝试获取 tag 名
        if (branchName === 'HEAD') {
          try {
            branchName = execSync('git describe --tags --exact-match', { encoding: 'utf8', cwd: gitCwd }).trim();
          } catch (e) {
            core.warning('当前为 detached HEAD 且无法获取 tag 名');
          }
        }
      } catch (e) {
        core.warning(`从 git 命令获取仓库信息失败: ${e.message}`);
      }
    }
    // gitUrl fallback：删除原 `https://gitcode.com/${atomgitRepo}.git` 兜底，
    // 原因：(1) 硬编码 gitcode.com 在测试环境 test.gitcode.net 下会拼错 URL；
    // (2) ATOMGIT_REPO 是流水线仓的 owner/repo，不是源代码仓的 owner/repo，
    // 用它拼出的 URL 也不是源代码仓的真实地址。git remote 失败时让 gitUrl 保持为空，
    // 不上报可能错误的 fallback URL。
    if (!branchName) {
      branchName = atomgitRefName || '';
    }

    // repositoryPath 必须是流水线所属仓库（owner/repo），不是被 checkout 的仓库
    // 优先使用 action 输入的 repository（由 workflow 传入 atomgit.repository），
    // 其次使用 ATOMGIT_REPOSITORY 环境变量，过滤掉 placeholder_repo 等无效值，
    // 最后从工作区根目录的 git remote URL 反推 owner/repo
    let repositoryPath = '';
    const isRepoValid = (repo) => repo && repo.includes('/') && repo !== 'placeholder_repo';
    if (isRepoValid(repository)) {
      repositoryPath = repository;
    } else if (isRepoValid(atomgitRepo)) {
      repositoryPath = atomgitRepo;
    } else {
      // ATOMGIT_REPOSITORY / ATOMGIT_REPO 环境变量无效时，
      // 从工作区根目录的 git remote URL 提取 owner/repo（工作区根目录 = 流水线自身所属仓）
      try {
        const rootGitUrl = execSync('git remote get-url origin', { encoding: 'utf8', cwd: process.cwd() }).trim();
        // 清洗 URL 中的 token，然后从 https://host/owner/repo.git 提取 owner/repo
        const cleanUrl = rootGitUrl.replace(/https:\/\/[^@]+@/, 'https://');
        const match = cleanUrl.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
        if (match && isRepoValid(match[1])) {
          repositoryPath = match[1];
          core.info(`从 git remote URL 反推 repository: ${repositoryPath}`);
        } else {
          core.warning(`无法从 git remote URL 提取 repository: ${rootGitUrl}`);
        }
      } catch (e) {
        core.warning(`无法确定流水线所属仓库: repository 输入、ATOMGIT_REPO 环境变量和 git remote 均无效 (${e.message})`);
      }
    }
    // pipelineRunId / runNumber：优先用 GitCode runner 自动注入的 ATOMGIT_RUN_ID / ATOMGIT_RUN_NUMBER，
    // 兼容 workflow 手动注入的 PIPELINE_RUN_ID / PIPELINE_RUN_NUMBER（旧配置）
    const pipelineRunId = process.env['ATOMGIT_RUN_ID'] || process.env['PIPELINE_RUN_ID'] || '';
    // runNumber 从环境变量获取，仅作记录
    const runNumber = process.env['ATOMGIT_RUN_NUMBER'] || process.env['PIPELINE_RUN_NUMBER'] || '';

    // 加载配置
    let config;
    if (configFile) {
      config = ConfigLoader.load(path.resolve(configFile));
    } else {
      config = ConfigLoader.load(null);
    }

    // 用 action 输入覆盖配置
    config.sourceDir = path.resolve(sourceDir);
    // excludeDirs: 如果用户显式传入了值，则覆盖默认值
    // 空数组表示不排除任何目录
    if (getInput('exclude-dirs') !== '') {
      config.excludeDirs = excludeDirs;
    }
    // allowedExtensions: 如果用户显式传入了值（包括空字符串），则覆盖默认值
    // 空数组表示不限制扩展名（检查所有文件）
    if (getInput('allowed-extensions') !== '') {
      config.allowedExtensions = allowedExtensions;
    }
    config.detectors.jscpd.minLines = minLines;
    config.detectors.jscpd.minTokens = minTokens;
    config.output = outputFile;

    // 上传配置
    if (shouldUpload && coderepoUrl) {
      config.uploader = {
        enabled: true,
        coderepoUrl: coderepoUrl,
        timeout: 60000,
        apigAppKey: apigAppKey,
        apigAppSecret: apigAppSecret
      };
    }

    // 自动安装 Python 依赖（用户无需在 workflow 中手动配置 install_dependency 步骤）
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const pipInstallArgs = [
      '-m', 'pip', 'install', '--break-system-packages', 'lizard', 'radon',
      '-i', 'https://mirrors.aliyun.com/pypi/simple/',
      '--trusted-host', 'mirrors.aliyun.com'
    ];
    try {
      core.info('Installing Python dependencies (lizard, radon)...');
      execSync([pythonCmd, ...pipInstallArgs].join(' '), { stdio: 'inherit', timeout: 120000 });
      core.info('Python dependencies installed successfully');
    } catch (e) {
      core.warning(`Python dependency installation failed: ${e.message}. The scan may fail if dependencies are missing.`);
    }

    core.info('Starting code metrics scan...');
    core.info(`Source directory: ${config.sourceDir}`);
    // 输出上报关键字段，便于排查 atomgit 上下文异常（如 placeholder_repo 占位符）
    core.info(`gitUrl: ${gitUrl || '(empty)'}`);
    core.info(`branchName: ${branchName || '(empty)'}`);
    core.info(`repository: ${repositoryPath || '(empty)'}`);
    core.info(`pipelineRunId: ${pipelineRunId || '(empty)'}`);

    const scanner = new MetricsScanner(config);
    const result = await scanner.scan({
      sourceDir: config.sourceDir,
      output: config.output,
      upload: shouldUpload,
      gitUrl: gitUrl,
      branchName: branchName,
      repository: repositoryPath,
      pipelineRunId: pipelineRunId,
      runNumber: runNumber
    });

    // 设置输出
    core.setOutput('code-scale', result.codeScale);
    core.setOutput('avg-function-loc', result.avgFunctionLoc);
    core.setOutput('avg-cyclomatic-complexity', result.avgCyclomaticComplexity);
    core.setOutput('total-code-duplication-rate', result.totalCodeDuplicationRate);
    core.setOutput('total-file-duplication-rate', result.totalFileDuplicationRate);

    core.info('Code metrics scan completed successfully');
    core.info(`Code scale: ${result.codeScale}`);
    core.info(`Avg function LOC: ${result.avgFunctionLoc}`);
    core.info(`Avg cyclomatic complexity: ${result.avgCyclomaticComplexity}`);
    core.info(`Code duplication rate: ${result.totalCodeDuplicationRate}%`);
    core.info(`File duplication rate: ${result.totalFileDuplicationRate}%`);

  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

run();
