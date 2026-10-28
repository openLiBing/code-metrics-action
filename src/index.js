const core = require('@actions/core');
const { MetricsScanner, ConfigLoader } = require('./scanner');
const path = require('path');
const fs = require('fs');
const { execSync, execFile } = require('child_process');
const { sanitize } = require('./utils/sanitize');

// 兼容下划线格式的环境变量名（CI 平台 env 块通常不支持连字符变量名）
// 优先读取 INPUT_<NAME> (连字符)，回退到 INPUT_<NAME> (下划线)
function getInput(name) {
  const hyphenKey = `INPUT_${name.toUpperCase().replace(/-/g, '-')}`;
  const underscoreKey = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  return process.env[hyphenKey] || process.env[underscoreKey] || core.getInput(name) || '';
}

// ===== pip 依赖安装的索引源选择（参考 pre-commit-action 方案）=====
// 不硬编码单一镜像：先测速 PyPI 源站与华为镜像，选可用且更快的一个作为本次安装的 PIP_INDEX_URL，
// 避免执行机到某个源出网被重置（Connection reset by peer）时安装必然失败
const PIP_MIRROR_DEFAULT = 'https://mirrors.huaweicloud.com/repository/pypi/simple';
const PIP_ORIGINAL = 'https://pypi.org/simple';
const PIP_SPEED_TEST_TIMEOUT = 5;

// 探测索引源首字节耗时（毫秒），超时或不可达返回 -1。
// 只请求该索引下 lizard 单包页面的首个字节（-r 0-0 + time_starttransfer）：
// 整个 simple 索引页面体积很大，5 秒内拉不完会被误判为不可达，导致测速失去区分度
function testUrlSpeed(indexUrl) {
  const probeUrl = `${indexUrl.replace(/\/$/, '')}/lizard/`;
  return new Promise((resolve) => {
    execFile(
      'curl',
      [
        '-s', '-o', '/dev/null', '-w', '%{time_starttransfer}',
        '--max-time', String(PIP_SPEED_TEST_TIMEOUT),
        '-r', '0-0', probeUrl
      ],
      { encoding: 'utf8', timeout: (PIP_SPEED_TEST_TIMEOUT + 2) * 1000 },
      (err, stdout) => {
        // 镜像忽略 Range 返回全量时会被 --max-time 截断（err 非空），
        // 但首字节耗时已由 -w 写出，仍可据此比较，故 err 非空也尝试解析
        const seconds = parseFloat((stdout || '').trim());
        resolve(isNaN(seconds) || seconds <= 0 ? -1 : Math.round(seconds * 1000));
      }
    );
  });
}

// 并行测速 PyPI 源站与华为镜像（串行探测在双超时场景下要白等两倍时间），
// 返回可用且更快的索引地址
async function detectPipIndexUrl() {
  core.info('Probing pip index reachability...');
  const [originalMs, mirrorMs] = await Promise.all([
    testUrlSpeed(PIP_ORIGINAL),
    testUrlSpeed(PIP_MIRROR_DEFAULT)
  ]);
  core.info(`pypi.org: ${originalMs >= 0 ? originalMs + 'ms' : 'unreachable'}`);
  core.info(`huaweicloud mirror: ${mirrorMs >= 0 ? mirrorMs + 'ms' : 'unreachable'}`);
  // 两侧都不可达时回退源站（与 pre-commit-action 行为一致）
  if (originalMs < 0 && mirrorMs < 0) {
    core.warning('Both pypi.org and huaweicloud mirror are unreachable, fallback to pypi.org');
    return PIP_ORIGINAL;
  }
  if (originalMs < 0) {
    return PIP_MIRROR_DEFAULT;
  }
  if (mirrorMs < 0) {
    return PIP_ORIGINAL;
  }
  return originalMs <= mirrorMs ? PIP_ORIGINAL : PIP_MIRROR_DEFAULT;
}

async function run() {
  try {
    // 源代码目录固定为当前目录（线上环境由 checkout 步骤决定扫描内容）
    const sourceDir = './';
    const configFile = getInput('config-file');
    const excludeDirs = getInput('exclude-dirs')
      ? getInput('exclude-dirs').split(',').map(s => s.trim())
      : [];
    const allowedExtensions = getInput('allowed-extensions')
      ? getInput('allowed-extensions').split(',').map(s => s.trim())
      : [];
    // 重复检测阈值：与华为云 cmetrics 官方定义对齐
    // 官方定义："连续超过 10 行代码块在其他地方重复记为一次重复"
    // - minLines=10：连续代码块至少 10 行才算一次重复
    const minLines = parseInt(getInput('min-lines') || '10', 10);
    const outputFile = getInput('output') || 'metrics.json';

    // atomgit 上下文：当前工作流所属仓的分支/标签名
    // GitCode runner 自动注入 ATOMGIT_REF_NAME / ATOMGIT_TOKEN 等环境变量
    const atomgitRefName = process.env['ATOMGIT_REF_NAME'] || '';

    // coderepo 服务地址硬编码到插件（部署时确定的固定值）
    const coderepoUrl = 'https://apig.openlibing.com:443';
    // 认证模式判定（OIDC 联邦认证标识）：workflow 声明 permissions: id-token: write 时，
    // runner 注入 ACTIONS_ID_TOKEN_REQUEST_URL，走新接口（/action-api/...）+ OIDC 免密认证；
    // 未声明时走旧接口（/openlibing-coderepo/...）+ AK/SK 签名，兼容尚未适配的存量脚本
    const useOidc = !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    // AK/SK 凭证（仅 AK/SK 模式使用，OIDC 模式无需传入）：
    // apig-app-key/apig-app-secret 用于 APIG 上报签名，obs-ak/obs-sk 用于 OBS 全量文件上传
    const apigAppKey = getInput('apig-app-key') || '';
    const apigAppSecret = getInput('apig-app-secret') || '';
    const obsAk = getInput('obs-ak') || '';
    const obsSk = getInput('obs-sk') || '';

    // 上报用 git_url 和 branch_name：
    // 从 sourceDir 沿目录树向上找 .git（修复：sourceDir 是构建产物子目录如 source-code/target 时，
    //   .git 在 source-code/ 而非 sourceDir 内，旧逻辑只看 sourceDir/.git 会误用工作区根目录的 git）
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
    const gitRoot = findGitRoot(sourceDir);
    const gitCwd = gitRoot || process.cwd();
    if (!gitRoot) {
      core.warning(`未在 sourceDir(${sourceDir}) 的上级目录找到 .git，将使用工作区根目录的 git remote，可能与被扫描仓库不一致`);
    }
    try {
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8', cwd: gitCwd }).trim();
      // 清洗掉 url 中可能存在的内嵌凭证（任意 scheme 的 userinfo，如 http://user:pass@host/），
      // 保留 ssh://git@ 标准用户名（Ref #45 #66，与 sec-comp #38 已批准实施同款）
      gitUrl = remoteUrl.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?!git@)[^@/]+@/, '$1');
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
    if (!branchName) {
      branchName = atomgitRefName || '';
    }

    // repository 字段已移除：写死 source-dir 后，工作流所在仓 git_url 即扫描仓，
    // 后端从 gitUrl 提取 owner/repo 拼接流水线链接
    // pipelineRunId / runNumber：优先用 GitCode runner 自动注入的 ATOMGIT_RUN_ID / ATOMGIT_RUN_NUMBER，
    // 兼容 workflow 手动注入的 PIPELINE_RUN_ID / PIPELINE_RUN_NUMBER（旧配置）
    const pipelineRunId = process.env['ATOMGIT_RUN_ID'] || process.env['PIPELINE_RUN_ID'] || '';
    // runNumber 从环境变量获取，仅作记录
    const runNumber = process.env['ATOMGIT_RUN_NUMBER'] || process.env['PIPELINE_RUN_NUMBER'] || '';
    // commitId：触发本次工作流的提交 SHA（ATOMGIT_SHA），口径与 CodeQL 上报（openlibing-upload-sarif）一致
    const commitId = process.env['ATOMGIT_SHA'] || '';
    // pipelineName：流水线名称（GitCode runner 自动注入的 ATOMGIT_WORKFLOW），
    // 口径与安全编译选项插件（security-compilation-options-action）一致，供度量数据下钻页展示来源流水线
    const pipelineName = process.env['ATOMGIT_WORKFLOW'] || '';

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
    config.detectors.duplication.minLines = minLines;
    config.output = outputFile;

    // 上传配置：插件默认上传到 openLiBing（已移除 upload 开关）
    if (coderepoUrl) {
      config.uploader = {
        enabled: true,
        coderepoUrl: coderepoUrl,
        timeout: 60000,
        useOidc: useOidc,
        apigAppKey: apigAppKey,
        apigAppSecret: apigAppSecret,
        obsAk: obsAk,
        obsSk: obsSk
      };
    }

    core.info(`Upload auth mode: ${useOidc ? 'oidc (new endpoint /action-api)' : 'aksk (legacy endpoint /openlibing-coderepo)'}`);

    // 自动安装 Python 依赖（用户无需在 workflow 中手动配置 install_dependency 步骤）
    // 固定 lizard 版本，避免不同执行机装到不同版本导致指标基线不可比
    const LIZARD_VERSION = '1.24.0';
    // 先测速选定 pip 索引源；仅在本次安装子进程中通过 PIP_INDEX_URL 注入，
    // 不改写执行机的 pip 配置文件（self-hosted 常驻机上写全局配置会跨任务持久生效）
    const pipIndexUrl = await detectPipIndexUrl();
    // --break-system-packages 是 pip 23.0.1 起才提供的 PEP 668 放行开关，旧版 pip 传入会直接报
    // "no such option" 导致 lizard 安装失败，故先探测 pip 是否支持该参数，再决定是否携带
    let supportsBreakSystemPackages = false;
    try {
      const pipInstallHelp = execSync('python3 -m pip install --help', {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      supportsBreakSystemPackages = pipInstallHelp.includes('--break-system-packages');
    } catch (e) {
      // 探测失败按不支持处理（旧版 pip 无该选项），走不带该参数的命令
      core.debug(`pip install --help probe failed: ${e.message}`);
    }
    const pipInstallArgs = [
      '-m', 'pip', 'install',
      ...(supportsBreakSystemPackages ? ['--break-system-packages'] : []),
      `lizard==${LIZARD_VERSION}`
    ];
    try {
      core.info(`Installing Python dependencies (lizard==${LIZARD_VERSION}) via ${pipIndexUrl}...`);
      execSync(['python3', ...pipInstallArgs].join(' '), {
        stdio: 'inherit',
        timeout: 120000,
        env: { ...process.env, PIP_INDEX_URL: pipIndexUrl }
      });
      core.info('Python dependencies installed successfully');
    } catch (e) {
      // lizard 装不上时函数级指标会静默上报为 0，故按 error 记录便于及时发现
      core.error(`Python dependency installation failed: ${e.message}. Function-level metrics may be 0.`);
    }

    core.info('Starting code metrics scan...');
    // 只输出目录基名，不落 runner 绝对路径（Ref #60，与 sec-comp #36 同款）
    core.info(`Source directory: ${path.basename(config.sourceDir)}`);
    // 输出上报关键字段，便于排查 atomgit 上下文异常；
    // gitUrl/branchName 为外部可控字符串（git remote / 环境变量），过 sanitize 防换行注入（Ref #64）
    core.info(`gitUrl: ${sanitize(gitUrl) || '(empty)'}`);
    core.info(`branchName: ${sanitize(branchName) || '(empty)'}`);
    core.info(`pipelineRunId: ${pipelineRunId || '(empty)'}`);
    core.info(`commitId: ${commitId || '(empty)'}`);
    core.info(`pipelineName: ${pipelineName || '(empty)'}`);

    const scanner = new MetricsScanner(config);
    const result = await scanner.scan({
      sourceDir: config.sourceDir,
      output: config.output,
      upload: true,
      gitUrl: gitUrl,
      branchName: branchName,
      pipelineRunId: pipelineRunId,
      runNumber: runNumber,
      commitId: commitId,
      pipelineName: pipelineName
    });

    // 设置输出
    core.setOutput('code-scale', result.codeScale);
    core.setOutput('avg-function-loc', result.avgFunctionLoc);
    core.setOutput('avg-cyclomatic-complexity', result.avgCyclomaticComplexity);
    core.setOutput('total-code-duplication-rate', result.totalCodeDuplicationRate);
    core.setOutput('total-file-duplication-rate', result.totalFileDuplicationRate);

    // 输出概览结果（按固定顺序输出每项指标，标识为 中文名（英文名），重复率带 %），写入 ATOMGIT_OUTPUT 便于工作流直接展示
    const overviewDisplay = [
      ['codeScale', '代码规模（codeScale）', String(result.codeScale)],
      ['avgFunctionLoc', '平均代码行数（avgFunctionLoc）', String(result.avgFunctionLoc)],
      ['avgCyclomaticComplexity', '平均圈复杂度（avgCyclomaticComplexity）', String(result.avgCyclomaticComplexity)],
      ['totalCodeDuplicationRate', '总代码重复率（totalCodeDuplicationRate）', `${result.totalCodeDuplicationRate}%`],
      ['totalFileDuplicationRate', '总文件重复率（totalFileDuplicationRate）', `${result.totalFileDuplicationRate}%`]
    ];
    try {
      const overviewOutputFile = process.env['ATOMGIT_OUTPUT'];
      if (overviewOutputFile) {
        // 每行一个 标识=值 键值对，避免单行 JSON 多行转义问题
        const lines = overviewDisplay.map(item => `${item[1]}=${item[2]}`);
        fs.appendFileSync(overviewOutputFile, lines.join('\n') + '\n', 'utf8');
      }
    } catch (e) {
      core.warning(`写入 ATOMGIT_OUTPUT 概览结果失败: ${e.message}`);
    }

    // 平台详情链接输出：固定 1 行（链接行或提示行，服务端保证二者互斥），仅写 ATOMGIT_OUTPUT
    // 单一通道独立判环境变量与兜底：未设置环境变量或写入失败仅告警降级，不影响上报结果；无链接且无提示（上报失败/链接构建异常）不输出
    const DETAIL_LINK_LABEL = '代码度量指标扫描结果';
    // detailLink/tip 为服务端响应字段，拼进日志/输出行前过 sanitize 防换行注入（Ref #64）
    const detailLink = sanitize(result.uploadInfo?.detailLink || '');
    const detailTip = sanitize(result.uploadInfo?.tip || '');
    if (detailLink) {
      core.info(`${DETAIL_LINK_LABEL}: ${detailLink}`);
    } else if (detailTip) {
      core.info(`${DETAIL_LINK_LABEL}: ${detailTip}`);
    } else {
      core.info(`${DETAIL_LINK_LABEL}: 无链接（上报失败或链接构建异常，不输出）`);
    }
    try {
      const detailOutputFile = process.env['ATOMGIT_OUTPUT'];
      if (detailOutputFile && (detailLink || detailTip)) {
        // 链接行 key 以 url 结尾：平台按 key 末尾小写 url 判定 type=link 渲染为可点击链接；提示行 key 不带 url 后缀，避免提示文本被渲染成无效链接
        const detailOutputLine = detailLink ? `扫描结果url=${detailLink}` : `扫描结果=${detailTip}`;
        fs.appendFileSync(detailOutputFile, detailOutputLine + '\n', 'utf8');
      }
    } catch (e) {
      core.warning(`写入 ATOMGIT_OUTPUT 链接结果失败: ${e.message}`);
    }

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
