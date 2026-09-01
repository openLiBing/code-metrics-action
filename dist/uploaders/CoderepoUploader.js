const { callApig, getCredentials } = require('@openlibing/huaweicloud-oidc-client');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

class CoderepoUploader {
  constructor(config = {}) {
    this.baseUrl = config.coderepoUrl || 'http://localhost:8080';
    this.timeout = config.timeout || 30000;
    // 平台所有 gitcode-action 插件上报结果的统一桶，code-metrics-action 目录存放代码度量上报
    this.obsBucket = config.obsBucket || 'openlibing-gitcode-action';
    // OBS 写/读 endpoint（华为云西南-贵阳一）
    this.obsEndpoint = config.obsEndpoint || 'obs.cn-southwest-2.myhuaweicloud.com';
    this.obsutilPath = '';
  }

  /**
   * 上报代码度量指标。
   *
   * 使用 OIDC 免密联邦认证（@openlibing/huaweicloud-oidc-client）：
   * - APIG 上报：callApig 自动完成 OIDC ID Token 申请 -> STS 换证 -> V11 签名 + X-Security-Token
   * - OBS 上传：getCredentials 获取 STS 临时凭证，obsutil 经 -i/-k/-t 参数传递临时凭证
   *
   * 流程（OBS 中转 + 单接口，彻底规避 APIG 12MB 请求体上限）：
   * 1. 组装全量上报文件（元数据 + 总体指标 + fileDetails + identicalFileDetails + duplicationOccurrences），写本地临时 json
   * 2. 上传到 OBS（桶 openlibing-gitcode-action / code-metrics-action/ 前缀，私有对象）
   * 3. 仅调一次 POST /metrics/code/report：只传元数据 + obsUrl（固定格式下载链接），后端按 objectKey 下载解析入库
   *
   * 兜底：即使第 3 步上报失败（网络原因），第 2 步 OBS 文件已完整上传，可通过平台保底定时任务
   * （入参 objectKey）下载补导入，保证数据不丢失。
   *
   * 注意：repository 字段已移除（写死 source-dir 后，工作流所在仓 git_url 即扫描仓）
   */
  async upload(metricsData, options = {}) {
    // 从 metricsData 中分离出 fileDetails、identicalFileDetails、duplicationOccurrences 和总体指标
    const { fileDetails, identicalFileDetails, duplicationOccurrences, ...overallMetrics } = metricsData;

    // 1. 组装全量上报文件：元数据 + 全部指标明细（含 snapshotData / contentB64 等大 payload）
    const fullPayload = {
      gitUrl: options.gitUrl,
      branchName: options.branchName,
      pipelineRunId: options.pipelineRunId,
      commitId: options.commitId,
      runNumber: options.runNumber,
      metricsData: overallMetrics,
      detectionStartedAt: options.startTime,
      detectionCompletedAt: options.endTime,
      status: options.status || 0,
      fileDetails: fileDetails || [],
      identicalFileDetails: identicalFileDetails || [],
      duplicationOccurrences: this.encodeOccurrences(duplicationOccurrences || [])
    };
    if (options.errorMessage) {
      fullPayload.errorMessage = options.errorMessage;
    }

    // 2. 上传全量文件到 OBS，得到固定格式下载链接
    const obsResult = await this.uploadFullPayloadToOBS(fullPayload, options);
    if (!obsResult.success) {
      // OBS 上传失败：数据未落盘，直接返回失败（可整体重扫重传）
      return obsResult;
    }

    // 3. 单次 /report：只传元数据 + obsUrl（body 恒定极小，远低于 APIG 12MB 上限）
    const payload = {
      gitUrl: options.gitUrl,
      branchName: options.branchName,
      pipelineRunId: options.pipelineRunId,
      commitId: options.commitId,
      runNumber: options.runNumber,
      detectionStartedAt: options.startTime,
      detectionCompletedAt: options.endTime,
      status: options.status || 0,
      obsUrl: obsResult.obsUrl
    };
    if (options.errorMessage) {
      payload.errorMessage = options.errorMessage;
    }

    const mainUrl = this.buildUrl('/metrics/code/report');
    const mainBody = JSON.stringify(payload);
    console.log(`[upload] report serialized=${mainBody.length} bytes, obsUrl=${obsResult.obsUrl}`);
    const mainResult = await this.report(mainUrl, mainBody);
    if (!mainResult.success) {
      // 上报失败但 OBS 文件已完整上传：打印固定格式链接，提示可走保底定时任务补导入
      console.warn(
        `[upload] report failed: ${mainResult.error}. 全量数据已上传 OBS(${obsResult.obsUrl})，` +
          '可通过平台保底定时任务(入参 objectKey)补导入'
      );
      return { ...mainResult, obsUrl: obsResult.obsUrl };
    }

    return { success: true, recordId: mainResult.recordId, obsUrl: obsResult.obsUrl };
  }

  /**
   * 组装全量上报文件并上传到 OBS，返回固定格式下载链接与 objectKey。
   * OBS 凭证使用 OIDC 联邦认证换取的 STS 临时凭证（短时效，仅本次流水线运行有效）。
   */
  async uploadFullPayloadToOBS(fullPayload, options) {
    let cred;
    try {
      // 获取 STS 临时凭证（SDK 内部缓存，同一次流水线运行内只换证一次）
      cred = await getCredentials();
    } catch (e) {
      return { success: false, error: `获取 OIDC 临时凭证失败: ${e.message}` };
    }
    // 写本地临时文件（runner 上临时目录，用完即删）
    const tmpFile = path.join(os.tmpdir(), `code-metrics-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(fullPayload), 'utf-8');

    const objectKey = this.buildObjectKey(options);
    try {
      await this.uploadToOBS(cred, tmpFile, objectKey);
      const obsUrl = `https://${this.obsBucket}.${this.obsEndpoint}/${objectKey}`;
      console.log(`[upload] OBS uploaded: ${obsUrl}`);
      return { success: true, obsUrl: obsUrl, objectKey: objectKey };
    } catch (e) {
      return { success: false, error: `OBS 上传失败: ${e.message}` };
    } finally {
      // 清理本地临时文件，避免在 runner 上残留大文件
      try {
        fs.unlinkSync(tmpFile);
      } catch (e) {
        // 忽略清理失败
      }
    }
  }

  /**
   * 用 obsutil 上传本地文件到 OBS（参考 upload-sarif-action）。
   * 私有对象，不带 -acl=public-read；后端/保底任务用平台 OBS 凭证按 objectKey 下载。
   *
   * 凭证传递：使用 OIDC 联邦认证换取的 STS 临时凭证，经 -e/-i/-k/-t 命令行参数传
   * endpoint/临时AK/临时SK/SecurityToken。CI 平台对临时令牌自动掩码，不会明文落日志。
   *
   * 安全处理：用 execFileSync 参数数组直接调用 obsutil，不经 shell 解析，避免仓库路径/pipelineRunId 等
   * 外部输入包含分号、反引号、$() 等 shell 特殊字符时被注入执行任意命令。
   */
  async uploadToOBS(cred, localFilePath, objectKey) {
    const obsutil = await this.ensureObsutil();
    // 记录 obsutil 版本，便于排查 runner 与本地环境差异
    try {
      const versionOut = execFileSync(obsutil, ['version'], { encoding: 'utf8' }).trim();
      console.log(`[upload] obsutil version: ${versionOut}`);
    } catch (e) {
      console.log(`[upload] obsutil version check failed: ${e.message}`);
    }
    const args = [
      'cp',
      localFilePath,
      `obs://${this.obsBucket}/${objectKey}`,
      '-f',
      `-e=${this.obsEndpoint}`,
      `-i=${cred.accessKeyId}`,
      `-k=${cred.secretAccessKey}`,
      `-t=${cred.securityToken}`
    ];
    // 打印执行命令（-k/-t 参数脱敏），便于定位上传失败原因
    const maskedArgs = args.map(a => (a.startsWith('-k=') || a.startsWith('-t=') ? `${a.split('=')[0]}=***` : a));
    console.log(`[upload] exec obsutil ${maskedArgs.join(' ')}`);
    execFileSync(obsutil, args, { stdio: 'inherit' });
  }

  /**
   * 确保 obsutil 可用：不存在时下载并解压到临时目录（与 upload-sarif-action 一致）。
   * 下载失败时回退到系统已安装的 obsutil，避免网络抖动导致上传中断。
   */
  async ensureObsutil() {
    if (this.obsutilPath && fs.existsSync(this.obsutilPath)) {
      return this.obsutilPath;
    }
    const tmpDir = os.tmpdir();
    const downloadUrl =
      'https://obs-community.obs.cn-north-1.myhuaweicloud.com/obsutil/current/obsutil_linux_amd64.tar.gz';
    const tarball = path.join(tmpDir, 'obsutil_linux_amd64.tar.gz');
    const extractedDir = path.join(tmpDir, 'obsutil');
    try {
      if (!fs.existsSync(extractedDir)) {
        execSync(`mkdir -p "${extractedDir}"`, { shell: '/bin/bash' });
      }
      execSync(
        `wget -q "${downloadUrl}" -O "${tarball}" 2>/dev/null || curl -sL "${downloadUrl}" -o "${tarball}"`,
        { shell: '/bin/bash' }
      );
      execSync(`tar zxf "${tarball}" -C "${extractedDir}" --strip-components=1`, { shell: '/bin/bash' });
      execSync(`chmod 755 "${extractedDir}/obsutil"`, { shell: '/bin/bash' });
      this.obsutilPath = path.join(extractedDir, 'obsutil');
    } catch (e) {
      // 下载失败时尝试使用系统已安装的 obsutil
      try {
        const existing = execSync('which obsutil', { encoding: 'utf8', shell: '/bin/bash' }).trim();
        if (existing) {
          this.obsutilPath = existing;
        }
      } catch (e2) {
        // 无系统 obsutil，抛错
      }
      if (!this.obsutilPath) {
        throw new Error(`obsutil 安装失败: ${e.message}`);
      }
    }
    return this.obsutilPath;
  }

  /**
   * 构造 OBS 对象 key（固定格式，供后端/保底任务按 objectKey 下载解析入库）。
   * 规则：code-metrics-action/{owner}/{repo}/{pipelineRunId}/{ts}-metrics.json
   * branchName 不进入路径（远端分支可能含 / 造成路径歧义），只放在文件内元数据中。
   */
  buildObjectKey(options) {
    const ownerRepo = this.extractOwnerRepo(options.gitUrl) || 'unknown';
    const pipelineRunId = options.pipelineRunId || 'manual';
    const ts = this.formatDateTime(new Date());
    return `code-metrics-action/${ownerRepo}/${pipelineRunId}/${ts}-metrics.json`;
  }

  /**
   * 从 gitUrl 提取 owner/repo（形如 git@host:owner/repo 或 https://host/owner/repo）。
   */
  extractOwnerRepo(gitUrl) {
    if (!gitUrl) {
      return '';
    }
    const url = String(gitUrl).replace(/\.git$/, '').replace(/\/+$/, '');
    const match = url.match(/(?:git@[^:]+:|https?:\/\/[^/]+\/)(.+)$/);
    return match ? match[1] : '';
  }

  /**
   * 格式化时间为 yyyyMMddHHmmss（OBS 对象 key 用，UTC）。
   */
  formatDateTime(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
  }

  /**
   * 把出现位置列表中的明文 content 编码为 contentB64，移除明文字段。
   * 已编码数据跳过（防二次编码）。
   * 重复块内容完整编码不做截断：全量上报文件上传 OBS（不受 APIG body 限制），
   * 入库 code_metrics_duplication_block.content_b64 为 LONGTEXT 可承载。
   */
  encodeOccurrences(occurrences) {
    return occurrences.map(occ => {
      return {
        groupId: occ.groupId,
        contentHash: occ.contentHash,
        occurrenceIndex: occ.occurrenceIndex,
        filePath: occ.filePath,
        startLine: occ.startLine,
        endLine: occ.endLine,
        contentB64: this.encodeB64(occ.content)
      };
    });
  }

  /**
   * 超长内容裁剪为「头部 + 省略标记 + 尾部」，中间直接省略。
   * 按行省略：头/尾各保留若干整行，省略标记显示被省略的行数。
   * 仅用于本地 metrics.json 输出文件的防护性裁剪（防 V8 单字符串上限）；
   * 上报链路（encodeOccurrences）不截断，完整内容上传 OBS。
   */
  clipOversizeContent(content, maxChars) {
    if (typeof content !== 'string' || content.length <= maxChars) {
      return content;
    }
    // 按行拆分；头/尾各以预算的 35% 为字符配额累积整行，保证裁剪后总量仍受控
    const lines = content.split('\n');
    const totalLines = lines.length;
    const sideChars = Math.floor(maxChars * 0.35);
    // 头部：从首行开始累积整行，直到逼近 sideChars
    let headLines = 0;
    let headChars = 0;
    for (let i = 0; i < totalLines; i++) {
      const len = lines[i].length + 1; // 行内容 + 换行符
      if (headLines > 0 && headChars + len > sideChars) break;
      headChars += len;
      headLines++;
    }
    // 尾部：从末行开始累积整行，直到逼近 sideChars
    let tailLines = 0;
    let tailChars = 0;
    for (let i = totalLines - 1; i >= 0; i--) {
      const len = lines[i].length + 1;
      if (tailLines > 0 && tailChars + len > sideChars) break;
      tailChars += len;
      tailLines++;
    }
    const omittedLines = Math.max(0, totalLines - headLines - tailLines);
    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(totalLines - tailLines).join('\n');
    const clipped =
      (headLines > 0 ? head : '') +
      (omittedLines > 0 ? `\n... ${omittedLines} lines omitted ...\n` : '') +
      (tailLines > 0 ? tail : '');
    // 兜底：单行超长导致按行裁剪后仍超限时，退化为按字符裁剪
    if (clipped.length > maxChars) {
      const headChars2 = Math.floor(maxChars * 0.35);
      const tailChars2 = Math.floor(maxChars * 0.35);
      const omittedChars = content.length - headChars2 - tailChars2;
      return (
        content.slice(0, headChars2) +
        `\n... ${omittedChars} chars omitted ...\n` +
        content.slice(content.length - tailChars2)
      );
    }
    return clipped;
  }

  /**
   * Base64 编码字符串（UTF-8）。
   * 已编码数据（通过回检判定）跳过，防二次编码。
   */
  encodeB64(str) {
    if (!str) return '';
    // 简单回检：若解码后重新编码与原值一致，视为已编码
    try {
      const decoded = Buffer.from(str, 'base64').toString('utf8');
      const reEncoded = Buffer.from(decoded, 'utf8').toString('base64');
      if (reEncoded === str) return str;
    } catch (e) {
      // 解码失败说明是明文，继续编码
    }
    return Buffer.from(str, 'utf8').toString('base64');
  }

  /**
   * 拼接完整请求 URL：baseUrl 已包含 /openlibing-coderepo 前缀
   */
  buildUrl(path) {
    return this.baseUrl.replace(/\/+$/, '') + '/openlibing-coderepo' + path;
  }

  /**
   * 调用 APIG 上报接口并解析 DataResult 响应。
   * 使用 SDK callApig：OIDC 免密联邦认证（OIDC ID Token -> STS 临时凭证 ->
   * V11-HMAC-SHA256 签名 + X-Security-Token），替代原 AK/SK（SDK-HMAC-SHA256）签名方式。
   * 返回 { success, recordId?, error? }
   */
  async report(url, body) {
    try {
      const res = await callApig('POST', url, { 'Content-Type': 'application/json' }, body);
      const resData = res.data;

      // 非 2xx：HTTP 层失败（网关拒绝、鉴权失败等）
      if (res.status < 200 || res.status >= 300) {
        const httpMsg = (resData && (resData.msg || resData.message || resData.error_msg)) || `HTTP ${res.status}`;
        console.error(`Upload failed: HTTP ${res.status}, URL: ${url}`);
        return { success: false, error: httpMsg };
      }

      // DataResult 响应格式：{ code, msg, adviceMsg, data }，code=200 表示业务成功
      if (resData?.code !== 200) {
        // 打印完整业务失败信息（code/msg/adviceMsg），便于定位后端拒绝原因
        console.error(
          `[upload] report business failed: code=${resData?.code}, msg=${resData?.msg}, adviceMsg=${resData?.adviceMsg}`
        );
        return { success: false, error: resData?.msg || 'Unknown error' };
      }

      // data 可能直接是 recordId 值，也可能是 { recordId: ... } 对象
      const recordId = resData?.data?.recordId
        || resData?.data?.id
        || (typeof resData?.data === 'number' || typeof resData?.data === 'string' ? resData.data : null)
        || resData?.recordId
        || resData?.id;

      return { success: true, recordId: recordId };
    } catch (error) {
      // 输出详细错误信息以便排查网络问题
      console.error(`Upload error: ${error.code || error.message}, URL: ${url}`);
      const resData = error.response?.data;
      const errorMsg = resData?.msg || resData?.message || error.message;
      return { success: false, error: errorMsg };
    }
  }
}

module.exports = CoderepoUploader;
