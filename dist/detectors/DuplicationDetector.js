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

  async detect(source, slocResult = null) {
    // 支持单个路径或多个路径
    const sources = Array.isArray(source) ? source : [source];
    const excludeDirs = this.config.excludeDirs || [];

    // 相对路径基准：优先用 git 仓库根目录，确保返回的是仓库根的相对全路径
    // （source-dir 可能是子目录，用 sources 做基准会把子目录前缀也剥掉，只剩文件名）
    const gitRoot = this.findGitRoot(sources[0]);
    const pathBase = gitRoot ? [gitRoot] : sources;

    // scc 的总体代码行数（codeScale），作为总重复率的分母
    const codeScale = slocResult ? slocResult.codeScale : null;

    // scc 每个文件的 loc 作为该文件重复率的权威分母，保证与上报的 loc 完全一致
    const locByRel = new Map();
    if (slocResult && Array.isArray(slocResult.fileDetails)) {
      for (const d of slocResult.fileDetails) {
        if (d && d.filePath) locByRel.set(d.filePath, Number(d.loc) || 0);
      }
    }

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
        const sourceLineMap = this.buildSourceLineMap(content, file);
        fileSourceLineMaps.set(file, sourceLineMap);
        totalSourceLines += sourceLineMap.sourceCount;
      } catch (error) {
        console.warn(`[WARN] Failed to read file ${file}: ${error.message}`);
      }
    }

    // 行级跨文件匹配（与 cmetrics 官方定义对齐："非空非注释行连续 10 行相同"）
    const lineResult = this.detectWithLineLevel(uniqueFiles, fileSourceLineMaps);
    // 使用 let 声明：buildContextSegments 会返回带 snapshotData 的新 fileDetails
    let fileDetails = this.calculateFileDetailsFromLines(
        lineResult.fileDuplicatedLines, fileSourceLineMaps, pathBase, locByRel);
    // 从共享滑动窗口构建重复块出现位置（窗口级 union-find 分组，自动去重）
    const duplicationOccurrences = this.buildDuplicationOccurrences(
        lineResult.fileSourceLines, fileContents, pathBase, lineResult.sharedHashWindows);

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
   * @param {Map} fileSourceLineMaps 每个文件的源代码行 map（含 sourceLines，分类口径与 scc 一致）
   * @returns {Object} {fileDuplicatedLines, fileSourceLines, sharedHashWindows}
   */
  detectWithLineLevel(files, fileSourceLineMaps) {
    const WINDOW_SIZE = this.minLines; // 10

    // Step 1: 提取每个文件的源代码行（与 scc 有效代码行语义一致），保留原始行号
    // 直接复用 buildSourceLineMap 已计算好的 sourceLines，避免分类口径不一致
    const fileSourceLines = new Map();
    for (const file of files) {
      const sourceLineMap = fileSourceLineMaps.get(file)
        || fileSourceLineMaps.get(file.replace(/\//g, '\\'));
      if (!sourceLineMap || !sourceLineMap.sourceLines) continue;
      fileSourceLines.set(file.replace(/\\/g, '/'), sourceLineMap.sourceLines);
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

    // Step 3: 标记重复行 + 收集共享 hash 的滑动窗口（供分组使用）
    const fileDuplicatedLines = new Map();
    // 仅含跨 2+ 个窗口的共享 hash：hash -> [{file, startIdx, endIdx}]
    const sharedHashWindows = new Map();

    for (const [hash, windows] of hashToWindows) {
      if (windows.length < 2) continue;
      sharedHashWindows.set(hash, windows);

      for (const win of windows) {
        const sourceLines = fileSourceLines.get(win.file);
        if (!sourceLines) continue;

        if (!fileDuplicatedLines.has(win.file)) fileDuplicatedLines.set(win.file, new Set());

        const lineSet = fileDuplicatedLines.get(win.file);

        for (let i = win.startIdx; i <= win.endIdx; i++) {
          lineSet.add(sourceLines[i].lineNum);
        }
      }
    }

    return { fileDuplicatedLines, fileSourceLines, sharedHashWindows };
  }

  /**
   * 把行级匹配得到的「文件→重复行号集合」转为 fileDetails 数组（Step 5）
   * - 过滤为源代码行（剔除空行/注释行）
   * - 只含有重复的文件入 fileDetails（无重复文件由 sloc 基础记录覆盖）
   */
  calculateFileDetailsFromLines(fileDuplicatedLines, fileSourceLineMaps, sources, locByRel) {
    const fileDetails = [];
    for (const [file, lineSet] of fileDuplicatedLines) {
      // 兼容路径分隔符：detectWithLineLevel 内部统一用 '/'，fileSourceLineMaps 的 key 是原始路径
      const sourceLineMap = fileSourceLineMaps.get(file)
        || fileSourceLineMaps.get(file.replace(/\//g, '\\'));
      if (!sourceLineMap) continue;

      // 分子：仅统计 scc 视为"有效代码行"的重复行（剔除空行/注释/docstring）
      let duplicatedSourceLines = 0;
      for (const lineNum of lineSet) {
        if (sourceLineMap.lineMap.get(lineNum)) {
          duplicatedSourceLines++;
        }
      }
      if (duplicatedSourceLines === 0) continue;  // 全是注释/空行：不入 fileDetails

      // 分母：优先用 scc 每个文件的 loc（与上报的 loc 完全一致），否则回退到本地分类统计
      const filePath = this.toRelativePath(file, sources);
      const sccLoc = locByRel ? locByRel.get(filePath) : undefined;
      const totalFileSourceLines = (sccLoc !== undefined && sccLoc > 0) ? sccLoc : sourceLineMap.sourceCount;
      const duplicationRate = totalFileSourceLines > 0
        ? parseFloat(((duplicatedSourceLines / totalFileSourceLines) * 100).toFixed(2))
        : 0;

      fileDetails.push({
        filePath: filePath,
        duplicationRate,
        duplicationLineCount: duplicatedSourceLines
      });
    }
    return fileDetails;
  }

  // 语言 → 注释/多行字符串规则（与 scc 的"有效代码行"语义对齐）
  // hashIsCode=true：C/C++ 预处理指令（#include/#define 等）计入代码行（scc 计入）
  // mlStrings：Python 三引号 docstring 按注释处理（scc 不计入代码行）
  static getLanguageConfig(ext) {
    const e = (ext || '').toLowerCase();
    switch (e) {
      case '.c': case '.cpp': case '.cc': case '.cxx': case '.h': case '.hpp': case '.cuh':
        return { lineComments: ['//'], blockStart: '/*', blockEnd: '*/', mlStrings: [], hashIsCode: true };
      case '.java': case '.js': case '.mjs': case '.cjs': case '.ts': case '.go': case '.cs':
      case '.scala': case '.kt': case '.kts': case '.swift': case '.rs':
        return { lineComments: ['//'], blockStart: '/*', blockEnd: '*/', mlStrings: [], hashIsCode: false };
      case '.php':
        return { lineComments: ['//', '#'], blockStart: '/*', blockEnd: '*/', mlStrings: [], hashIsCode: false };
      case '.py':
        return { lineComments: ['#'], blockStart: null, blockEnd: null, mlStrings: ['"""', "'''"], hashIsCode: false };
      case '.rb':
        // Ruby 块注释：=begin ... =end（必须位于行首），行注释为 #
        return { lineComments: ['#'], blockStart: '=begin', blockEnd: '=end', mlStrings: [], hashIsCode: false };
      default:
        // 未知语言：保守兜底，覆盖 C 风格与 # 注释
        return { lineComments: ['//', '#'], blockStart: '/*', blockEnd: '*/', mlStrings: [], hashIsCode: false };
    }
  }

  static startsWithAny(text, markers) {
    for (const m of markers) {
      if (text.startsWith(m)) return true;
    }
    return false;
  }

  // 判断一行是否以某个多行字符串标记开始；若同一行内已闭合则返回 null（不进入状态）
  static openMlString(text, markers) {
    for (const m of markers) {
      if (text.startsWith(m)) {
        return text.slice(m.length).includes(m) ? null : m;
      }
    }
    return null;
  }

  // 判断一行中（非行首）是否出现三引号字符串标记。
  // 与 scc 语义对齐：行首的三引号是 docstring（注释），行中的三引号是字符串字面量（计入代码行）。
  // 返回 { marker, open }：open=true 表示该行打开了未在同行闭合的多行字符串；open=false 表示同行已闭合。
  static findMidLineMlString(line, markers) {
    for (const m of markers) {
      const idx = line.indexOf(m);
      // 只处理出现在行中的标记；行首由调用方走 docstring 分支
      if (idx > 0) {
        const after = line.slice(idx + m.length);
        return { marker: m, open: !after.includes(m) };
      }
    }
    return null;
  }

  // 逐文件构建"有效代码行"分析：与 scc 口径完全一致
  // - 剔除空行、行注释、块注释、行首三引号 docstring（注释）
  // - 行中三引号多行字符串（如 x = '''...'''）整块计入代码行（含内部空白行）
  // - C/C++ 预处理指令（#include/#define 等）计入代码行
  // 返回 { lineMap: 行号→是否有效代码行, sourceCount, sourceLines: [{lineNum,text}] }
  buildSourceLineMap(content, filePath) {
    const lines = content.split('\n');
    const lang = DuplicationDetector.getLanguageConfig(filePath ? path.extname(filePath) : '');
    const lineMap = new Map();
    const sourceLines = [];
    let sourceCount = 0;
    let inBlock = false;      // 是否处于块注释中
    let inDocstring = null;   // 行首三引号 docstring（注释）的结束标记
    let inMlStringCode = null; // 行中三引号多行字符串（代码）的结束标记

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      let isCode = false;

      if (inBlock) {
        // 块注释中：查找结束标记
        if (lang.blockEnd && trimmed.includes(lang.blockEnd)) inBlock = false;
      } else if (inDocstring) {
        // docstring（注释）中：查找结束标记
        if (trimmed.includes(inDocstring)) inDocstring = null;
      } else if (inMlStringCode) {
        // 行中多行字符串中：整块计入代码行（含空白行），查找结束标记
        isCode = true;
        if (trimmed.includes(inMlStringCode)) inMlStringCode = null;
      } else if (trimmed.length === 0) {
        // 空行
      } else if (lang.mlStrings.length > 0 && DuplicationDetector.startsWithAny(trimmed, lang.mlStrings)) {
        // 行首三引号 → docstring，视为注释不计入代码行；未闭合则进入状态
        const marker = DuplicationDetector.openMlString(trimmed, lang.mlStrings);
        if (marker !== null) inDocstring = marker;
      } else if (lang.blockStart && trimmed.startsWith(lang.blockStart)) {
        // 块注释开始行
        if (!trimmed.includes(lang.blockEnd)) inBlock = true;
      } else if (DuplicationDetector.startsWithAny(trimmed, lang.lineComments)) {
        // 纯行注释
      } else if (lang.hashIsCode && trimmed.startsWith('#')) {
        // C/C++ 预处理指令：计入代码行
        isCode = true;
      } else {
        // 普通代码行；若行中出现三引号且未同行闭合，则进入"行中多行字符串"状态（仍计入代码行）
        isCode = true;
        if (lang.mlStrings.length > 0) {
          const mm = DuplicationDetector.findMidLineMlString(trimmed, lang.mlStrings);
          if (mm && mm.open) inMlStringCode = mm.marker;
        }
      }

      lineMap.set(i + 1, isCode);
      if (isCode) {
        sourceCount++;
        sourceLines.push({ lineNum: i + 1, text: trimmed });
      }
    }
    return { lineMap, sourceCount, sourceLines };
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
   * 从行级检测的共享滑动窗口构建重复块出现位置列表（主路径）
   *
   * 分组策略（基于「精确文件集合分桶」+「完全一致文件去重」+「跨组去重」）：
   * - 每个共享 hash（10 行连续窗口内容）都有一个「出现文件集合」F(hash)，即共同出现该内容的所有文件
   * - 内容完全一致的文件（trim 后 MD5 相同）视为同一「等价类」，每个等价类选一个代表；
   *   每个窗口的「代表集合」F' = { rep(f) | f ∈ F(hash) }
   * - 按 F' 精确分桶：同一 F' 的窗口归入同一「重复关系」，不再做超集匹配
   *   ——这保证同一代码块只属于一个精确文件集合组，不会被多个子集组重复包含
   * - 同一 F' 桶内 |F'| ≥ 2 才算重复关系；桶内按代表合并连续索引为出现区间，每个区间一条 occurrence
   * - 完全一致文件组单独输出：同一等价类 ≥2 个文件时整块成一组
   * - 跨组去重保险：最终对同一 (file, startLine, endLine) 出现在多个组的情形，
   *   只保留行覆盖最大的那个组，从其余组删除该 occurrence（不足 2 条的组整组丢弃）
   *
   * 最终分组示例（all_dup_cfile.cpp=A, test-codeql-cpp.cpp=T 完全一致，dup_cfile.cpp=D 为 A 的子集）：
   * - 完全一致组：{A, T}（整块 1-46 行）
   * - 部分重复组：{A, D}（L14-46 共同部分），T 因与 A 完全一致被折叠为 A，不再单独出现
   * - apig 三文件完全共同代码 L4-16：F'={anti, codecheck, sca} 精确成一组，
   *   不会在 {anti,codecheck}、{codecheck,sca} 等子集组重复出现
   *
   * 重复代码行数/重复率仍由行级检测（fileDuplicatedLines）取并集计算，与分组无关，不受影响。
   *
   * @param {Map} fileSourceLines file → [{lineNum, text}]（key 为 '/' 归一化路径）
   * @param {Map} fileContents file(原始路径) → 内容
   * @param {string[]} sources 源目录列表
   * @param {Map} sharedHashWindows hash → [{file, startIdx, endIdx}]（仅跨 2+ 窗口的共享 hash）
   * @returns {Array} duplicationOccurrences 列表
   */
  buildDuplicationOccurrences(fileSourceLines, fileContents, sources, sharedHashWindows) {
    if (!sharedHashWindows || sharedHashWindows.size === 0) return [];

    // 1) 计算「完全一致文件」的等价类：内容(trim 后)哈希相同的文件归为一类
    //    （如 all_dup_cfile.cpp 与 test-codeql-cpp.cpp 完全相同）
    const contentHashToFiles = new Map(); // hash -> [归一化路径]
    const fileToRep = new Map();          // 归一化路径 -> 该类代表
    for (const [file, content] of fileContents) {
      const norm = file.replace(/\\/g, '/');
      const hash = crypto.createHash('md5').update(content.trim()).digest('hex');
      if (!contentHashToFiles.has(hash)) contentHashToFiles.set(hash, []);
      contentHashToFiles.get(hash).push(norm);
    }
    for (const files of contentHashToFiles.values()) {
      const rep = files[0];
      for (const f of files) fileToRep.set(f, rep);
    }

    // 2) 每个共享 hash：按「代表集合」F' 精确分桶
    //    bucketKey = 排序后的代表路径拼接；同一 F' 的窗口归入同一桶
    const buckets = new Map(); // bucketKey -> { reps: [rep...], idxByRep: Map<rep, Set<idx>> }
    for (const [hash, wins] of sharedHashWindows) {
      const reps = new Set();
      for (const w of wins) reps.add(fileToRep.get(w.file) || w.file);
      if (reps.size < 2) continue; // 代表集合 < 2 不构成重复关系
      const bucketKey = [...reps].sort().join('\u0001');
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { reps: [...reps].sort(), idxByRep: new Map() });
      }
      const bucket = buckets.get(bucketKey);
      for (const w of wins) {
        const rep = fileToRep.get(w.file) || w.file;
        if (!bucket.idxByRep.has(rep)) bucket.idxByRep.set(rep, new Set());
        for (let i = w.startIdx; i <= w.endIdx; i++) bucket.idxByRep.get(rep).add(i);
      }
    }

    const occurrences = [];

    // 3) 每个桶 = 一种「部分重复关系」：按代表合并连续索引为出现区间，成组输出
    for (const { reps, idxByRep } of buckets.values()) {
      if (reps.length < 2) continue;
      const fileOccs = [];
      for (const rep of reps) {
        const idxSet = idxByRep.get(rep);
        if (!idxSet || idxSet.size === 0) continue;
        const sourceLines = fileSourceLines.get(rep);
        if (!sourceLines) continue;
        const sorted = [...idxSet].sort((a, b) => a - b);
        let rs = sorted[0], re = sorted[0];
        const flush = () => {
          fileOccs.push({
            file: rep,
            startLine: sourceLines[rs].lineNum,
            endLine: sourceLines[re].lineNum
          });
        };
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] === re + 1) {
            re = sorted[i];
          } else {
            flush();
            rs = sorted[i];
            re = sorted[i];
          }
        }
        flush();
      }
      if (fileOccs.length < 2) continue; // 少于 2 个出现位置不算重复
      this.pushGroup(occurrences, fileOccs, sources, fileContents);
    }

    // 4) 处理「完全一致文件」组：同一内容哈希的 ≥2 个文件单独成一组，
    //    每个成员各占一条出现记录（整文件为重复块）
    //    只有源代码行数 ≥ minLines(10) 的文件才可能被滑窗检测为重复块，故以此作为阈值
    for (const files of contentHashToFiles.values()) {
      if (files.length < 2) continue;
      const fileOccs = [];
      for (const f of files) {
        const sourceLines = fileSourceLines.get(f);
        if (!sourceLines || sourceLines.length < this.minLines) continue;
        fileOccs.push({
          file: f,
          startLine: sourceLines[0].lineNum,
          endLine: sourceLines[sourceLines.length - 1].lineNum
        });
      }
      if (fileOccs.length < 2) continue;
      this.pushGroup(occurrences, fileOccs, sources, fileContents);
    }

    // 5) 跨组去重保险：同一 (file, startLine, endLine) 若出现在多个组，
    //    只保留行覆盖最大的那个组中的出现位置，从其余组删除。
    //    （理论上精确分桶后不应出现，此处作为防御性兜底，避免任何边界情形造成跨组重复）
    this.dedupOccurrencesAcrossGroups(occurrences);

    return occurrences;
  }

  // 跨组去重：同一 (filePath, startLine, endLine) 出现在多个组时，
  // 只保留组内「所有出现位置行覆盖并集」最大的那个组中的该出现位置，从其它组删除。
  // 删除后若某组不足 2 条出现位置，则整组丢弃。
  // 注意：此处以 occurrence 自身的 groupId 为分组依据，不依赖外部结构。
  dedupOccurrencesAcrossGroups(occurrences) {
    if (!occurrences || occurrences.length === 0) return;

    // 统计每个组的行覆盖并集大小，用于决定保留哪个组
    const groupLineSpan = new Map(); // groupId -> Set<lineKey>
    for (const o of occurrences) {
      if (!groupLineSpan.has(o.groupId)) groupLineSpan.set(o.groupId, new Set());
      const span = groupLineSpan.get(o.groupId);
      for (let ln = o.startLine; ln <= o.endLine; ln++) {
        span.add(`${o.filePath}:${ln}`);
      }
    }

    // 对每个 (filePath, startLine, endLine) 找出它所在的所有组，保留 span 最大者
    const blockToGroups = new Map(); // blockKey -> Set<groupId>
    for (const o of occurrences) {
      const k = `${o.filePath}\u0001${o.startLine}\u0001${o.endLine}`;
      if (!blockToGroups.has(k)) blockToGroups.set(k, new Set());
      blockToGroups.get(k).add(o.groupId);
    }
    const dropGroupForBlock = new Map(); // blockKey -> Set<groupId>(要删除的组)
    for (const [k, gids] of blockToGroups) {
      if (gids.size < 2) continue;
      let best = null, bestSize = -1;
      for (const gid of gids) {
        const sz = groupLineSpan.get(gid) ? groupLineSpan.get(gid).size : 0;
        if (sz > bestSize) { bestSize = sz; best = gid; }
      }
      const drop = new Set();
      for (const gid of gids) if (gid !== best) drop.add(gid);
      dropGroupForBlock.set(k, drop);
    }
    if (dropGroupForBlock.size === 0) return;

    // 执行删除：从被标记为删除的 (blockKey, groupId) 对中移除 occurrence
    for (let i = occurrences.length - 1; i >= 0; i--) {
      const o = occurrences[i];
      const k = `${o.filePath}\u0001${o.startLine}\u0001${o.endLine}`;
      const drop = dropGroupForBlock.get(k);
      if (drop && drop.has(o.groupId)) {
        occurrences.splice(i, 1);
      }
    }

    // 删除后若某组不足 2 条，整组丢弃
    const groupCount = new Map();
    for (const o of occurrences) {
      groupCount.set(o.groupId, (groupCount.get(o.groupId) || 0) + 1);
    }
    for (let i = occurrences.length - 1; i >= 0; i--) {
      if (groupCount.get(occurrences[i].groupId) < 2) {
        occurrences.splice(i, 1);
      }
    }
  }

  // 把一组出现位置(重复块)统一排序、生成 groupId 并写入 occurrences
  pushGroup(occurrences, fileOccs, sources, fileContents) {
    // 按 (filePath, startLine) 排序，occurrenceIndex 从 0 递增
    fileOccs.sort((a, b) => {
      const relA = this.toRelativePath(a.file, sources);
      const relB = this.toRelativePath(b.file, sources);
      if (relA !== relB) return relA.localeCompare(relB);
      return a.startLine - b.startLine;
    });

    // groupId 用组内所有出现位置(文件+起止行)的结构化哈希，保证不同重复关系唯一。
    // 同一关系内各 occurrence 的内容可能不同（如共同部分与完全一致块），
    // 因此不能再用「单一内容哈希」作为组 ID，否则不同关系可能因首块内容相同而碰撞。
    const groupId = crypto.createHash('sha256')
      .update(fileOccs
          .map(o => `${this.toRelativePath(o.file, sources)}:${o.startLine}-${o.endLine}`)
          .sort()
          .join('\u0001'))
      .digest('hex');

    fileOccs.forEach((occ, i) => {
      const content = this.extractBlockContent(occ.file, occ.startLine, occ.endLine, fileContents);
      occurrences.push({
        groupId: groupId,
        contentHash: groupId,
        occurrenceIndex: i,
        filePath: this.toRelativePath(occ.file, sources),
        startLine: occ.startLine,
        endLine: occ.endLine,
        content: content
      });
    });
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
