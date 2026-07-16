const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BaseDetector = require('./BaseDetector');
const FileCollector = require('../utils/fileCollector');

class DuplicationDetector extends BaseDetector {
  constructor(config = {}) {
    super(config);
    // 与华为云 cmetrics 官方定义对齐："连续超过 10 行代码块在其他地方重复记为一次重复"
    // - minLines=10：连续代码块至少 10 行才算一次重复
    // - minTokens=85：滑动窗口大小
    this.minLines = config.minLines || 10;
    this.minTokens = config.minTokens || 85;
    this.allowedExtensions = config.allowedExtensions || [];
  }

  async detect(source, codeScale = null) {
    // 支持单个路径或多个路径
    const sources = Array.isArray(source) ? source : [source];
    const excludeDirs = this.config.excludeDirs || [];

    // 收集所有文件
    const allFiles = [];
    for (const src of sources) {
      const files = FileCollector.collectFiles(src, excludeDirs, this.allowedExtensions);
      allFiles.push(...files);
    }
    const uniqueFiles = [...new Set(allFiles)];

    if (uniqueFiles.length === 0) {
      return this.getEmptyResult();
    }

    const fileContents = new Map();
    const fileSourceLineMaps = new Map();
    let totalSourceLines = 0;
    for (const file of uniqueFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        fileContents.set(file, content);
        const sourceLineMap = this.buildSourceLineMap(content);
        fileSourceLineMaps.set(file, sourceLineMap);
        totalSourceLines += sourceLineMap.sourceCount;
      } catch (error) {
        console.warn(`[WARN] Failed to read file ${file}: ${error.message}`);
      }
    }

    // Token 级跨文件匹配（与 cmetrics 官方定义对齐："连续超过 10 行代码块在其他地方重复记为一次重复"）
    // 失败时降级到 jscpd 引擎
    let fileDetails;
    try {
      const fileDuplicatedLines = this.detectWithTokenLevel(uniqueFiles, fileSourceLineMaps);
      fileDetails = this.calculateFileDetailsFromLines(fileDuplicatedLines, fileSourceLineMaps, sources);
    } catch (error) {
      console.warn(`Token-level detection failed, falling back to jscpd: ${error.message}`);
      const jscpdResult = await this.detectWithJscpd(uniqueFiles, fileSourceLineMaps);
      fileDetails = this.calculateFileDuplicationDetails(
        jscpdResult.clones || [],
        fileSourceLineMaps,
        sources
      );
    }
    const duplicatedLines = fileDetails.reduce((sum, d) => sum + d.duplicationLineCount, 0);

    // 分母：优先用传入的 codeScale（与 cmetrics 和华为云保持一致）
    // 如果没有 codeScale，则用本地统计的源代码行总数
    const denominator = codeScale || totalSourceLines;

    const duplicationRate = denominator > 0
      ? parseFloat(((duplicatedLines / denominator) * 100).toFixed(2))
      : 0;

    // 完全一致文件计数（用于总文件重复率）
    const identicalFileCount = this.calculateFileDuplication(fileContents);
    const fileDuplicationRate = uniqueFiles.length > 0
      ? parseFloat(((identicalFileCount / uniqueFiles.length) * 100).toFixed(2))
      : 0;

    // 计算完全一致文件的详情（用于总文件重复率下钻）
    const identicalFileDetails = this.calculateIdenticalFileDetails(fileContents, sources);

    return {
      totalCodeDuplicationRate: duplicationRate,
      totalFileDuplicationRate: fileDuplicationRate,
      duplicatedLines: duplicatedLines,
      totalLines: denominator,
      duplicatedFiles: identicalFileCount,
      totalFiles: uniqueFiles.length,
      fileDetails: fileDetails,
      identicalFileDetails: identicalFileDetails
    };
  }

  /**
   * Token 级跨文件重复检测（主路径）
   * 与华为云 cmetrics 官方定义对齐："连续超过 10 行代码块在其他地方重复记为一次重复"
   * - 用 jscpd tokenizer 分词，mild 模式过滤空行/分隔 token
   * - 滑动窗口（size=minTokens）+ md5 哈希找跨文件匹配
   * - 每个匹配 window 标记其覆盖的行号（loc.start.line），用 Set 去重
   * - 不在 window 级别应用 minLines 过滤：
   *   Java import 区一行 7+ token，30 token 窗口只跨 5 行，但实际属于更大的 40+ 行匹配块
   *   window 的并集自然反映整个大块的覆盖范围；minTokens=30 已保证最小匹配大小
   *
   * @param {string[]} files 文件绝对路径列表
   * @param {Map<string, {lineMap, sourceCount}>} fileSourceLineMaps 每个文件的源代码行 map
   * @returns {Map<string, Set<number>>} 每个文件的重复行号集合
   */
  detectWithTokenLevel(files, fileSourceLineMaps) {
    const { tokenize, getFormatByFile } = require('@jscpd/tokenizer');
    const { mild } = require('@jscpd/core');

    // Step 1+2: 分词 + 滑动窗口哈希
    const WINDOW_SIZE = this.minTokens;
    const fileTokens = new Map();      // file(正斜杠) → IToken[]（已 mild 过滤）
    const hashToLocations = new Map(); // hash → [{file, startIdx, endIdx}]

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const format = getFormatByFile(path.basename(file));
      if (!format) continue;

      // mild 谓词过滤：剔除 type ∈ {ignore, empty, new_line} 的 token
      // 保留 comment token（license header 等参与匹配）
      const tokens = tokenize(content, format).filter(t => mild(t));
      if (tokens.length < WINDOW_SIZE) continue;
      const normalizedFile = file.replace(/\\/g, '/');
      fileTokens.set(normalizedFile, tokens);

      for (let i = 0; i <= tokens.length - WINDOW_SIZE; i++) {
        // 拼接 window 内 token 的 type:value，md5 哈希
        // 含 type 是为了避免不同语法结构的 token 序列误匹配（如 "int x" vs "x int"）
        let signature = '';
        for (let j = i; j < i + WINDOW_SIZE; j++) {
          if (j > i) signature += '\u0001';  // SOH 控制字符作分隔符
          signature += `${tokens[j].type}:${tokens[j].value}`;
        }
        const hash = crypto.createHash('md5').update(signature).digest('hex');

        if (!hashToLocations.has(hash)) hashToLocations.set(hash, []);
        hashToLocations.get(hash).push({
          file: normalizedFile,
          startIdx: i,
          endIdx: i + WINDOW_SIZE - 1
        });
      }
    }

    // Step 3: 跨文件匹配 + 标记行号
    const fileDuplicatedLines = new Map();

    for (const [, locations] of hashToLocations) {
      // 只在 2+ 不同文件出现才计为重复（对齐 cmetrics "在其他地方重复"）
      // 同文件多次出现不算（如 OWASP Benchmark 文件内部多个相同 catch 块属代码结构问题）
      const uniqueFiles = new Set(locations.map(l => l.file));
      if (uniqueFiles.size < 2) continue;

      // 该 hash 在 2+ 文件出现：所有出现的 file 都标记行号（A 侧和 B 侧都标）
      for (const loc of locations) {
        const tokens = fileTokens.get(loc.file);
        if (!fileDuplicatedLines.has(loc.file)) {
          fileDuplicatedLines.set(loc.file, new Set());
        }
        const lineSet = fileDuplicatedLines.get(loc.file);
        // 标记 window 内每个 token 的 loc.start.line（Set 自动去重）
        for (let i = loc.startIdx; i <= loc.endIdx; i++) {
          const token = tokens[i];
          if (token.loc && token.loc.start) {
            lineSet.add(token.loc.start.line);
          }
        }
      }
    }

    return fileDuplicatedLines;
  }

  /**
   * 把 token 级匹配得到的「文件→重复行号集合」转为 fileDetails 数组（Step 5）
   * - 过滤为源代码行（剔除空行/注释行）
   * - 只含有重复的文件入 fileDetails（无重复文件由 sloc 基础记录覆盖）
   */
  calculateFileDetailsFromLines(fileDuplicatedLines, fileSourceLineMaps, sources) {
    const fileDetails = [];
    for (const [file, lineSet] of fileDuplicatedLines) {
      // 兼容路径分隔符：detectWithTokenLevel 内部统一用 '/'，fileSourceLineMaps 的 key 是原始路径
      const sourceLineMap = fileSourceLineMaps.get(file)
        || fileSourceLineMaps.get(file.replace(/\//g, '\\'));
      if (!sourceLineMap) continue;

      // 过滤为源代码行（剔除空行/注释行），与 cmetrics "代码行" 定义一致
      let duplicatedSourceLines = 0;
      for (const lineNum of lineSet) {
        if (sourceLineMap.lineMap.get(lineNum)) {
          duplicatedSourceLines++;
        }
      }
      if (duplicatedSourceLines === 0) continue;  // 全是注释/空行：不入 fileDetails

      const totalFileSourceLines = sourceLineMap.sourceCount;
      const duplicationRate = totalFileSourceLines > 0
        ? parseFloat(((duplicatedSourceLines / totalFileSourceLines) * 100).toFixed(2))
        : 0;

      fileDetails.push({
        filePath: this.toRelativePath(file, sources),
        duplicationRate,
        duplicationLineCount: duplicatedSourceLines
      });
    }
    return fileDetails;
  }

  /**
   * 使用 jscpd 核心引擎检测代码重复（fallback）
   * - 绕过 jscpd 的 finder 模块（Windows 路径 bug），直接用 FileCollector 收集文件
   * - mild 模式：忽略空行和空白 token，保留注释 token
   * - 只保留跨文件 clone（排除同文件内重复）
   */
  async detectWithJscpd(files, fileSourceLineMaps) {
    try {
      const core = require('@jscpd/core');
      const { Tokenizer, getFormatByFile, getSupportedFormats } = require('@jscpd/tokenizer');
      const { InFilesDetector } = require('@jscpd/finder');

      const entries = [];
      for (const file of files) {
        if (typeof file !== 'string') {
          console.warn(`[WARN] Invalid file path type: ${typeof file}, skipping`);
          continue;
        }
        const content = fs.readFileSync(file, 'utf8');
        const format = getFormatByFile(path.basename(file));
        if (!format) {
          console.warn(`[WARN] Unsupported file format: ${file}`);
          continue;
        }
        entries.push({
          id: file.replace(/\\/g, '/'),
          content: content,
          format: format,
          path: file.replace(/\\/g, '/'),
          lines: content.split('\n').length
        });
      }

      if (entries.length === 0) {
        return { rate: 0, duplicatedLines: 0, totalLines: 0, clones: [] };
      }

      // 使用 mild 模式以包含 import 行（strict 会过滤掉 import）
      // minLines=10 对齐华为云 cmetrics 官方定义
      const options = Object.assign({}, core.getDefaultOptions(), {
        minLines: this.minLines,
        minTokens: this.minTokens,
        mode: core.mild,
        format: getSupportedFormats(),
        silent: true,
        hashFunction: (value) => crypto.createHash('md5').update(value).digest('hex')
      });

      const store = new core.MemoryStore();
      const statistic = new core.Statistic();
      const tokenizer = new Tokenizer();
      const detector = new InFilesDetector(tokenizer, store, statistic, options);

      const clones = await detector.detect(entries);
      const stats = statistic.getStatistic();
      const totalLines = stats.total.lines || 0;

      // 单文件维度：排除同文件内重复（self-clones，dA.sourceId === dB.sourceId）
      // 与 cmetrics "在其他地方重复"对齐：只统计跨文件重复
      const crossFileClones = [];
      for (const clone of clones) {
        const dA = clone.duplicationA;
        const dB = clone.duplicationB;
        if (!dA || !dB || !dA.start || !dA.end || !dB.start || !dB.end) continue;
        if (dA.sourceId === dB.sourceId) continue;
        crossFileClones.push(clone);
      }

      // 总体 duplicatedLines：用 sum(min(A,B)) 近似 cmetrics token-level 算法
      // jscpd 把相邻 token 合并成大 clone 区间，A 和 B 行数可能严重不一致
      //（如 A=131 行 ↔ B=49 行，A 中夹了 82 行不匹配的中间行）
      let totalMatchLines = 0;
      for (const clone of crossFileClones) {
        const dA = clone.duplicationA;
        const dB = clone.duplicationB;
        const aLineCount = dA.end.line - dA.start.line + 1;
        const bLineCount = dB.end.line - dB.start.line + 1;
        totalMatchLines += Math.min(aLineCount, bLineCount);
      }

      store.close();
      return { rate: 0, duplicatedLines: totalMatchLines, totalLines, clones: crossFileClones };
    } catch (error) {
      console.warn(`jscpd engine failed, falling back to line-level detection: ${error.message}`);

      // 回退到行级检测
      try {
        const lineResult = this.calculateLineDuplication(fileSourceLineMaps);
        return { rate: 0, duplicatedLines: lineResult, totalLines: 0, clones: [] };
      } catch (fallbackError) {
        console.warn(`Fallback also failed: ${fallbackError.message}`);
        return { rate: 0, duplicatedLines: 0, totalLines: 0, clones: [] };
      }
    }
  }

  // 行级重复检测（fallback 的 fallback）
  calculateLineDuplication(fileSourceLineMaps) {
    const blockMap = new Map();

    for (const [file, content] of fileSourceLineMaps.entries()) {
      const rawContent = fs.readFileSync(file, 'utf8');
      const lines = rawContent.split('\n');
      for (let i = 0; i <= lines.length - this.minLines; i++) {
        const block = lines.slice(i, i + this.minLines)
          .map(l => l.trim())
          .join('\n');

        if (block.replace(/\n/g, '').length < this.minTokens) continue;

        const hash = crypto.createHash('md5').update(block).digest('hex');
        if (!blockMap.has(hash)) blockMap.set(hash, []);
        blockMap.get(hash).push({ file, startLine: i + 1 });
      }
    }

    const processedSourceLines = new Map();
    for (const [hash, locations] of blockMap) {
      if (locations.length > 1) {
        for (let idx = 1; idx < locations.length; idx++) {
          const loc = locations[idx];
          if (!processedSourceLines.has(loc.file)) processedSourceLines.set(loc.file, new Set());
          const fileLines = processedSourceLines.get(loc.file);
          const sourceLineMap = fileSourceLineMaps.get(loc.file);
          for (let line = loc.startLine; line < loc.startLine + this.minLines; line++) {
            if (sourceLineMap && sourceLineMap.lineMap.get(line)) fileLines.add(line);
          }
        }
      }
    }

    let duplicatedSourceLines = 0;
    for (const fileLines of processedSourceLines.values()) {
      duplicatedSourceLines += fileLines.size;
    }

    return duplicatedSourceLines;
  }

  static isSourceLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    if (trimmed.startsWith('#')) return false;
    if (trimmed.startsWith('//')) return false;
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) return false;
    return true;
  }

  buildSourceLineMap(content) {
    const lines = content.split('\n');
    const lineMap = new Map();
    let sourceCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const isSource = DuplicationDetector.isSourceLine(lines[i]);
      lineMap.set(i + 1, isSource);
      if (isSource) sourceCount++;
    }
    return { lineMap, sourceCount };
  }

  calculateFileDuplication(fileContents) {
    const hashCount = new Map();
    for (const content of fileContents.values()) {
      const normalized = content.trim();
      const hash = crypto.createHash('md5').update(normalized).digest('hex');
      if (!hashCount.has(hash)) hashCount.set(hash, 0);
      hashCount.set(hash, hashCount.get(hash) + 1);
    }

    let identicalFileCount = 0;
    for (const count of hashCount.values()) {
      if (count > 1) identicalFileCount += count;
    }
    return identicalFileCount;
  }

  // 计算每个文件的重复率和重复行数（fallback 路径用，主路径走 calculateFileDetailsFromLines）
  // 单文件维度算法（与 cmetrics token-level 算法近似对齐）：
  // - jsCPD 把相邻 token 合并成大 clone 区间，A 和 B 行数可能严重不一致
  // - 近似方案：每个 clone 的实际重复行数 = min(A 行数, B 行数)
  //   从 start.line 开始连续数 min 行
  // - 同一文件多个 clone 重叠的行号只算一次（Set 去重）
  calculateFileDuplicationDetails(clones, fileSourceLineMaps, sources) {
    // 收集每个文件的重复行号（A 侧和 B 侧都收集，求并集）
    const fileDuplicatedLines = new Map();

    const getOrCreateSet = (file) => {
      if (!fileDuplicatedLines.has(file)) {
        fileDuplicatedLines.set(file, new Set());
      }
      return fileDuplicatedLines.get(file);
    };

    for (const clone of clones) {
      const dA = clone.duplicationA;
      const dB = clone.duplicationB;
      if (!dA || !dB || !dA.start || !dA.end || !dB.start || !dB.end) continue;

      // A 和 B 行数
      const aLineCount = dA.end.line - dA.start.line + 1;
      const bLineCount = dB.end.line - dB.start.line + 1;
      // 实际匹配行数 = min(A, B)，对齐 cmetrics token-level 算法
      const matchLineCount = Math.min(aLineCount, bLineCount);

      // A 侧：从 start.line 开始连续数 matchLineCount 行
      const aSet = getOrCreateSet(dA.sourceId);
      for (let i = 0; i < matchLineCount; i++) {
        aSet.add(dA.start.line + i);
      }
      // B 侧：从 start.line 开始连续数 matchLineCount 行
      const bSet = getOrCreateSet(dB.sourceId);
      for (let i = 0; i < matchLineCount; i++) {
        bSet.add(dB.start.line + i);
      }
    }

    // 计算每个文件的重复率
    const fileDetails = [];
    for (const [file, lineSet] of fileDuplicatedLines) {
      // file 来自 sourceId（jscpd 内部统一正斜杠），fileSourceLineMaps 的 key 是原始路径
      // Windows 下原始路径含反斜杠，需要兼容两种分隔符
      const sourceLineMap = fileSourceLineMaps.get(file)
        || fileSourceLineMaps.get(file.replace(/\//g, '\\'));
      let duplicatedSourceLines = 0;
      if (sourceLineMap) {
        for (const lineNum of lineSet) {
          if (sourceLineMap.lineMap.get(lineNum)) {
            duplicatedSourceLines++;
          }
        }
      }

      const totalFileSourceLines = sourceLineMap ? sourceLineMap.sourceCount : 0;
      const duplicationRate = totalFileSourceLines > 0
        ? parseFloat(((duplicatedSourceLines / totalFileSourceLines) * 100).toFixed(2))
        : 0;

      let filePath = this.toRelativePath(file, sources);

      fileDetails.push({
        filePath: filePath,
        duplicationRate: duplicationRate,
        duplicationLineCount: duplicatedSourceLines
      });
    }

    return fileDetails;
  }

  // 将绝对路径转为相对路径
  toRelativePath(absolutePath, sources) {
    if (!sources || sources.length === 0) {
      return absolutePath.replace(/\\/g, '/');
    }
    for (const src of sources) {
      const normalizedSrc = src.replace(/\\/g, '/');
      const normalizedPath = absolutePath.replace(/\\/g, '/');
      if (normalizedPath.startsWith(normalizedSrc)) {
        return path.relative(src, absolutePath).replace(/\\/g, '/');
      }
    }
    return absolutePath.replace(/\\/g, '/');
  }

  // 计算完全一致文件的详情（用于总文件重复率下钻）
  // 只在文件内容完全一致（MD5相同）时才认为是重复文件
  // 对于一组重复文件 A、B、C，只记录 A 的重复文件列表包含 B 和 C，不反向记录
  calculateIdenticalFileDetails(fileContents, sources) {
    // 按内容哈希分组
    const hashGroups = new Map();
    for (const [file, content] of fileContents) {
      const normalized = content.trim();
      const hash = crypto.createHash('md5').update(normalized).digest('hex');
      if (!hashGroups.has(hash)) {
        hashGroups.set(hash, []);
      }
      hashGroups.get(hash).push(file);
    }

    const details = [];
    for (const [hash, files] of hashGroups) {
      // 只处理有重复的组（2个及以上文件内容一致）
      if (files.length < 2) continue;

      // 将第一个文件作为"原始文件"，其余文件作为"重复副本"
      // 只为重复副本记录 duplicatedFiles，不反向记录
      const originalFile = this.toRelativePath(files[0], sources);
      for (let i = 1; i < files.length; i++) {
        const duplicateFile = this.toRelativePath(files[i], sources);
        // 重复文件的 duplicatedFiles 列表包含原始文件和同组的其他重复文件
        const relatedFiles = [originalFile];
        for (let j = 1; j < files.length; j++) {
          if (j !== i) {
            relatedFiles.push(this.toRelativePath(files[j], sources));
          }
        }

        details.push({
          filePath: duplicateFile,
          duplicatedFiles: relatedFiles
        });
      }
    }

    return details;
  }

  getEmptyResult() {
    return {
      totalCodeDuplicationRate: 0,
      totalFileDuplicationRate: 0,
      duplicatedLines: 0,
      totalLines: 0,
      duplicatedFiles: 0,
      totalFiles: 0,
      fileDetails: [],
      identicalFileDetails: []
    };
  }

  getName() {
    return 'duplication';
  }
}

module.exports = DuplicationDetector;
