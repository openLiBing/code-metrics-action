const axios = require('axios');
const crypto = require('crypto');

/**
 * 华为云 APIG 签名器（SDK-HMAC-SHA256）
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
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1,
      0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0
    ];
    let out = '';
    let lastPos = 0;
    for (let i = 0; i < str.length; ++i) {
      const c = str.charCodeAt(i);
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
    this.baseUrl = config.coderepoUrl || 'http://localhost:8080';
    this.timeout = config.timeout || 30000;
    this.apigAppKey = config.apigAppKey || '';
    this.apigAppSecret = config.apigAppSecret || '';
    // 单批请求体字节上限：华为云 APIG 网关默认请求体限制 10MB，取 8MB 留安全余量，
    // 避免主报告/批量请求触发 HTTP 413（APIG.0201 Request entity too large）
    this.maxBatchBytes = config.maxBatchBytes || 8 * 1024 * 1024;
    // 兼容旧配置：按条数分批（duplicationBatchSize=5000）已废弃，改为按字节分批
    this.duplicationBatchSize = config.duplicationBatchSize || 5000;
  }

  /**
   * 上报代码度量指标。
   *
   * 流程（主报告无任何大数据，彻底规避 APIG 413 与 V8 单字符串上限）：
   * 1. 主报告（仅总体指标）POST /metrics/code/report → 后端创建 record 并返回 recordId
   * 2. fileDetails（含 snapshotData）按字节分批 POST /metrics/code/file-details，
   *    identicalFileDetails 仅随最后一批附带（其保存依赖 file_detail 记录已存在）
   * 3. duplicationOccurrences 按字节分批 POST /metrics/code/duplication-blocks
   *
   * 注意：repository 字段已移除（写死 source-dir 后，工作流所在仓 git_url 即扫描仓）
   */
  async upload(metricsData, options = {}) {
    // 从 metricsData 中分离出 fileDetails、identicalFileDetails、duplicationOccurrences 和总体指标
    const { fileDetails, identicalFileDetails, duplicationOccurrences, ...overallMetrics } = metricsData;

    // 1. 主报告只传总体指标（不含 fileDetails/identical/occurrences 等大数据），体量恒定极小
    const payload = {
      gitUrl: options.gitUrl,
      branchName: options.branchName,
      pipelineRunId: options.pipelineRunId,
      runNumber: options.runNumber,
      metricsData: overallMetrics,
      detectionStartedAt: options.startTime,
      detectionCompletedAt: options.endTime,
      status: options.status || 0
    };
    if (options.errorMessage) {
      payload.errorMessage = options.errorMessage;
    }

    // 主报告上报
    const mainUrl = this.buildUrl('/metrics/code/report');
    const mainBody = JSON.stringify(payload);
    // 诊断日志：主报告序列化后实际大小（应为 KB 级，不含大数据）
    console.log(`[upload] main report serialized=${mainBody.length} bytes`);
    const mainResult = await this.sendSignedRequest('POST', mainUrl, mainBody);
    if (!mainResult.success) {
      return mainResult;
    }
    const recordId = mainResult.recordId;

    // 2. fileDetails（含 snapshotData）按字节分批上传到 /file-details
    const fdBatches = this.splitByBytes(fileDetails || []);
    if (fdBatches.length === 0) {
      // 无 fileDetails 但有 identicalFileDetails：单独走一批（空 fileDetails + identical）
      if ((identicalFileDetails || []).length > 0) {
        const fdResult =
            await this.uploadFileDetailsBatch(recordId, [], identicalFileDetails || [], 1, 1);
        if (!fdResult.success) {
          console.warn(`File details batch 1/1 failed: ${fdResult.error}`);
        }
      }
    } else {
      for (let i = 0; i < fdBatches.length; i++) {
        // identicalFileDetails 依赖 file_detail 记录已存在，只随最后一批附带
        const identical = i === fdBatches.length - 1 ? identicalFileDetails || [] : [];
        const fdResult = await this.uploadFileDetailsBatch(
            recordId, fdBatches[i], identical, i + 1, fdBatches.length);
        if (!fdResult.success) {
          console.warn(`File details batch ${i + 1}/${fdBatches.length} failed: ${fdResult.error}`);
        }
      }
    }

    // 3. duplicationOccurrences 按字节分批上传到 /duplication-blocks
    const encodedOccurrences = this.encodeOccurrences(duplicationOccurrences || []);
    const occBatches = this.splitByBytes(encodedOccurrences);
    if (occBatches.length > 0) {
      const occResult = await this.uploadDuplicationBlocksInBatches(recordId, occBatches);
      if (!occResult.success) {
        // 分批上报失败不阻塞主流程，记录警告（主报告已成功，重复块部分丢失可重扫补齐）
        console.warn(`Duplication blocks batch upload partially failed: ${occResult.error}`);
      }
    }

    return { success: true, recordId: recordId };
  }

  /**
   * 按字节体量将列表拆分为多批，单批 ≤ maxBatchBytes。
   *
   * <p>单条体量用 UTF-8 字节数估算（Buffer.byteLength）：避免中文等多字节字符
   * 使 char 计数低估实际请求体字节数而再次触发 APIG 413。
   * 单条 fileDetail/occurrence 均有截断保护（snapshotData ≤100KB、content ≤15KB），
   * 远小于 V8 单字符串上限，单条估算安全。
   */
  splitByBytes(items) {
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const item of items) {
      let bytes = 0;
      try {
        bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
      } catch (e) {
        bytes = 0;
      }
      if (current.length > 0 && currentBytes + bytes > this.maxBatchBytes) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += bytes;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  /**
   * 分批上报文件级指标明细到 /metrics/code/file-details。
   *
   * <p>identicalFileDetails 仅最后一批附带（其保存依赖 file_detail 记录已存在）。
   *
   * @param recordId 主表记录ID
   * @param fileDetails 本批文件级指标明细
   * @param identicalFileDetails 完全一致文件明细（仅最后一批传入，可空）
   * @param batchIndex 当前批次序号（日志用）
   * @param batchTotal 总批次数（日志用）
   */
  async uploadFileDetailsBatch(recordId, fileDetails, identicalFileDetails, batchIndex, batchTotal) {
    const batchUrl = this.buildUrl('/metrics/code/file-details');
    const body = JSON.stringify({
      recordId: recordId,
      fileDetails: fileDetails,
      identicalFileDetails: identicalFileDetails
    });
    // 诊断日志：每批体量
    console.log(
      `[upload] file-details batch ${batchIndex}/${batchTotal}: ${fileDetails.length} files, ${body.length} bytes`
    );
    const result = await this.sendSignedRequest('POST', batchUrl, body);
    if (!result.success) {
      return result;
    }
    return { success: true };
  }

  /**
   * 分批上报重复块出现位置到 /metrics/code/duplication-blocks。
   * 单批失败不阻塞后续批次，最终汇总成功/失败计数。
   *
   * @param recordId 主表记录ID
   * @param batches 已按字节拆分好的批次（元素为已编码的 occurrence 对象）
   */
  async uploadDuplicationBlocksInBatches(recordId, batches) {
    const batchUrl = this.buildUrl('/metrics/code/duplication-blocks');
    let totalFailed = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const body = JSON.stringify({
        recordId: recordId,
        blocks: batch
      });
      // 诊断日志：每批体量
      console.log(`[upload] duplication batch ${i + 1}/${batches.length}: ${batch.length} blocks, ${body.length} bytes`);
      const result = await this.sendSignedRequest('POST', batchUrl, body);
      if (!result.success) {
        totalFailed++;
        console.warn(`Duplication blocks batch ${i + 1}/${batches.length} failed: ${result.error}`);
      }
    }
    if (totalFailed > 0) {
      return { success: false, error: `${totalFailed}/${batches.length} batches failed` };
    }
    return { success: true };
  }

  /**
   * 把出现位置列表中的明文 content 编码为 contentB64，移除明文字段。
   * 已编码数据跳过（防二次编码）。
   */
  encodeOccurrences(occurrences) {
    // 单条重复块内容上限（明文 15KB ≈ Base64 20KB），防止超大重复块把主报告 JSON 撑爆
    const MAX_CONTENT_CHARS = 15 * 1024;
    return occurrences.map(occ => {
      const content = this.clipOversizeContent(occ.content, MAX_CONTENT_CHARS);
      return {
        groupId: occ.groupId,
        contentHash: occ.contentHash,
        occurrenceIndex: occ.occurrenceIndex,
        filePath: occ.filePath,
        startLine: occ.startLine,
        endLine: occ.endLine,
        contentB64: this.encodeB64(content)
      };
    });
  }

  /**
   * 超长内容裁剪为「头部 + 省略标记 + 尾部」，中间直接省略。
   * 按行省略：头/尾各保留若干整行，省略标记显示被省略的行数（与 /file-content 的
   * segments 省略样式一致）。仅针对超长场景（超过 maxChars）触发；未超长时原样返回。
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
   * 发送 APIG 签名请求，解析 DataResult 响应。
   * 返回 { success, recordId?, error? }
   */
  async sendSignedRequest(method, url, body) {
    let headers = { 'Content-Type': 'application/json' };
    if (this.apigAppKey && this.apigAppSecret) {
      const signer = new ApigSigner(this.apigAppKey, this.apigAppSecret);
      headers = signer.sign({
        method: method,
        url: url,
        headers: headers,
        body: body
      });
    }

    try {
      const response = await axios.post(url, body, {
        headers,
        timeout: this.timeout,
      });
      const resData = response.data;

      // DataResult 响应格式：{ code, msg, data }，code=200 表示业务成功
      if (resData?.code !== 200) {
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
      if (error.code === 'ECONNABORTED') {
        console.error(`Upload timeout after ${this.timeout}ms, URL: ${url}`);
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        console.error(`Connection failed: ${error.code}, URL: ${url}`);
      } else if (error.response) {
        console.error(`HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error(`Upload error: ${error.code || error.message}, URL: ${url}`);
      }
      const resData = error.response?.data;
      const errorMsg = resData?.msg || resData?.message || error.message;
      return { success: false, error: errorMsg };
    }
  }
}

module.exports = CoderepoUploader;
