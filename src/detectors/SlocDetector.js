const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const BaseDetector = require('./BaseDetector');
const FileCollector = require('../utils/fileCollector');

// scc 二进制文件路径：依次探测多个候选位置，全部失败时返回 null（调用方直接回退本地统计）
function getSccPath() {
  // 兼容两种运行形态（typeof 探测未声明变量不抛错）：
  // - ncc bundle：用 ncc 注入的 __nccwpck_require__.ab（bundle 根 = dist/）定位内置 bin
  // - 源码结构：无 __nccwpck_require__ 全局，__dirname 即 src/detectors
  const bundleRoot = (typeof __nccwpck_require__ !== 'undefined')
    ? __nccwpck_require__.ab
    : null;
  // 候选顺序：
  // 1. bundle 根 + bin/（标准 ncc 打包形态，asset 随目录分发）
  // 2. bundle 根根目录平铺（部分平台分发时把 asset 平铺到 dist/ 根）
  // 3. 源码结构：__dirname=src/detectors，上溯一层为 src/（即 src/bin/scc）
  const candidates = [];
  if (bundleRoot) {
    candidates.push(path.join(bundleRoot, 'bin', 'scc'));
    candidates.push(path.join(bundleRoot, 'scc'));
  }
  candidates.push(path.join(__dirname, 'bin', 'scc'));
  candidates.push(path.join(__dirname, '..', 'bin', 'scc'));
  candidates.push(path.join(__dirname, 'scc'));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // zip 打包 / git clone 解压后可能丢失可执行权限位，运行时强制赋予 0o755，保证可执行
      try {
        fs.chmodSync(candidate, 0o755);
      } catch (e) {
        console.warn(`[WARN] 无法设置 scc 可执行权限: ${e.message}`);
      }
      return candidate;
    }
  }
  // PATH 探测：确认 runner 环境本身安装了 scc 才使用裸命令名，
  // 避免执行注定失败的命令产生误导性报错
  try {
    execSync('command -v scc', { stdio: 'ignore' });
    return 'scc';
  } catch (e) {
    console.warn('[WARN] 未找到可用的 scc（内置 bin 与 PATH 均无），回退到本地逐文件统计');
    return null;
  }
}

class SlocDetector extends BaseDetector {
  constructor(config = {}) {
    super(config);
    this.allowedExtensions = config.allowedExtensions || [];
    this.sccPath = getSccPath();
  }

  async detect(source) {
    const sources = Array.isArray(source) ? source : [source];
    const excludeDirs = this.config.excludeDirs || [];

    const sccArgs = this.buildSccArgs(sources, excludeDirs);

    // 未找到可用 scc（内置 bin 与 PATH 均无）：直接回退本地逐文件统计，
    // 跳过注定失败的命令执行
    if (!this.sccPath) {
      return this.fallbackDetect(sources, excludeDirs);
    }

    try {
      const result = this.runScc(sccArgs, sources);
      return result;
    } catch (error) {
      console.warn(`[WARN] scc 执行失败: ${error.message}，回退到逐文件统计`);
      return this.fallbackDetect(sources, excludeDirs);
    }
  }

  // 构建 scc 命令行参数
  buildSccArgs(sources, excludeDirs) {
    const args = ['-f', 'json', '--no-cocomo', '--no-size', '--by-file'];

    // 不再向 scc 传 --exclude-dir：scc 自身的排除规则不支持 ** 等 glob 通配符，
    // 无法与 FileCollector 的 exclude-dirs 语义对齐。改为扫描全量后，在 runScc 里
    // 用 FileCollector.isPathExcluded 对每个文件做后置过滤，保证与其余指标完全一致。

    // 限制文件扩展名
    if (this.allowedExtensions.length > 0) {
      const exts = this.allowedExtensions
        .map(e => e.replace(/^\./, ''))
        .join(',');
      args.push('--include-ext', exts);
    }

    // 源目录
    for (const src of sources) {
      args.push(src);
    }

    return args;
  }

  // 执行 scc 并解析 JSON 输出。
  // execFileSync 参数数组直传，不经 shell 解析（Ref #49 #57 #29，与 pre-commit-action #26 同款）：
  // 消除 sources / --include-ext（来自 allowed-extensions input）等外部输入包含
  // shell 特殊字符（; ` $() 等）时的命令注入面
  runScc(args, sources) {
    const output = execFileSync(this.sccPath, args, {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
      timeout: 300000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const sccResult = JSON.parse(output.trim());

    // scc JSON 输出格式: 按语言分组
    // [{ Name, Code, Comment, Blank, Lines, Complexity, Count, Bytes, Files:[...] }]
    const excludeDirs = this.config.excludeDirs || [];
    let totalCode = 0;
    let totalComment = 0;
    let totalBlank = 0;
    let totalLines = 0;
    let totalComplexity = 0;
    let totalFiles = 0;

    // 收集文件级指标
    const fileDetails = [];

    for (const lang of sccResult) {
      // 注意：不再累加语言级汇总（含被 exclude-dirs 排除的文件），改为逐文件统计并
      // 过滤后累加，保证 codeScale 等与 FileCollector 收集的文件范围口径一致。
      const langFiles = lang.Files;
      if (!langFiles || !Array.isArray(langFiles) || langFiles.length === 0) {
        // 兜底：若某语言条目缺少/为空按文件明细（Files 缺失或为空数组），无法做文件级
        // 排除，则按语言级汇总计入，避免该语言整体被丢弃导致总代码量/总文件数/总复杂度偏小。
        totalCode += lang.Code || 0;
        totalComment += lang.Comment || 0;
        totalBlank += lang.Blank || 0;
        totalLines += lang.Lines || 0;
        totalComplexity += lang.Complexity || 0;
        totalFiles += lang.Count || 0;
        continue;
      }
      for (const file of langFiles) {
          // scc 不同版本的 --by-file JSON 输出字段名可能不同：
          //   - 旧版：Name 是完整路径
          //   - 新版（3.x+）：Name 是文件名，Location 是完整路径
          // 优先取完整路径字段（Location），其次 Name（可能是文件名或完整路径）
          const fileName = file.Location || file.Name || file.Path || file.File || '';
          // 过滤掉语言汇总行（字段为空或不含路径分隔符/扩展名的语言名）
          if (!fileName || !this.isFilePath(fileName)) {
            console.log(`[DEBUG] 跳过非文件条目: Name="${fileName}", Code=${file.Code || 0}, keys=${Object.keys(file).join(',')}`);
            continue;
          }
          // 将绝对路径转为相对路径
          let filePath = this.toRelativePath(fileName, sources);
          // 后置过滤：用 FileCollector 的目录剪枝语义排除命中 exclude-dirs 的文件，
          // 保证与 FileCollector / lizard / duplication 收集的文件范围完全一致
          if (excludeDirs.length > 0 && FileCollector.isPathExcluded(filePath, excludeDirs)) {
            continue;
          }
          const code = file.Code || 0;
          const comment = file.Comment || 0;
          const blank = file.Blank || 0;
          totalCode += code;
          totalComment += comment;
          totalBlank += blank;
          totalLines += (file.Lines || (code + comment + blank));
          totalComplexity += (file.Complexity || 0);
          totalFiles++;
          fileDetails.push({
            filePath: filePath,
            language: lang.Name || '',
            loc: code,
            commentLines: comment
          });
        }
    }

    console.log(`  - Total files: ${totalFiles}`);
    console.log(`  - Code lines (codeScale): ${totalCode}`);
    console.log(`  - Comment lines: ${totalComment}`);
    console.log(`  - Blank lines: ${totalBlank}`);
    console.log(`  - Total lines: ${totalLines}`);
    console.log(`  - Complexity: ${totalComplexity}`);
    console.log(`  - File details count: ${fileDetails.length}`);

    // 如果 scc --by-file 未产出有效文件明细，回退到逐文件统计获取明细
    if (fileDetails.length === 0) {
      console.log('[DEBUG] scc --by-file 未产出文件明细，回退到逐文件统计');
      const FileCollector = require('../utils/fileCollector');
      const excludeDirs = this.config.excludeDirs || [];
      const allFiles = [];
      for (const src of sources) {
        const files = FileCollector.collectFiles(src, excludeDirs, this.allowedExtensions);
        allFiles.push(...files);
      }
      const uniqueFiles = [...new Set(allFiles)];
      for (const file of uniqueFiles) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          let sourceCount = 0;
          let commentCount = 0;
          const lines = content.replace(/\r\n|\r/g, '\n').split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*') && !trimmed.startsWith('#')) {
              sourceCount++;
            } else if (trimmed) {
              commentCount++;
            }
          }
          const filePath = this.toRelativePath(file, sources);
          const ext = path.extname(file).toLowerCase();
          const langMap = {
            '.java': 'Java', '.js': 'JavaScript', '.ts': 'TypeScript',
            '.py': 'Python', '.go': 'Go', '.c': 'C', '.cpp': 'C++',
            '.h': 'C/C++ Header', '.cs': 'C#', '.rb': 'Ruby',
            '.php': 'PHP', '.rs': 'Rust', '.kt': 'Kotlin',
            '.scala': 'Scala', '.swift': 'Swift'
          };
          fileDetails.push({
            filePath: filePath,
            language: langMap[ext] || ext.replace('.', ''),
            loc: sourceCount,
            commentLines: commentCount
          });
        } catch (e) {
          // 只输出文件基名，不落 runner 绝对路径（Ref #60）
          console.warn(`[WARN] 跳过文件 ${path.basename(file)}: ${e.message}`);
        }
      }
    }

    return {
      codeScale: totalCode,
      rawLines: totalLines,
      commentLines: totalComment,
      blankLines: totalBlank,
      sourceLines: totalCode,
      complexity: totalComplexity,
      fileDetails: fileDetails
    };
  }

  // 判断 Name 是否为文件路径（而非语言名）
  isFilePath(name) {
    if (!name) return false;
    // 文件路径应包含扩展名（含点号）或路径分隔符
    return name.includes('.') || name.includes('/') || name.includes('\\');
  }

  // 将绝对路径转为相对路径（统一使用 / 分隔符）
  toRelativePath(filePath, sources) {
    if (sources && sources.length > 0) {
      for (const src of sources) {
        const normalizedSrc = src.replace(/\\/g, '/');
        const normalizedPath = filePath.replace(/\\/g, '/');
        if (normalizedPath.startsWith(normalizedSrc)) {
          filePath = path.relative(src, filePath);
          break;
        }
      }
    }
    return filePath.replace(/\\/g, '/');
  }

  // 回退方案：当 scc 不可用时，逐文件读取并统计行数
  fallbackDetect(sources, excludeDirs) {
    const FileCollector = require('../utils/fileCollector');
    const allFiles = [];
    for (const src of sources) {
      const files = FileCollector.collectFiles(src, excludeDirs, this.allowedExtensions);
      allFiles.push(...files);
    }
    const uniqueFiles = [...new Set(allFiles)];

    if (uniqueFiles.length === 0) {
      return { codeScale: 0, rawLines: 0, commentLines: 0, blankLines: 0, sourceLines: 0, complexity: 0, fileDetails: [] };
    }

    let totalSource = 0;
    let totalAll = 0;
    let totalComment = 0;
    let totalEmpty = 0;

    // 收集文件级指标
    const fileDetails = [];

    for (const file of uniqueFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        let normalized = content.replace(/\r\n|\r/g, '\n');
        if (normalized.slice(-1) === '\n') normalized = normalized.slice(0, -1);
        const lines = normalized.split('\n');
        totalAll += lines.length;

        let fileSourceLines = 0;
        let fileCommentLines = 0;
        let inBlock = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (inBlock) {
            totalComment++;
            fileCommentLines++;
            if (trimmed.includes('*/')) inBlock = false;
            continue;
          }
          if (trimmed === '') { totalEmpty++; continue; }
          if (trimmed.startsWith('/*')) {
            totalComment++;
            fileCommentLines++;
            if (!trimmed.includes('*/')) inBlock = true;
            continue;
          }
          if (trimmed.startsWith('//')) { totalComment++; fileCommentLines++; continue; }
          totalSource++;
          fileSourceLines++;
        }

        // 将绝对路径转为相对路径
        let filePath = file;
        for (const src of sources) {
          const normalizedSrc = src.replace(/\\/g, '/');
          const normalizedPath = filePath.replace(/\\/g, '/');
          if (normalizedPath.startsWith(normalizedSrc)) {
            filePath = path.relative(src, file);
            break;
          }
        }
        filePath = filePath.replace(/\\/g, '/');

        // 根据扩展名推断语言
        const ext = path.extname(file).toLowerCase();
        const langMap = {
          '.java': 'Java', '.js': 'JavaScript', '.ts': 'TypeScript',
          '.py': 'Python', '.go': 'Go', '.c': 'C', '.cpp': 'C++',
          '.h': 'C/C++ Header', '.cs': 'C#', '.rb': 'Ruby',
          '.php': 'PHP', '.rs': 'Rust', '.kt': 'Kotlin',
          '.scala': 'Scala', '.swift': 'Swift'
        };

        fileDetails.push({
          filePath: filePath,
          language: langMap[ext] || ext.replace('.', ''),
          loc: fileSourceLines,
          commentLines: fileCommentLines
        });
      } catch (e) {
        // 只输出文件基名，不落 runner 绝对路径（Ref #60）
        console.warn(`[WARN] 跳过文件 ${path.basename(file)}: ${e.message}`);
      }
    }

    console.log(`[DEBUG] Fallback statistics (scc 不可用):`);
    console.log(`  - Code scale: ${totalSource}`);

    return {
      codeScale: totalSource,
      rawLines: totalAll,
      commentLines: totalComment,
      blankLines: totalEmpty,
      sourceLines: totalSource,
      complexity: 0,
      fileDetails: fileDetails
    };
  }

  getName() {
    return 'sloc';
  }
}

module.exports = SlocDetector;
