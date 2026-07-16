const fs = require('fs');
const path = require('path');

class FileUtils {
  static writeJsonFile(filePath, data, pretty = true) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    fs.writeFileSync(filePath, content, 'utf8');
  }

  static ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
  }

  static getExtension(filePath) {
    return path.extname(filePath);
  }

  static isFileAllowed(filePath, allowedExtensions) {
    if (!allowedExtensions || allowedExtensions.length === 0) {
      return true;
    }
    const ext = this.getExtension(filePath).toLowerCase();
    return allowedExtensions.includes(ext);
  }

  static isDirectoryExcluded(dirPath, excludeDirs) {
    if (!excludeDirs || excludeDirs.length === 0) {
      return false;
    }
    const dirName = path.basename(dirPath);
    return excludeDirs.some(exclude => {
      return dirName === exclude || dirPath.includes(`/${exclude}/`);
    });
  }
}

module.exports = FileUtils;
