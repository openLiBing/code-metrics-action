const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const BaseDetector = require('./BaseDetector');
const FileCollector = require('../utils/fileCollector');

class LizardDetector extends BaseDetector {
  constructor(config = {}) {
    super(config);
    this.tempJsonFile = './lizard_output.json';
    this.allowedExtensions = config.allowedExtensions || [];
  }

  async detect(source) {
    // 支持单个路径或多个路径
    const sources = Array.isArray(source) ? source : [source];
    const excludeDirs = this.config.excludeDirs || [];

    // 收集所有文件
    const allFiles = [];
    for (const src of sources) {
      const files = FileCollector.collectFiles(src, excludeDirs, this.allowedExtensions);
      allFiles.push(...files);
    }

    // 去重
    const uniqueFiles = [...new Set(allFiles)];

    if (uniqueFiles.length === 0) {
      return this.getEmptyResult();
    }

    // Lizard 处理所有文件，统一获取函数数、函数代码行数和圈复杂度
    let lizardResult = { totalFunctions: 0, totalNloc: 0, totalCC: 0, functions: [] };
    if (uniqueFiles.length > 0) {
      lizardResult = this.runLizard(uniqueFiles);
    }

    const totalFunctions = lizardResult.totalFunctions;
    const totalNloc = lizardResult.totalNloc;
    const totalCC = lizardResult.totalCC;

    if (totalFunctions === 0) {
      return this.getEmptyResult();
    }

    // 按文件聚合函数数据，计算文件级指标
    const fileDetails = this.aggregateFileDetails(lizardResult.functions, sources);

    return {
      totalFunctions,
      totalNloc,
      averageFunctionLoc: totalFunctions > 0
        ? parseFloat((totalNloc / totalFunctions).toFixed(2))
        : 0,
      totalCyclomaticComplexity: totalCC,
      averageCyclomaticComplexity: totalFunctions > 0
        ? parseFloat((totalCC / totalFunctions).toFixed(2))
        : 0,
      // 文件维度圈复杂度：Σ函数圈复杂度 ÷ 含函数的文件数（区别于方法维度的 averageCyclomaticComplexity）
      cyclomaticComplexityPerFile: fileDetails.length > 0
        ? parseFloat((totalCC / fileDetails.length).toFixed(2))
        : 0,
      fileDetails: fileDetails
    };
  }

  // 将文件列表写入临时文件，供 lizard 的 -f 参数读取
  writeInputFile(files) {
    const tempInputPath = path.join(os.tmpdir(), `lizard_input_${Date.now()}.txt`);
    fs.writeFileSync(tempInputPath, files.join('\n'), 'utf8');
    return tempInputPath;
  }

  runLizard(files) {
    const tempJsonPath = path.resolve(this.tempJsonFile);
    let tempInputPath = null;

    try {
      if (fs.existsSync(tempJsonPath)) {
        fs.unlinkSync(tempJsonPath);
      }

      // 使用 -f 参数从临时文件读取文件列表，避免命令行长度限制
      tempInputPath = this.writeInputFile(files);
      const args = ['-f', tempInputPath, '-o', tempJsonPath];

      execSync('python3 -m lizard ' + args.join(' '), {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 300000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (tempInputPath) {
        fs.unlinkSync(tempInputPath);
        tempInputPath = null;
      }

      if (!fs.existsSync(tempJsonPath)) {
        return { totalFunctions: 0, totalNloc: 0, totalCC: 0, functions: [] };
      }

      const content = fs.readFileSync(tempJsonPath, 'utf8').trim();
      if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);

      if (!content) {
        return { totalFunctions: 0, totalNloc: 0, totalCC: 0, functions: [] };
      }

      if (content.startsWith('{')) {
        const results = JSON.parse(content);
        return this.calculateMetricsFromLizard(results);
      } else {
        return this.parseTextOutput(content);
      }
    } catch (error) {
      if (tempInputPath && fs.existsSync(tempInputPath)) {
        fs.unlinkSync(tempInputPath);
        tempInputPath = null;
      }
      if (fs.existsSync(tempJsonPath)) {
        try {
          const content = fs.readFileSync(tempJsonPath, 'utf8').trim();
          if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);
          if (content) {
            if (content.startsWith('{')) {
              return this.calculateMetricsFromLizard(JSON.parse(content));
            } else {
              return this.parseTextOutput(content);
            }
          }
        } catch (parseError) {
          console.warn(`Failed to parse lizard output: ${parseError.message}`);
        }
      }
      console.warn(`Lizard detection warning: ${error.message}`);
      return { totalFunctions: 0, totalNloc: 0, totalCC: 0, functions: [] };
    }
  }

  parseTextOutput(content) {
    let totalFunctions = 0;
    let totalNloc = 0;
    let totalCC = 0;
    const functions = [];

    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim() || line.includes('NLOC') || line.includes('===') || line.includes('----')) {
        continue;
      }

      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+?)@(\d+)-(\d+)@(.+)$/);
      if (match) {
        totalFunctions++;
        const cc = parseInt(match[2], 10);
        totalCC += cc;

        // 从源文件中计算函数体有效代码行（排除方法签名和参数行）
        const startLine = parseInt(match[7], 10);
        const endLine = parseInt(match[8], 10);
        const filePath = match[9].trim();

        let bodyNloc = parseInt(match[1], 10);
        try {
          const fileContent = fs.readFileSync(filePath, 'utf8');
          const defLines = this.countDefinitionLines(fileContent, startLine);
          bodyNloc = this.calculateBodyNloc(fileContent, startLine, endLine, defLines);
        } catch (e) {
          // 读取源文件失败时，回退到 nloc - 1
          bodyNloc = Math.max(0, bodyNloc - 1);
        }

        totalNloc += bodyNloc;
        // 保留 filename 用于按文件聚合
        functions.push({
          // match[6] 是正则捕获的函数名（如 MyClass.myMethod）
          name: match[6] || '',
          nloc: bodyNloc,
          cc: cc,
          startLine: startLine,
          endLine: endLine,
          filename: filePath
        });
      }
    }

    return { totalFunctions, totalNloc, totalCC, functions };
  }

  getEmptyResult() {
    return {
      totalFunctions: 0,
      totalNloc: 0,
      averageFunctionLoc: 0,
      totalCyclomaticComplexity: 0,
      averageCyclomaticComplexity: 0,
      cyclomaticComplexityPerFile: 0,
      fileDetails: []
    };
  }

  // 根据源文件内容，计算函数定义占用的行数
  countDefinitionLines(fileContent, startLine) {
    const lines = fileContent.split('\n');
    const startIndex = startLine - 1;
    if (startIndex < 0 || startIndex >= lines.length) return 1;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.endsWith(':')) {
        return i - startIndex + 1;
      }
      if (line.endsWith('{')) {
        return i - startIndex + 1;
      }
      if (line.endsWith(')') && i + 1 < lines.length && lines[i + 1].trim() === '{') {
        return i - startIndex + 1;
      }
    }

    return 1;
  }

  // 判断一行是否为有效代码行（非空行、非纯注释行）
  static isSourceLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    if (trimmed.startsWith('#')) return false;
    if (trimmed.startsWith('//')) return false;
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) return false;
    return true;
  }

  // 从源文件中精确计算函数体的有效代码行数（排除定义行）
  calculateBodyNloc(fileContent, startLine, endLine, defLines) {
    const lines = fileContent.split('\n');
    let bodyNloc = 0;

    const bodyStart = startLine - 1 + defLines;
    const bodyEnd = endLine;

    for (let i = bodyStart; i < bodyEnd && i < lines.length; i++) {
      if (LizardDetector.isSourceLine(lines[i])) {
        bodyNloc++;
      }
    }

    return bodyNloc;
  }

  calculateMetricsFromLizard(results) {
    let totalFunctions = 0;
    let totalNloc = 0;
    let totalCC = 0;
    const functions = [];

    if (results && results.functions) {
      for (const func of results.functions) {
        totalFunctions++;
        totalCC += func.cyclomatic_complexity || 1;

        // 读取源文件，精确计算函数定义行数，从 nloc 中排除
        let bodyNloc = func.nloc || 0;
        if (func.start_line && func.end_line && func.filename) {
          try {
            const fileContent = fs.readFileSync(func.filename, 'utf8');
            const defLines = this.countDefinitionLines(fileContent, func.start_line);
            bodyNloc = this.calculateBodyNloc(fileContent, func.start_line, func.end_line, defLines);
          } catch (e) {
            bodyNloc = Math.max(0, (func.nloc || 0) - 1);
          }
        } else {
          bodyNloc = Math.max(0, (func.nloc || 0) - 1);
        }

        totalNloc += bodyNloc;
        functions.push({
          name: func.name,
          nloc: bodyNloc,
          cc: func.cyclomatic_complexity || 1,
          startLine: func.start_line,
          endLine: func.end_line,
          filename: func.filename || ''
        });
      }
    }

    return { totalFunctions, totalNloc, totalCC, functions };
  }

  // 按文件聚合函数数据，保留每个函数的明细（函数名、行数、开始行、结束行）
  aggregateFileDetails(functions, sources) {
    if (!functions || functions.length === 0) return [];

    // 按文件名分组
    const fileMap = new Map();
    for (const func of functions) {
      const filename = func.filename || '';
      if (!filename) continue;
      if (!fileMap.has(filename)) {
        fileMap.set(filename, []);
      }
      fileMap.get(filename).push(func);
    }

    const fileDetails = [];
    for (const [filename, funcs] of fileMap) {
      const functionCount = funcs.length;
      const totalNloc = funcs.reduce((sum, f) => sum + (f.nloc || 0), 0);
      const totalCC = funcs.reduce((sum, f) => sum + (f.cc || 0), 0);

      // 将绝对路径转为相对路径
      let filePath = filename;
      if (sources && sources.length > 0) {
        for (const src of sources) {
          const normalizedSrc = src.replace(/\\/g, '/');
          const normalizedPath = filePath.replace(/\\/g, '/');
          if (normalizedPath.startsWith(normalizedSrc)) {
            filePath = path.relative(src, filename);
            break;
          }
        }
      }
      filePath = filePath.replace(/\\/g, '/');

      // 保留每个函数的明细信息
      const functionDetails = funcs.map(f => ({
        functionName: f.name || '',
        functionLoc: f.nloc || 0,
        startLine: f.startLine || 0,
        endLine: f.endLine || 0
      }));

      fileDetails.push({
        filePath: filePath,
        functionCount: functionCount,
        avgFunctionLoc: parseFloat((totalNloc / functionCount).toFixed(2)),
        avgCyclomaticComplexity: parseFloat((totalCC / functionCount).toFixed(2)),
        functionDetails: functionDetails
      });
    }

    return fileDetails;
  }

  getName() {
    return 'lizard';
  }
}

module.exports = LizardDetector;
