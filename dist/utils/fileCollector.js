const fs = require('fs');
const path = require('path');

class FileCollector {
  /**
   * 收集文件列表
   * @param {string|string[]} source - 源代码目录或文件路径（可以是字符串或数组）
   * @param {string[]} excludeDirs - 排除目录列表
   * @param {string[]} allowedExtensions - 允许的文件扩展名列表
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
        if (allowedExtensions.length > 0) {
          const ext = path.extname(absolutePath).toLowerCase();
          if (!allowedExtensions.includes(ext)) {
            console.warn(`[WARN] 文件扩展名不在允许列表中: ${absolutePath}`);
            continue;
          }
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
        // 如果指定了 allowedExtensions，只收集匹配的文件
        if (allowedExtensions.length > 0) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!allowedExtensions.includes(ext)) {
            continue;
          }
        }
        files.push(fullPath);
      }
    }
  }
}

module.exports = FileCollector;
