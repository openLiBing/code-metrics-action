const axios = require('axios');
const crypto = require('crypto');
const { callApig, getCredentials } = require('@openlibing/huaweicloud-oidc-client');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { sanitize } = require('../utils/sanitize');

// 上报接口路径前缀：新旧网关接口与认证方式一一对应
// - OIDC 联邦认证（新）：workflow 声明 permissions: id-token: write 时启用
// - AK/SK 签名（旧）：存量脚本兼容，接口与认证方式保持不变
const OIDC_API_PREFIX = '/action-api';
const AKSK_API_PREFIX = '/openlibing-coderepo';

/**
 * 华为云 APIG 签名器（SDK-HMAC-SHA256，AK/SK 模式使用）
 * 基于官方 SDK APIGW-javascript-sdk-2.0.6 的 signer.js 完全对齐
 * 签名流程：CanonicalRequest → StringToSign → HMAC-SHA256 → Authorization
 */
class ApigSigner {
  constructor(ak, sk) {
    this.ak = ak;
    this.sk = sk;
  }

  /**
   * 对请求进行签名，返回包含签名头的完整 headers
   * 与官方 SDK 的 Signer.prototype.Sign() 方法对齐
   */
  sign({ method, url, headers = {}, body = '' }) {
    // 解析 URL，提取 host、pathname、查询参数
    const parsed = new URL(url);
    const host = parsed.host;

    // 解析 URI 和查询参数（与官方 SDK 的 HttpRequest 构造函数对齐）
    const uri = decodeURIComponent(parsed.pathname);
    const query = {};
    if (parsed.search) {
      const searchStr = parsed.search.substring(1);
      for (const pair of searchStr.split('&')) {
        const idx = pair.indexOf('=');
        const key = idx >= 0 ? pair.substring(0, idx) : pair;
        const value = idx >= 0 ? pair.substring(idx + 1) : '';
        if (key) {
          const decodedKey = decodeURIComponent(key);
          const decodedValue = decodeURIComponent(value);
          if (query[decodedKey] === undefined) {
            query[decodedKey] = [decodedValue];
          } else {
            query[decodedKey].push(decodedValue);
          }
        }
      }
    }

    // 设置时间戳（检查是否已有 X-Sdk-Date 头）
    let datetime = null;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'x-sdk-date') {
        datetime = headers[k];
        break;
      }
    }
    if (!datetime) {
      datetime = this._getDateTime();
      headers['X-Sdk-Date'] = datetime;
    }

    // 非 PUT/PATCH/POST 时 body 不参与签名（官方 SDK 规范）
    if (method !== 'PUT' && method !== 'PATCH' && method !== 'POST') {
      body = '';
    }

    // 确保 host 头存在
    let hasHost = false;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'host') { hasHost = true; break; }
    }
    if (!hasHost) {
      headers['Host'] = host;
    }

    // 获取参与签名的 header 列表（所有 header 名称小写排序）
    const signedHeaderNames = Object.keys(headers).map(k => k.toLowerCase()).sort();

    // 构造规范化 URI：每段 URL 编码后用 / 拼接，末尾强制补 /
    const canonicalUri = this._canonicalUri(uri);

    // 构造规范化查询字符串
    const canonicalQs = this._canonicalQueryString(query);

    // 构造规范化 Headers
    const lowerHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }
    const canonicalHeaders = signedHeaderNames
      .map(name => `${name}:${lowerHeaders[name].trim()}`)
      .join('\n') + '\n';

    const signedHeadersStr = signedHeaderNames.join(';');

    // 计算 body 哈希（如果请求头中有 x-sdk-content-sha256，直接使用其值）
    let hashedPayload;
    let hasContentSha256 = false;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'x-sdk-content-sha256') {
        hashedPayload = headers[k];
        hasContentSha256 = true;
        break;
      }
    }
    if (!hasContentSha256) {
      hashedPayload = this._sha256Hex(body);
    }

    // 构造规范化请求
    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQs,
      canonicalHeaders,
      signedHeadersStr,
      hashedPayload
    ].join('\n');

    // 构造待签名字符串
    const stringToSign = [
      'SDK-HMAC-SHA256',
      datetime,
      this._sha256Hex(canonicalRequest)
    ].join('\n');

    // 计算签名
    const signature = this._hmacSha256Hex(this.sk, stringToSign);

    // 构造 Authorization 头
    headers['Authorization'] = `SDK-HMAC-SHA256 Access=${this.ak}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

    return headers;
  }

  /**
   * 构造规范化 URI：每段用 SDK 的 urlEncode 编码，末尾强制补 /
   * 与官方 SDK 的 CanonicalURI() 函数完全对齐
   */
  _canonicalUri(uri) {
    if (!uri || uri === '') return '/';
    const parts = uri.split('/');
    const encoded = parts.map(s => this._urlEncode(s));
    let urlpath = encoded.join('/');
    // 末尾强制补 /（官方 SDK 规范，APIG 网关签名校验要求）
    if (urlpath[urlpath.length - 1] !== '/') {
      urlpath = urlpath + '/';
    }
    return urlpath;
  }

  /**
   * 构造规范化查询字符串
   * 与官方 SDK 的 CanonicalQueryString() 函数对齐
   */
  _canonicalQueryString(query) {
    const keys = Object.keys(query).sort();
    if (keys.length === 0) return '';
    const parts = [];
    for (const key of keys) {
      const k = this._urlEncode(key);
      const values = Array.isArray(query[key]) ? [...query[key]].sort() : [query[key]];
      for (const v of values) {
        parts.push(`${k}=${this._urlEncode(v)}`);
      }
    }
    return parts.join('&');
  }

  /**
   * URL 编码：基于 Node.js querystring 模块改写，与官方 SDK 的 urlEncode() 完全对齐
   * 不编码字符：A-Z a-z 0-9 - . _ ~
   * 与 encodeURIComponent 的区别：! * ' ( ) 会被编码（encodeURIComponent 不编码这些）
   */
  _urlEncode(str) {
    if (typeof str !== 'string') {
      if (typeof str === 'object') str = String(str);
      else str += '';
    }
    const hexTable = [];
    for (let i = 0; i < 256; ++i) {
      hexTable[i] = '%' + ((i < 16 ? '0' : '') + i.toString(16)).toUpperCase();
    }
    const noEscape = [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0,
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
      0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1,
      0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0
    ];
    let out = '';
    let lastPos = 0;
    for (let i = 0; i < str.length; ++i) {
      // 代理对场景下需在下方重新赋值（c = 0x10000 + ...），此处必须用 let
      let c = str.charCodeAt(i);
      if (c < 0x80) {
        if (noEscape[c] === 1) continue;
        if (lastPos < i) out += str.slice(lastPos, i);
        lastPos = i + 1;
        out += hexTable[c];
        continue;
      }
      if (lastPos < i) out += str.slice(lastPos, i);
      if (c < 0x800) {
        lastPos = i + 1;
        out += hexTable[0xC0 | (c >> 6)] + hexTable[0x80 | (c & 0x3F)];
        continue;
      }
      if (c < 0xD800 || c >= 0xE000) {
        lastPos = i + 1;
        out += hexTable[0xE0 | (c >> 12)] + hexTable[0x80 | ((c >> 6) & 0x3F)] + hexTable[0x80 | (c & 0x3F)];
        continue;
      }
      ++i;
      if (i >= str.length) throw new URIError('ERR_INVALID_URI');
      const c2 = str.charCodeAt(i) & 0x3FF;
      lastPos = i + 1;
      c = 0x10000 + (((c & 0x3FF) << 10) | c2);
      out += hexTable[0xF0 | (c >> 18)] + hexTable[0x80 | ((c >> 12) & 0x3F)] + hexTable[0x80 | ((c >> 6) & 0x3F)] + hexTable[0x80 | (c & 0x3F)];
    }
    if (lastPos === 0) return str;
    if (lastPos < str.length) return out + str.slice(lastPos);
    return out;
  }

  _getDateTime() {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  }

  _sha256Hex(data) {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
  }

  _hmacSha256Hex(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
  }
}

class CoderepoUploader {
  constructor(config = {}) {
    // coderepoUrl 由调用方恒传（src/index.js 部署固定常量），无 localhost 死 fallback
    // （Ref #51，与 sec-comp #26/#31 同款：原 fallback 在真实调用链下不可达，删除即等价加固）
    this.baseUrl = config.coderepoUrl;
    this.timeout = config.timeout || 30000;
    // 认证模式：useOidc=true 走新接口（/action-api/...）+ OIDC 免密联邦认证；
    // 否则走旧接口（/openlibing-coderepo/...）+ AK/SK（SDK-HMAC-SHA256）签名，兼容存量脚本
    this.useOidc = !!config.useOidc;
    this.apigAppKey = config.apigAppKey || '';
    this.apigAppSecret = config.apigAppSecret || '';
    // OBS 上传凭证（AK/SK 模式使用）：复用 openlibing 平台 gitcode-action 统一桶（私有对象，供后端按 objectKey 下载）
    this.obsAk = config.obsAk || '';
    this.obsSk = config.obsSk || '';
    // 平台所有 gitcode-action 插件上报结果的统一桶，code-metrics-action 目录存放代码度量上报
    this.obsBucket = config.obsBucket || 'openlibing-gitcode-action';
    // OBS 写/读 endpoint（华为云西南-贵阳一）
    this.obsEndpoint = config.obsEndpoint || 'obs.cn-southwest-2.myhuaweicloud.com';
    this.obsutilPath = '';
  }

  /**
   * 上报代码度量指标。
   *
   * 认证模式（由 workflow 是否声明 permissions: id-token: write 决定）：
   * - OIDC 联邦认证（新）：APIG 上报走 callApig 自动换证签名；OBS 上传走 STS 临时凭证
   * - AK/SK 签名（旧）：APIG 上报走 ApigSigner 签名；OBS 上传走 obs-ak/obs-sk 静态凭证
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
      // pipelineName：流水线名称（GitCode runner 注入的 ATOMGIT_WORKFLOW），供度量下钻页展示数据来源流水线
      pipelineName: options.pipelineName,
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
    // obsUrl 内嵌从 gitUrl 提取的 owner/repo（外部可控），过 sanitize 防换行注入（Ref #64）
    console.log(`[upload] report serialized=${mainBody.length} bytes, obsUrl=${sanitize(obsResult.obsUrl)}`);
    const mainResult = await this.report(mainUrl, mainBody);
    if (!mainResult.success) {
      // 上报失败但 OBS 文件已完整上传：打印固定格式链接，提示可走保底定时任务补导入
      console.warn(
        `[upload] report failed: ${sanitize(mainResult.error)}. 全量数据已上传 OBS(${sanitize(obsResult.obsUrl)})，` +
          '可通过平台保底定时任务(入参 objectKey)补导入'
      );
      return { ...mainResult, obsUrl: obsResult.obsUrl };
    }

    // detailLink/tip：平台跳转链接或提示（两者最多其一，服务端受理响应携带），供入口输出
    return {
      success: true,
      recordId: mainResult.recordId,
      obsUrl: obsResult.obsUrl,
      detailLink: mainResult.detailLink,
      tip: mainResult.tip
    };
  }

  /**
   * 组装全量上报文件并上传到 OBS，返回固定格式下载链接与 objectKey。
   * OBS 凭证按认证模式选择：
   * - OIDC 模式：getCredentials 获取 STS 临时凭证（短时效，仅本次流水线运行有效）
   * - AK/SK 模式：workflow 传入的 obs-ak / obs-sk 静态凭证
   */
  async uploadFullPayloadToOBS(fullPayload, options) {
    let cred;
    if (this.useOidc) {
      try {
        // 获取 STS 临时凭证（SDK 内部缓存，同一次流水线运行内只换证一次）
        cred = await getCredentials();
      } catch (e) {
        return { success: false, error: `获取 OIDC 临时凭证失败: ${e.message}` };
      }
    } else if (!this.obsAk || !this.obsSk) {
      return { success: false, error: '未启用 OIDC 联邦认证（workflow 未声明 permissions: id-token: write），且缺少 OBS 凭证(obs-ak / obs-sk)，无法上传上报结果' };
    }
    // 写本地临时文件（runner 上临时目录，用完即删）
    // 随机文件名（crypto.randomUUID，不可预测）+ 0600 权限（同机其他账户/进程不可读）
    // （Ref #50 #42：原毫秒时间戳文件名可预测、默认权限 644 可读）
    const tmpFile = path.join(os.tmpdir(), `code-metrics-${crypto.randomUUID()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(fullPayload), { encoding: 'utf8', mode: 0o600 });

    const objectKey = this.buildObjectKey(options);
    try {
      await this.uploadToOBS(cred, tmpFile, objectKey);
      const obsUrl = `https://${this.obsBucket}.${this.obsEndpoint}/${objectKey}`;
      console.log(`[upload] OBS uploaded: ${sanitize(obsUrl)}`);
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
   * 凭证传递（按认证模式）：
   * - OIDC 模式：STS 临时凭证，经 -e/-i/-k/-t 命令行参数传 endpoint/临时AK/临时SK/SecurityToken
   * - AK/SK 模式：静态 obs-ak/obs-sk，经 -e/-i/-k 命令行参数传递
   * CI 平台对 secrets/临时令牌自动掩码，不会明文落日志。
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
      `-e=${this.obsEndpoint}`
    ];
    if (this.useOidc) {
      // OIDC 模式：STS 临时凭证 + SecurityToken
      args.push(`-i=${cred.accessKeyId}`, `-k=${cred.secretAccessKey}`, `-t=${cred.securityToken}`);
    } else {
      // AK/SK 模式：静态凭证
      args.push(`-i=${this.obsAk}`, `-k=${this.obsSk}`);
    }
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
   * 拼接完整请求 URL：按认证模式选择新旧接口前缀
   * - OIDC 模式：/action-api/metrics/code/report
   * - AK/SK 模式：/openlibing-coderepo/metrics/code/report
   */
  buildUrl(path) {
    const prefix = this.useOidc ? OIDC_API_PREFIX : AKSK_API_PREFIX;
    return this.baseUrl.replace(/\/+$/, '') + prefix + path;
  }

  /**
   * 调用 APIG 上报接口并解析 DataResult 响应（按认证模式选择签名方式）。
   * - OIDC 模式：SDK callApig 免密联邦认证（OIDC ID Token -> STS 临时凭证 ->
   *   V11-HMAC-SHA256 签名 + X-Security-Token）
   * - AK/SK 模式：ApigSigner SDK-HMAC-SHA256 签名（原有方式）
   * 返回 { success, recordId?, detailLink?, tip?, error? }
   */
  async report(url, body) {
    try {
      let resData;
      if (this.useOidc) {
        const res = await callApig('POST', url, { 'Content-Type': 'application/json' }, body);
        resData = res.data;

        // 非 2xx：HTTP 层失败（网关拒绝、鉴权失败等）
        if (res.status < 200 || res.status >= 300) {
          const httpMsg = (resData && (resData.msg || resData.message || resData.error_msg)) || `HTTP ${res.status}`;
          console.error(`Upload failed: HTTP ${res.status}, URL: ${url}`);
          return { success: false, error: httpMsg };
        }
      } else {
        // AK/SK 模式：凭证缺失时直接失败并给出明确提示
        if (!this.apigAppKey || !this.apigAppSecret) {
          return { success: false, error: '未启用 OIDC 联邦认证（workflow 未声明 permissions: id-token: write），且缺少 AK/SK 凭证（apig-app-key / apig-app-secret），无法上报' };
        }
        const signer = new ApigSigner(this.apigAppKey, this.apigAppSecret);
        const headers = signer.sign({
          method: 'POST',
          url: url,
          headers: { 'Content-Type': 'application/json' },
          body: body
        });
        const response = await axios.post(url, body, { headers, timeout: this.timeout });
        resData = response.data;
      }

      // DataResult 响应格式：{ code, msg, adviceMsg, data }，code=200 表示业务成功
      if (resData?.code !== 200) {
        // 打印完整业务失败信息（code/msg/adviceMsg），便于定位后端拒绝原因；
        // msg/adviceMsg 为服务端响应字段，过 sanitize 防换行注入（Ref #64）
        console.error(
          `[upload] report business failed: code=${resData?.code}, msg=${sanitize(resData?.msg)}, adviceMsg=${sanitize(resData?.adviceMsg)}`
        );
        return { success: false, error: resData?.msg || 'Unknown error' };
      }

      // data 可能直接是 recordId 值，也可能是 { recordId: ... } 对象；当前服务端返回 CodeMetricsReportVO
      const recordId = resData?.data?.recordId
        || resData?.data?.id
        || (typeof resData?.data === 'number' || typeof resData?.data === 'string' ? resData.data : null)
        || resData?.recordId
        || resData?.id;

      // data.detailLink：平台分支页固定单条跳转链接；data.tip：仓未录入/分支未登记提示（两者互斥，可均为空）
      const detailLink = typeof resData?.data?.detailLink === 'string' ? resData.data.detailLink : '';
      const tip = typeof resData?.data?.tip === 'string' ? resData.data.tip : '';

      return { success: true, recordId: recordId, detailLink: detailLink, tip: tip };
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
