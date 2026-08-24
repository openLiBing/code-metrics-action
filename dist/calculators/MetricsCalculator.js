class MetricsCalculator {
  static mergeResults(slocResult, lizardResult, duplicationResult) {
    // 合并总体指标（排除 fileDetails / identicalFileDetails / duplicationOccurrences，单独处理）
    const { fileDetails: slocFileDetails, ...slocMetrics } = slocResult;
    const { fileDetails: lizardFileDetails, ...lizardMetrics } = lizardResult;
    // 显式提取 duplicationOccurrences，避免被 ...duplicationMetrics 散开混入总体指标
    const {
      fileDetails: duplicationFileDetails,
      identicalFileDetails,
      duplicationOccurrences,
      ...duplicationMetrics
    } = duplicationResult;

    // 合并文件级指标：以 sloc 的 fileDetails 为基础
    const fileDetails = MetricsCalculator.mergeFileDetails(
      slocFileDetails || [],
      lizardFileDetails || [],
      duplicationFileDetails || []
    );

    return {
      ...slocMetrics,
      ...lizardMetrics,
      ...duplicationMetrics,
      fileDetails: fileDetails,
      identicalFileDetails: identicalFileDetails || [],
      // 重复块出现位置列表（含每块的明文 content，由 uploader 做 Base64 编码后分批上报）
      duplicationOccurrences: duplicationOccurrences || []
    };
  }

  // 合并三个检测器的 fileDetails
  static mergeFileDetails(slocFileDetails, lizardFileDetails, duplicationFileDetails) {
    // 以 sloc 的 fileDetails 为基础（有 filePath, language, loc）
    const fileMap = new Map();

    for (const detail of slocFileDetails) {
      fileMap.set(detail.filePath, {
        filePath: detail.filePath,
        language: detail.language || '',
        loc: detail.loc || 0,
        functionCount: 0,
        avgFunctionLoc: 0,
        avgCyclomaticComplexity: 0,
        functionDetails: [],
        duplicationRate: 0,
        duplicationLineCount: 0,
        duplicatedFiles: []
      });
    }

    // 合并 lizard 的 fileDetails（按 filePath 匹配）
    for (const detail of lizardFileDetails) {
      const existing = fileMap.get(detail.filePath);
      if (existing) {
        existing.functionCount = detail.functionCount || 0;
        existing.avgFunctionLoc = detail.avgFunctionLoc || 0;
        existing.avgCyclomaticComplexity = detail.avgCyclomaticComplexity || 0;
        existing.functionDetails = detail.functionDetails || [];
      } else {
        fileMap.set(detail.filePath, {
          filePath: detail.filePath,
          language: '',
          loc: 0,
          functionCount: detail.functionCount || 0,
          avgFunctionLoc: detail.avgFunctionLoc || 0,
          avgCyclomaticComplexity: detail.avgCyclomaticComplexity || 0,
          functionDetails: detail.functionDetails || [],
          duplicationRate: 0,
          duplicationLineCount: 0,
          duplicatedFiles: []
        });
      }
    }

    // 合并 duplication 的 fileDetails（按 filePath 匹配）
    for (const detail of duplicationFileDetails) {
      const existing = fileMap.get(detail.filePath);
      if (existing) {
        existing.duplicationRate = detail.duplicationRate || 0;
        existing.duplicationLineCount = detail.duplicationLineCount || 0;
        existing.duplicatedFiles = detail.duplicatedFiles || [];
        // 上下文片段快照（重复块±5行，整体 Base64 编码），由 buildContextSegments 生成
        existing.snapshotData = detail.snapshotData || null;
      } else {
        // duplication 独有文件（scc 不识别其扩展名，如 .prelds）：
        // loc 用 duplication 检测携带的 totalLines 兜底（本地"非空非注释"口径），
        // 避免 loc=0 但 duplicationLineCount>0 的矛盾展示
        fileMap.set(detail.filePath, {
          filePath: detail.filePath,
          language: '',
          loc: detail.totalLines || 0,
          functionCount: 0,
          avgFunctionLoc: 0,
          avgCyclomaticComplexity: 0,
          functionDetails: [],
          duplicationRate: detail.duplicationRate || 0,
          duplicationLineCount: detail.duplicationLineCount || 0,
          duplicatedFiles: detail.duplicatedFiles || [],
          snapshotData: detail.snapshotData || null
        });
      }
    }

    return [...fileMap.values()];
  }

  static validate(metrics) {
    const required = [
      'codeScale',
      'averageFunctionLoc',
      'averageCyclomaticComplexity',
      'totalCodeDuplicationRate',
      'totalFileDuplicationRate'
    ];

    for (const key of required) {
      if (metrics[key] === undefined || metrics[key] === null) {
        throw new Error(`Missing required metric: ${key}`);
      }
    }

    return true;
  }

  static formatForReport(metrics) {
    // 分离 fileDetails、identicalFileDetails、duplicationOccurrences 和总体指标
    const { fileDetails, identicalFileDetails, duplicationOccurrences, ...overallMetrics } = metrics;

    return {
      codeScale: Number(overallMetrics.codeScale) || 0,
      avgFunctionLoc: Number(overallMetrics.averageFunctionLoc) || 0,
      avgCyclomaticComplexity: Number(overallMetrics.averageCyclomaticComplexity) || 0,
      totalCodeDuplicationRate: Number(overallMetrics.totalCodeDuplicationRate) || 0,
      totalFileDuplicationRate: Number(overallMetrics.totalFileDuplicationRate) || 0,
      fileDetails: fileDetails || [],
      identicalFileDetails: identicalFileDetails || [],
      // 重复块出现位置列表（含明文 content），uploader 会 Base64 编码后分批上报
      duplicationOccurrences: duplicationOccurrences || []
    };
  }
}

module.exports = MetricsCalculator;
