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
  }

  async upload(metricsData, options = {}) {
    // 从 metricsData 中分离出 fileDetails、identicalFileDetails 和总体指标
    const { fileDetails, identicalFileDetails, ...overallMetrics } = metricsData;

    const payload = {
      gitUrl: options.gitUrl,
      branchName: options.branchName,
      repository: options.repository,
      pipelineRunId: options.pipelineRunId,
      runNumber: options.runNumber,
      metricsData: overallMetrics,
      fileDetails: fileDetails || [],
      identicalFileDetails: identicalFileDetails || [],
      detectionStartedAt: options.startTime,
      detectionCompletedAt: options.endTime,
      status: options.status || 0
    };

    if (options.errorMessage) {
      payload.errorMessage = options.errorMessage;
    }

    const body = JSON.stringify(payload);
    // 拼接请求 URL：baseUrl 已包含 /openlibing-coderepo 前缀，追加 /metrics/code/report
    // 不使用 new URL() 构造，避免路径拼接歧义
    const url = this.baseUrl.replace(/\/+$/, '') + '/openlibing-coderepo/metrics/code/report';

    // 使用 APIG 签名认证（SDK-HMAC-SHA256），替代原 AppCode 方式
    let headers = { 'Content-Type': 'application/json' };
    if (this.apigAppKey && this.apigAppSecret) {
      const signer = new ApigSigner(this.apigAppKey, this.apigAppSecret);
      headers = signer.sign({
        method: 'POST',
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
