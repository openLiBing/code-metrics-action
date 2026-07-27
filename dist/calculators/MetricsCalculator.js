class MetricsCalculator {
  static mergeResults(slocResult, lizardResult, jscpdResult) {
    // 合并总体指标（排除 fileDetails 和 identicalFileDetails，单独处理）
    const { fileDetails: slocFileDetails, ...slocMetrics } = slocResult;
    const { fileDetails: lizardFileDetails, ...lizardMetrics } = lizardResult;
    const { fileDetails: jscpdFileDetails, identicalFileDetails, ...jscpdMetrics } = jscpdResult;

    // 合并文件级指标：以 sloc 的 fileDetails 为基础
    const fileDetails = MetricsCalculator.mergeFileDetails(
      slocFileDetails || [],
      lizardFileDetails || [],
      jscpdFileDetails || []
    );

    return {
      ...slocMetrics,
      ...lizardMetrics,
      ...jscpdMetrics,
      fileDetails: fileDetails,
      identicalFileDetails: identicalFileDetails || []
    };
  }

  // 合并三个检测器的 fileDetails
  static mergeFileDetails(slocFileDetails, lizardFileDetails, jscpdFileDetails) {
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

    // 合并 jscpd 的 fileDetails（按 filePath 匹配）
    for (const detail of jscpdFileDetails) {
      const existing = fileMap.get(detail.filePath);
      if (existing) {
        existing.duplicationRate = detail.duplicationRate || 0;
        existing.duplicationLineCount = detail.duplicationLineCount || 0;
        existing.duplicatedFiles = detail.duplicatedFiles || [];
      } else {
        fileMap.set(detail.filePath, {
          filePath: detail.filePath,
          language: '',
          loc: 0,
          functionCount: 0,
          avgFunctionLoc: 0,
          avgCyclomaticComplexity: 0,
          functionDetails: [],
          duplicationRate: detail.duplicationRate || 0,
          duplicationLineCount: detail.duplicationLineCount || 0,
          duplicatedFiles: detail.duplicatedFiles || []
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
    // 分离 fileDetails、identicalFileDetails 和总体指标
    const { fileDetails, identicalFileDetails, ...overallMetrics } = metrics;

    return {
      codeScale: Number(overallMetrics.codeScale) || 0,
      avgFunctionLoc: Number(overallMetrics.averageFunctionLoc) || 0,
      avgCyclomaticComplexity: Number(overallMetrics.averageCyclomaticComplexity) || 0,
      totalCodeDuplicationRate: Number(overallMetrics.totalCodeDuplicationRate) || 0,
      totalFileDuplicationRate: Number(overallMetrics.totalFileDuplicationRate) || 0,
      fileDetails: fileDetails || [],
      identicalFileDetails: identicalFileDetails || []
    };
  }
}

module.exports = MetricsCalculator;
