const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BaseDetector = require('./BaseDetector');
const FileCollector = require('../utils/fileCollector');

class DuplicationDetector extends BaseDetector {
  constructor(config = {}) {
    super(config);
    // 与华为云 cmetrics 官方定义对齐："非空非注释行连续 10 行相同的代码片段是重复代码"
    // - minLines=10：连续源代码行至少 10 行才算一次重复
    this.minLines = config.minLines || 10;
    this.allowedExtensions = config.allowedExtensions || [];
  }

  async detect(source, codeScale = null) {
    // 支持单个路径或多个路径
    const sources = Array.isArray(source) ? source : [source];
    const excludeDirs = this.config.excludeDirs || [];

    // 相对路径基准：优先用 git 仓库根目录，确保返回的是仓库根的相对全路径
    // （source-dir 可能是子目录，用 sources 做基准会把子目录前缀也剥掉，只剩文件名）
    const gitRoot = this.findGitRoot(sources[0]);
    const pathBase = gitRoot ? [gitRoot] : sources;

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

    // 行级跨文件匹配（与 cmetrics 官方定义对齐："非空非注释行连续 10 行相同"）
    const lineResult = this.detectWithLineLevel(uniqueFiles, fileSourceLineMaps, fileContents);
    // 使用 let 声明：buildContextSegments 会返回带 snapshotData 的新 fileDetails
    let fileDetails = this.calculateFileDetailsFromLines(
        lineResult.fileDuplicatedLines, fileSourceLineMaps, pathBase);
    // 从合并区间构建重复块出现位置（union-find 分组，自动去重）
    const duplicationOccurrences = this.buildDuplicationOccurrences(
        lineResult.fileRanges, lineResult.fileSeedHashes, lineResult.fileSourceLines,
        fileContents, pathBase);

    // 为有重复的文件构建上下文片段快照（重复块±5行），挂到 fileDetail.snapshotData
    fileDetails = this.buildContextSegments(fileDetails, duplicationOccurrences, fileContents, pathBase);

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
    const identicalFileDetails = this.calculateIdenticalFileDetails(fileContents, pathBase);

    return {
      totalCodeDuplicationRate: duplicationRate,
      totalFileDuplicationRate: fileDuplicationRate,
      duplicatedLines: duplicatedLines,
      totalLines: denominator,
      duplicatedFiles: identicalFileCount,
      totalFiles: uniqueFiles.length,
      fileDetails: fileDetails,
      identicalFileDetails: identicalFileDetails,
      // 重复块出现位置列表（同一代码内容的所有出现位置归为同一 group_id），供后端入库 code_metrics_duplication_block
      duplicationOccurrences: duplicationOccurrences
    };
  }

  /**
   * 行级跨文件重复检测（主路径）
   * 与华为云 cmetrics 官方定义对齐："非空非注释行连续 10 行相同的代码片段是重复代码"
   *
   * 算法：
   * 1. 提取每个文件的源代码行（非空非注释，含 import 行），保留原始行号
   * 2. 10 源代码行滑动窗口，md5 哈希每个窗口
   * 3. 同一 hash 有 2+ 个窗口即计为重复（含同文件内重复）
   * 4. 标记所有被匹配窗口覆盖的源代码行索引
   * 5. 合并连续的源代码行索引为最大区间 → 每个区间是一个重复块出现位置
   *
   * 相比 token 级窗口的优势：
   * - 按行对齐，30 行连续重复只产生 1 个块（而非多个 19 行碎片）
   * - 合并后同一 (file, startLine, endLine) 只产生一条记录（避免重复入库）
   *
   * @param {string[]} files 文件绝对路径列表
   * @param {Map} fileSourceLineMaps 每个文件的源代码行 map（用于兼容 calculateFileDetailsFromLines）
   * @param {Map} fileContents file(原始路径) → 内容
   * @returns {Object} {fileDuplicatedLines, fileRanges, fileSeedHashes, fileSourceLines}
   */
  detectWithLineLevel(files, fileSourceLineMaps, fileContents) {
    const WINDOW_SIZE = this.minLines; // 10

    // Step 1: 提取每个文件的源代码行（非空非注释），保留原始行号
    const fileSourceLines = new Map();
    for (const file of files) {
      const content = fileContents.get(file);
      if (!content) continue;
      const lines = content.split('\n');
      const sourceLines = [];
      for (let i = 0; i < lines.length; i++) {
        if (DuplicationDetector.isSourceLine(lines[i])) {
          sourceLines.push({ lineNum: i + 1, text: lines[i].trim() });
        }
      }
      fileSourceLines.set(file.replace(/\\/g, '/'), sourceLines);
    }

    // Step 2: 10 源代码行滑动窗口，md5 哈希
    const hashToWindows = new Map();
    for (const [normalizedFile, sourceLines] of fileSourceLines) {
      if (sourceLines.length < WINDOW_SIZE) continue;
      for (let i = 0; i <= sourceLines.length - WINDOW_SIZE; i++) {
        const windowText = sourceLines.slice(i, i + WINDOW_SIZE)
          .map(l => l.text).join('\n');
        const hash = crypto.createHash('md5').update(windowText).digest('hex');
        if (!hashToWindows.has(hash)) hashToWindows.set(hash, []);
        hashToWindows.get(hash).push({
          file: normalizedFile,
          startIdx: i,
          endIdx: i + WINDOW_SIZE - 1
        });
      }
    }

    // Step 3: 标记重复行 + 收集 seed hash
    const fileDuplicatedLines = new Map();
    const fileDuplicatedSourceIdx = new Map();
    const fileSeedHashes = new Map();

    for (const [hash, windows] of hashToWindows) {
      if (windows.length < 2) continue;

      for (const win of windows) {
        const sourceLines = fileSourceLines.get(win.file);
        if (!sourceLines) continue;

        if (!fileDuplicatedLines.has(win.file)) fileDuplicatedLines.set(win.file, new Set());
        if (!fileDuplicatedSourceIdx.has(win.file)) fileDuplicatedSourceIdx.set(win.file, new Set());
        if (!fileSeedHashes.has(win.file)) fileSeedHashes.set(win.file, new Map());

        const lineSet = fileDuplicatedLines.get(win.file);
        const idxSet = fileDuplicatedSourceIdx.get(win.file);
        const seedMap = fileSeedHashes.get(win.file);

        for (let i = win.startIdx; i <= win.endIdx; i++) {
          idxSet.add(i);
          lineSet.add(sourceLines[i].lineNum);
          if (!seedMap.has(i)) seedMap.set(i, new Set());
          seedMap.get(i).add(hash);
        }
      }
    }

    // Step 4: 合并连续源代码行索引为最大区间
    const fileRanges = new Map();
    for (const [file, idxSet] of fileDuplicatedSourceIdx) {
      const sortedIndices = [...idxSet].sort((a, b) => a - b);
      const sourceLines = fileSourceLines.get(file);
      const ranges = [];
      let rangeStart = sortedIndices[0];
      let rangeEnd = sortedIndices[0];
      for (let i = 1; i < sortedIndices.length; i++) {
        if (sortedIndices[i] === rangeEnd + 1) {
          rangeEnd = sortedIndices[i];
        } else {
          ranges.push({ startIdx: rangeStart, endIdx: rangeEnd });
          rangeStart = sortedIndices[i];
          rangeEnd = sortedIndices[i];
        }
      }
      ranges.push({ startIdx: rangeStart, endIdx: rangeEnd });

      fileRanges.set(file, ranges.map(r => ({
        startIdx: r.startIdx,
        endIdx: r.endIdx,
        startLine: sourceLines[r.startIdx].lineNum,
        endLine: sourceLines[r.endIdx].lineNum
      })));
    }

    return { fileDuplicatedLines, fileRanges, fileSeedHashes, fileSourceLines };
  }

  /**
   * 把行级匹配得到的「文件→重复行号集合」转为 fileDetails 数组（Step 5）
   * - 过滤为源代码行（剔除空行/注释行）
   * - 只含有重复的文件入 fileDetails（无重复文件由 sloc 基础记录覆盖）
   */
  calculateFileDetailsFromLines(fileDuplicatedLines, fileSourceLineMaps, sources) {
    const fileDetails = [];
    for (const [file, lineSet] of fileDuplicatedLines) {
      // 兼容路径分隔符：detectWithLineLevel 内部统一用 '/'，fileSourceLineMaps 的 key 是原始路径
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

  // 将绝对路径转为相对路径
  // 修复前缀匹配问题：/repo 会误匹配 /repo-other/test.py，需确保 src 是路径分隔符边界
  toRelativePath(absolutePath, sources) {
    if (!sources || sources.length === 0) {
      return absolutePath.replace(/\\/g, '/');
    }
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    for (const src of sources) {
      const normalizedSrc = src.replace(/\\/g, '/').replace(/\/+$/, ''); // 去掉尾部斜杠
      // 精确前缀匹配：src 后必须跟 / 或恰好等于完整路径
      if (normalizedPath === normalizedSrc
          || normalizedPath.startsWith(normalizedSrc + '/')) {
        return path.relative(src, absolutePath).replace(/\\/g, '/');
      }
    }
    return absolutePath.replace(/\\/g, '/');
  }

  /**
   * 从起始目录向上查找 git 仓库根目录（包含 .git 的目录）
   * .git 既可能是目录（普通仓库）也可能是文件（worktree/submodule）
   * @param {string} startDir 起始目录
   * @returns {string|null} 仓库根目录绝对路径，找不到返回 null
   */
  findGitRoot(startDir) {
    let cur = path.resolve(startDir);
    const root = path.parse(cur).root;
    for (let i = 0; i < 8 && cur && cur !== root; i++) {
      if (fs.existsSync(path.join(cur, '.git'))) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  }

  // 计算完全一致文件的详情（用于总文件重复率下钻）
  // 只在文件内容完全一致（MD5相同）时才认为是重复文件
  // 对于一组重复文件 A、B、C，只生成一条记录，duplicatedFiles 包含组内所有文件（含原始文件）
  // 前端将同一组的所有文件展示在一起，无需区分"原始文件"和"重复副本"
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

      // 每组只生成一条记录，duplicatedFiles 包含组内所有文件（含原始文件）
      // 前端展示时将同一组的所有文件列在一起，不再双向展示
      const duplicatedFiles = files.map(f => this.toRelativePath(f, sources));

      details.push({
        duplicatedFiles: duplicatedFiles
      });
    }

    return details;
  }

  /**
   * 从行级检测的合并区间构建重复块出现位置列表（主路径）
   *
   * 分组策略（union-find）：
   * - 不同文件中的区间如果共享至少一个 seed hash（即某个 10 行窗口在两个区间中都出现），则归为同一组
   * - 同一文件内的多个不连续区间属于不同组（除非通过其他文件的区间桥接）
   * - 同一 (file, startLine, endLine) 跨多个 hash 时只产生一条记录（去重）
   *
   * @param {Map} fileRanges file → [{startIdx, endIdx, startLine, endLine}]
   * @param {Map} fileSeedHashes file → Map<sourceIdx, Set<hash>>
   * @param {Map} fileSourceLines file → [{lineNum, text}]
   * @param {Map} fileContents file(原始路径) → 内容
   * @param {string[]} sources 源目录列表
   * @returns {Array} duplicationOccurrences 列表
   */
  buildDuplicationOccurrences(fileRanges, fileSeedHashes, fileSourceLines, fileContents, sources) {
    // 收集所有区间，建立全局索引
    const allRanges = [];
    for (const [file, ranges] of fileRanges) {
      for (const range of ranges) {
        allRanges.push({ file, ...range });
      }
    }
    if (allRanges.length === 0) return [];

    // 为每个区间收集其覆盖的所有 seed hash
    const rangeHashSets = allRanges.map(range => {
      const seedMap = fileSeedHashes.get(range.file);
      const hashes = new Set();
      for (let idx = range.startIdx; idx <= range.endIdx; idx++) {
        const h = seedMap.get(idx);
        if (h) for (const x of h) hashes.add(x);
      }
      return hashes;
    });

    // 建立 hash → [rangeIndex] 的倒排索引
    const hashToRangeIndices = new Map();
    for (let i = 0; i < allRanges.length; i++) {
      for (const h of rangeHashSets[i]) {
        if (!hashToRangeIndices.has(h)) hashToRangeIndices.set(h, []);
        hashToRangeIndices.get(h).push(i);
      }
    }

    // Union-Find：共享 seed hash 的区间归为同一组
    const parent = allRanges.map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (x, y) => {
      const px = find(x), py = find(y);
      if (px !== py) parent[px] = py;
    };

    for (const [, indices] of hashToRangeIndices) {
      for (let i = 1; i < indices.length; i++) {
        union(indices[0], indices[i]);
      }
    }

    // 按 root 分组
    const groups = new Map();
    for (let i = 0; i < allRanges.length; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }

    // 为每组构建 occurrences
    const occurrences = [];
    for (const [, indices] of groups) {
      // 2+ 个出现位置才算重复
      if (indices.length < 2) continue;

      const groupRanges = indices.map(i => allRanges[i]);

      // 按 (filePath, startLine) 排序，occurrenceIndex 从 0 递增
      groupRanges.sort((a, b) => {
        const relA = this.toRelativePath(a.file, sources);
        const relB = this.toRelativePath(b.file, sources);
        if (relA !== relB) return relA.localeCompare(relB);
        return a.startLine - b.startLine;
      });

      // 提取第一个出现位置的内容，计算 contentHash/groupId（SHA-256）
      const first = groupRanges[0];
      const firstContent = this.extractBlockContent(
          first.file, first.startLine, first.endLine, fileContents);
      const contentHash = crypto.createHash('sha256').update(firstContent).digest('hex');

      for (let i = 0; i < groupRanges.length; i++) {
        const range = groupRanges[i];
        const content = (i === 0)
            ? firstContent
            : this.extractBlockContent(range.file, range.startLine, range.endLine, fileContents);
        occurrences.push({
          groupId: contentHash,
          contentHash: contentHash,
          occurrenceIndex: i,
          filePath: this.toRelativePath(range.file, sources),
          startLine: range.startLine,
          endLine: range.endLine,
          content: content
        });
      }
    }

    return occurrences;
  }

  /**
   * 提取文件中指定行号区间的代码内容
   *
   * @param {string} file 文件路径（可能是正斜杠或反斜杠格式）
   * @param {number} startLine 起始行（1-based）
   * @param {number} endLine 结束行（1-based）
   * @param {Map} fileContents file(原始路径) → 内容
   * @returns {string} 代码内容，找不到文件时返回空字符串
   */
  extractBlockContent(file, startLine, endLine, fileContents) {
    // 兼容路径分隔符：fileContents 的 key 是原始路径（Windows 下含反斜杠）
    const content = fileContents.get(file)
        || fileContents.get(file.replace(/\//g, '\\'));
    if (!content) return '';
    const lines = content.split('\n');
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    return lines.slice(start, end).join('\n');
  }

  /**
   * 合并重叠/相邻的行号区间
   *
   * @param {Array} intervals [{startLine, endLine}]
   * @param {boolean} mergeAdjacent 是否合并相邻区间（间隔 ≤1 行），默认 true。
   *   重复块本身合并传 true（相邻重复块视为一个连续重复区域）；
   *   扩展 ±contextLines 后的区间合并传 false（只有真正重叠才合并，避免上下文过长）。
   * @returns {Array} 合并后的区间列表（按 startLine 排序）
   */
  mergeIntervals(intervals, mergeAdjacent = true) {
    if (intervals.length === 0) return [];
    const sorted = intervals.slice().sort((a, b) => a.startLine - b.startLine);
    const merged = [{ startLine: sorted[0].startLine, endLine: sorted[0].endLine }];
    // mergeAdjacent=true: 间隔 ≤1 行也合并；false: 只有真正重叠（startLine ≤ last.endLine）才合并
    const overlapThreshold = mergeAdjacent ? 1 : 0;
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      if (sorted[i].startLine <= last.endLine + overlapThreshold) {
        last.endLine = Math.max(last.endLine, sorted[i].endLine);
      } else {
        merged.push({ startLine: sorted[i].startLine, endLine: sorted[i].endLine });
      }
    }
    return merged;
  }

  /**
   * 为有重复的文件构建上下文片段快照（重复块±5行），挂到 fileDetail.snapshotData。
   * 不读取/上报完整文件内容，其他部分由前端用 "... N lines omitted ..." 占位。
   *
   * snapshotData 结构（整体 Base64 编码）：
   * {
   *   totalLines: 原始文件总行数,
   *   contextLines: 上下文行数(5),
   *   segments: [{originalStartLine, originalEndLine, contentB64}]
   *   // 每个 segment 的 contentB64 为该片段代码内容再次 Base64 编码
   * }
   *
   * @param {Array} fileDetails 文件明细列表
   * @param {Array} duplicationOccurrences 重复块出现位置列表
   * @param {Map} fileContents file(原始路径) → 内容
   * @param {string[]} sources 源目录列表
   * @param {number} contextLines 上下文行数，默认 5
   * @returns {Array} 更新后的 fileDetails（每个有重复的 fileDetail 增加 snapshotData 字段）
   */
  buildContextSegments(fileDetails, duplicationOccurrences, fileContents, sources, contextLines = 5) {
    if (!duplicationOccurrences || duplicationOccurrences.length === 0) {
      return fileDetails;
    }

    // 按 filePath 分组出现位置，得到每个文件的重复块区间
    const blocksByFile = new Map(); // relativePath → [{startLine, endLine}]
    for (const occ of duplicationOccurrences) {
      if (!blocksByFile.has(occ.filePath)) blocksByFile.set(occ.filePath, []);
      blocksByFile.get(occ.filePath).push({ startLine: occ.startLine, endLine: occ.endLine });
    }

    // 构建 relativePath → content 的映射，便于按 fileDetail.filePath 查找
    const relativeToContent = new Map();
    for (const [absPath, content] of fileContents) {
      relativeToContent.set(this.toRelativePath(absPath, sources), content);
    }

    for (const fileDetail of fileDetails) {
      // 只有有重复的文件才生成快照
      if (!fileDetail.duplicationLineCount || fileDetail.duplicationLineCount === 0) continue;

      const blocks = blocksByFile.get(fileDetail.filePath);
      if (!blocks || blocks.length === 0) continue;

      // 1. 合并重叠的重复块区间
      const mergedBlocks = this.mergeIntervals(blocks);

      // 2. 每个合并后的块扩展 ±contextLines，再次合并重叠的扩展区间
      //    传 mergeAdjacent=false：只有真正重叠才合并，避免相邻重复块的上下文被合并成大区间
      const extended = mergedBlocks.map(b => ({
        startLine: Math.max(1, b.startLine - contextLines),
        endLine: b.endLine + contextLines
      }));
      const mergedExtended = this.mergeIntervals(extended, false);

      // 3. 获取文件内容和总行数
      const content = relativeToContent.get(fileDetail.filePath);
      if (!content) continue;
      const lines = content.split('\n');
      const totalLines = lines.length;

      // 4. 构建 segments
      const segments = [];
      for (const interval of mergedExtended) {
        const start = Math.max(1, interval.startLine);
        const end = Math.min(totalLines, interval.endLine);
        const segmentContent = lines.slice(start - 1, end).join('\n');
        // 每个片段的 contentB64 内部再次 Base64 编码
        const contentB64 = Buffer.from(segmentContent, 'utf8').toString('base64');
        segments.push({
          originalStartLine: start,
          originalEndLine: end,
          contentB64: contentB64
        });
      }

      // 5. 构建 snapshotData JSON 并整体 Base64 编码
      const snapshotDataObj = {
        totalLines: totalLines,
        contextLines: contextLines,
        segments: segments
      };
      const snapshotJson = JSON.stringify(snapshotDataObj);
      fileDetail.snapshotData = Buffer.from(snapshotJson, 'utf8').toString('base64');
    }

    return fileDetails;
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
      identicalFileDetails: [],
      duplicationOccurrences: []
    };
  }

  getName() {
    return 'duplication';
  }
}

module.exports = DuplicationDetector;
