const fs = require('fs');
const path = require('path');

class FileCollector {
  // 缺省代码扩展名白名单（allowed-extensions 未配置时生效，业界惯例为白名单制，
  // 对齐 scc/cloc 内置语言的常见子集；.gn/.gni/.prelds 为 OHOS 构建体系特有脚本）
  static DEFAULT_CODE_EXTENSIONS = [
    // C/C++ 家族
    '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.inl', '.cu', '.cuh',
    // 主流通用语言
    '.java', '.cs', '.go', '.rs', '.swift', '.kt', '.kts', '.scala', '.groovy',
    '.py', '.rb', '.php', '.pl', '.pm', '.lua', '.r', '.jl', '.dart', '.m', '.mm',
    '.tcl', '.asm', '.s',
    // 前端
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
    '.html', '.htm', '.css', '.scss', '.less',
    // 脚本
    '.sh', '.bash', '.ps1', '.bat', '.cmd', '.gradle',
    // 数据/配置（scc 亦将这些计入统计）
    '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties',
    '.sql', '.proto',
    // 构建脚本
    '.cmake', '.mk',
    // OHOS 构建体系
    '.gn', '.gni', '.prelds'
  ];

  // 文件名特例：无扩展名或需按文件名识别的构建/入口文件（对齐 scc/cloc 的文件名识别规则），
  // 不受扩展名白名单限制，始终放行
  static SPECIAL_FILE_NAMES = [
    'cmakelists.txt', 'makefile', 'gnumakefile', 'dockerfile', 'jenkinsfile',
    'rakefile', 'gemfile', 'build', 'build.bazel', 'workspace'
  ];

  // 默认跳过的隐藏目录（定向黑名单）：只排版本控制与 IDE 的私有目录，
  // 不再按「. 开头」一刀切——否则 .gitcode 这类承载流水线配置的正式源码目录会被连带剪枝，
  // 使本地收集范围（重复率分子）小于 scc 全量扫描范围（分母），重复率被系统性低估。
  static DEFAULT_EXCLUDED_DIRS = ['.git', '.svn', '.hg', '.idea', '.vscode'];

  // glob 规则防护上限：超长或 globstar 层数过多的模式存在正则回溯爆炸风险，直接拒绝
  static MAX_GLOB_PATTERN_LENGTH = 256;
  static MAX_GLOBSTAR_COUNT = 16;
  // 已告警的非法/超限规则，避免目录遍历时重复刷日志
  static _warnedGlobs = new Set();

  /**
   * 判断目录是否属于默认跳过的隐藏目录（版本控制/IDE 私有目录）
   *
   * @param {string} dirName 目录名（不含路径）
   * @return {boolean} 命中默认跳过名单返回 true，否则返回 false
   */
  static isDefaultExcludedDir(dirName) {
    return FileCollector.DEFAULT_EXCLUDED_DIRS.includes(String(dirName || '').toLowerCase());
  }

  /**
   * 判断文件是否放行：文件名特例 > 显式 allowed-extensions > 缺省白名单。
   * 扩展名统一小写比较；显式配置为覆盖式语义——用户指定扩展名后，
   * 扫描范围 = 用户指定的扩展名 + 文件名特例（如指定 .h,.cpp 则只扫这两类 + CMakeLists.txt 等），
   * 不再叠加缺省白名单。
   */
  static isAllowedFile(fileName, allowedExtensions) {
    const lower = (fileName || '').toLowerCase();
    if (FileCollector.SPECIAL_FILE_NAMES.includes(lower)) {
      return true;
    }
    const normalized = (allowedExtensions || []).map(e => String(e).toLowerCase());
    const list = normalized.length > 0 ? normalized : FileCollector.DEFAULT_CODE_EXTENSIONS;
    const ext = path.extname(lower);
    return list.includes(ext);
  }

  /**
   * 判断目录/文件是否被 excludeDirs 命中（大小写敏感）。匹配目标为条目相对扫描根的路径（正斜杠）。
   * 规则：
   * 1. 裸名称（不含 /）：
   *    - 无通配符：仅顶层精确匹配。例：test.ts、docs（不命中 src/test.ts；排任意层级同名文件请用 globstar 路径）
   *    - 含通配符：任意层级匹配条目名。例：*.test.js、*test*
   * 2. 路径（含 /）：锚定扫描根，匹配相对路径，命中目录即整棵子树剪枝。
   *    例：src/opensource/grapesjs、src/opensource/*
   * 前导斜杠为可选显式写法（/test.ts 仅匹配顶层 test.ts），尾部斜杠忽略（docs/ ≡ docs）。
   * 通配符：*（单段不含 /）、**（跨目录）、?（单字符）、[abc]/[!abc]（字符类）。
   * 目录与文件统一适用同一条规则，不按类型区分。
   */
  static isExcluded(name, relPath, excludeDirs) {
    if (!excludeDirs || excludeDirs.length === 0) {
      return false;
    }
    const rel = (relPath || '').replace(/\\/g, '/');
    for (const raw of excludeDirs) {
      let d = String(raw).trim().replace(/\\/g, '/');
      if (!d) continue;
      // 尾部斜杠忽略（docs/ ≡ docs），先剥离再做通配符/斜杠判定
      d = d.replace(/\/+$/g, '');
      if (!d) continue;
      // 是否含斜杠决定规则：含 /（内部或前导）走路径锚定，不含 / 走名称匹配。
      // 先判再剥前导斜杠（/i18n 含 / 应锚定顶层，剥掉后匹配串为 i18n）
      const hasSlash = d.indexOf('/') >= 0;
      d = d.replace(/^\/+/, '');
      if (!d) continue;
      // 是否含 glob 通配符（* ? [）
      const hasWildcard = d.indexOf('*') >= 0 || d.indexOf('?') >= 0 || d.indexOf('[') >= 0;
      if (hasSlash) {
        // 路径规则：锚定扫描根，匹配相对路径
        const re = FileCollector.globToRegExp(d);
        if (re && re.test(rel)) {
          return true;
        }
      } else if (hasWildcard) {
        // 裸名称 + 通配符：任意层级匹配条目名
        const re = FileCollector.globToRegExp(d);
        if (re && re.test(name)) {
          return true;
        }
      } else if (d === rel) {
        // 裸名称（无通配符）：仅顶层精确匹配（等价锚定根）
        return true;
      }
    }
    return false;
  }

  /**
   * 判断某条相对路径（文件或目录）是否被 excludeDirs 整棵剪枝命中（大小写敏感）。
   * 与 _walkDir 的目录剪枝语义一致：逐层考察「文件自身 + 所有祖先目录」，
   * 任一层级被 isExcluded 命中即判定排除。用于对 scc 等外部扫描器的输出做后置过滤，
   * 保证与 FileCollector 收集的文件范围完全一致。
   * 例：excludeDirs=['go/','cpp/**'] 时，
   *   - go/test-codeql.go：祖先目录 go 命中顶层规则 → 排除
   *   - cpp/part_dup1.cpp：自身命中 cpp/** → 排除
   *   - src/go/x.go：go 非顶层，不命中 go/ → 保留
   */
  static isPathExcluded(relPath, excludeDirs) {
    const p = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p) return false;
    const parts = p.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? prefix + '/' + parts[i] : parts[i];
      if (FileCollector.isExcluded(parts[i], prefix, excludeDirs)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 记录并跳过非法/超限 glob 规则（同一规则只告警一次，避免遍历中刷屏）
   */
  static _warnInvalidGlob(pattern, reason) {
    if (FileCollector._warnedGlobs.has(pattern)) {
      return;
    }
    FileCollector._warnedGlobs.add(pattern);
    console.warn(`[WARN] exclude-dirs 规则已跳过: ${pattern}（${reason}）`);
  }

  // 将单个 glob 模式转为锚定整串匹配的正则（大小写敏感）。
  // 支持 *（单段不含 /）、**（跨目录，**/ 可匹配 0 层目录）、?（单字符不含 /）、
  // [abc]/[a-z]/[!abc]（字符类，! 取反）；其余字符按字面匹配，正则元字符自动转义。
  // 非法或超限模式返回 null，由调用方跳过，避免中断整个扫描。
  static globToRegExp(glob) {
    const pattern = String(glob || '');
    // 长度与 globstar 层数上限：兜底超长/深度嵌套模式的正则回溯风险
    if (pattern.length > FileCollector.MAX_GLOB_PATTERN_LENGTH
        || (pattern.match(/\*\*/g) || []).length > FileCollector.MAX_GLOBSTAR_COUNT) {
      FileCollector._warnInvalidGlob(pattern, '超出长度或 globstar 层数上限');
      return null;
    }
    let re = '^';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '*') {
        // 连续 * 合并为 **（跨目录分隔符）
        if (pattern[i + 1] === '*') {
          while (pattern[i + 1] === '*') i++;
          if (pattern[i + 1] === '/') {
            // **/：匹配 0 层或多层目录，顶层与任意深层均命中
            re += '(?:.*/)?';
            i++;
          } else {
            re += '.*';
          }
        } else {
          // *：单段内任意字符（不含 /）
          re += '[^/]*';
        }
      } else if (c === '?') {
        re += '[^/]';
      } else if (c === '[') {
        // 字符类：[abc]、[a-z]、[!abc]（或 [^abc]）；未闭合的 [ 当作普通字符
        let j = i + 1;
        let negate = false;
        if (pattern[j] === '!' || pattern[j] === '^') {
          negate = true;
          j++;
        }
        let cls = '';
        let closed = false;
        let first = true;
        while (j < pattern.length) {
          if (pattern[j] === ']' && !first) {
            closed = true;
            break;
          }
          first = false;
          cls += pattern[j];
          j++;
        }
        if (closed) {
          re += '[' + (negate ? '^' : '') + cls + ']';
          i = j;
        } else {
          re += '\\[';
        }
      } else {
        // 正则元字符转义，其余按字面匹配
        re += '\\^$.|+(){}'.indexOf(c) >= 0 ? '\\' + c : c;
      }
    }
    try {
      return new RegExp(re + '$');
    } catch (error) {
      // 字符类内容按 glob 语义原样拼接，非法区间（如 [z-a]）在此兜底
      FileCollector._warnInvalidGlob(pattern, error.message);
      return null;
    }
  }

  /**
   * 收集文件列表
   * @param {string|string[]} source - 源代码目录或文件路径（可以是字符串或数组）
   * @param {string[]} excludeDirs - 排除列表（目录名 / 相对路径 / 文件名，逗号分隔）
   * @param {string[]} allowedExtensions - 允许的文件扩展名列表（配置后完全覆盖缺省白名单）
   * @returns {string[]} 文件路径列表
   */
  static collectFiles(source, excludeDirs = [], allowedExtensions = []) {
    const files = [];

    // 支持传入单个路径或路径数组
    const sources = Array.isArray(source) ? source : [source];

    for (const src of sources) {
      const absolutePath = path.resolve(src);

      if (!fs.existsSync(absolutePath)) {
        console.warn(`[WARN] 路径不存在: ${absolutePath}`);
        continue;
      }

      const stat = fs.statSync(absolutePath);

      if (stat.isDirectory()) {
        // 如果是目录，递归遍历
        FileCollector._walkDir(absolutePath, '', excludeDirs, allowedExtensions, files);
      } else if (stat.isFile()) {
        // 单文件输入：文件级排除 + 扩展名白名单双重过滤
        const name = path.basename(absolutePath);
        // 相对扫描根的路径取调用方传入路径（正斜杠、剥离前导 ./ 与 /），
        // 使含斜杠的路径式规则（如 src/opensource/*）在传入相对路径时同样生效；
        // 两种形态叠加判断，保持与目录扫描的 isExcluded 语义一致。
        const relInput = String(src).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
        if (FileCollector.isPathExcluded(name, excludeDirs) || FileCollector.isPathExcluded(relInput, excludeDirs)) {
          continue;
        }
        if (!FileCollector.isAllowedFile(name, allowedExtensions)) {
          console.warn(`[WARN] 文件扩展名不在允许列表中: ${path.basename(absolutePath)}`);
          continue;
        }
        files.push(absolutePath);
      }
    }

    return files;
  }

  // 递归遍历目录，根据排除规则和扩展名过滤文件。
  // relPrefix：当前目录相对扫描根的路径（用于路径式排除匹配），根目录本身为 ''
  static _walkDir(dir, relPrefix, excludeDirs, allowedExtensions, files) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // 当前条目相对扫描根的路径（正斜杠），用于路径式排除匹配
      const relPath = relPrefix ? relPrefix + '/' + entry.name : entry.name;

      if (entry.isDirectory()) {
        // 跳过默认隐藏目录（版本控制/IDE 私有目录）和 excludeDirs 命中的目录
        // （纯目录名任意层级生效；相对路径如 src/opensource/grapesjs 命中即整棵子树剪枝）
        if (FileCollector.isDefaultExcludedDir(entry.name)
            || FileCollector.isExcluded(entry.name, relPath, excludeDirs)) {
          continue;
        }
        FileCollector._walkDir(fullPath, relPath, excludeDirs, allowedExtensions, files);
      } else if (entry.isFile()) {
        // 文件级排除（文件名/相对路径命中 excludeDirs 即跳过）
        if (FileCollector.isExcluded(entry.name, relPath, excludeDirs)) {
          continue;
        }
        // 白名单三段式过滤：文件名特例 > 显式扩展名 > 缺省白名单
        if (!FileCollector.isAllowedFile(entry.name, allowedExtensions)) {
          continue;
        }
        files.push(fullPath);
      }
    }
  }
}

module.exports = FileCollector;
