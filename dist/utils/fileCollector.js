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
   * 判断目录/文件是否被 excludeDirs 命中。两条规则（对齐 .gitignore 心智，大小写敏感）：
   * 1. 名称（不含 /）：任意层级的同名目录或文件均排除。例：docs、test.ts、jest.config.js
   * 2. 路径（含 /）：锚定扫描根的相对路径精确匹配，命中即整棵子树剪枝。例：src/opensource/grapesjs；
   *    前导斜杠为可选显式写法（/src/build ≡ src/build，/test.ts 仅匹配顶层 test.ts），
   *    尾部斜杠忽略（docs/ 等价名称 docs）。
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
      // 是否含斜杠决定规则：含 / 走路径锚定，不含 / 走名称匹配。
      // 先判再归一化（/i18n 含斜杠应锚定顶层，剥掉斜杠再判会退化成任意层级）
      const hasSlash = d.indexOf('/') >= 0;
      d = d.replace(/^\/+|\/+$/g, '');
      if (!d) continue;
      if (hasSlash) {
        // 路径规则：相对扫描根精确匹配
        if (d === rel) {
          return true;
        }
      } else if (d === name) {
        // 名称规则：任意层级（目录或文件统一）
        return true;
      }
    }
    return false;
  }

  /**
   * 收集文件列表
   * @param {string|string[]} source - 源代码目录或文件路径（可以是字符串或数组）
   * @param {string[]} excludeDirs - 排除目录列表
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
        if (FileCollector.isExcluded(name, name, excludeDirs)) {
          continue;
        }
        if (!FileCollector.isAllowedFile(name, allowedExtensions)) {
          console.warn(`[WARN] 文件扩展名不在允许列表中: ${absolutePath}`);
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
        // 跳过以 . 开头的目录（如 .git, .idea）和 excludeDirs 命中的目录
        // （纯目录名任意层级生效；相对路径如 src/opensource/grapesjs 命中即整棵子树剪枝）
        if (entry.name.startsWith('.')
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
