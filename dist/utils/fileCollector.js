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
        FileCollector._walkDir(absolutePath, excludeDirs, allowedExtensions, files);
      } else if (stat.isFile()) {
        // 如果是文件，检查扩展名后添加
        if (!FileCollector.isAllowedFile(path.basename(absolutePath), allowedExtensions)) {
          console.warn(`[WARN] 文件扩展名不在允许列表中: ${absolutePath}`);
          continue;
        }
        files.push(absolutePath);
      }
    }

    return files;
  }

  // 递归遍历目录，根据排除规则和扩展名过滤文件
  static _walkDir(dir, excludeDirs, allowedExtensions, files) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 跳过以 . 开头的目录（如 .git, .idea）和 excludeDirs 中的目录
        if (entry.name.startsWith('.') || excludeDirs.includes(entry.name)) {
          continue;
        }
        FileCollector._walkDir(fullPath, excludeDirs, allowedExtensions, files);
      } else if (entry.isFile()) {
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
