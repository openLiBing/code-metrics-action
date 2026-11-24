/**
 * 指标合并与上报格式化（纯逻辑层，无 IO 副作用）。
 * 三个检测器的输出契约以 interface 固化，跨模块传递不再依赖 any：
 * - 输入契约（SlocResult 等）：各键允许缺失——检测器可被禁用（整体为 {}），
 *   合并层对缺失字段有防御性兜底，缺哪些由 validate 运行时把关；
 * - 输出契约（MergedFileDetail / ReportMetrics）：字段完整，缺省值在本层归一化。
 */

/** sloc 检测器的文件级明细（scc --by-file 口径） */
interface SlocFileDetail {
  filePath: string;
  language?: string;
  loc?: number;
  commentLines?: number;
}

/** lizard 的函数级明细（合并层仅透传展示，字段由 lizard 解析产出） */
interface FunctionDetail {
  functionName: string;
  functionLoc: number;
  startLine: number;
  endLine: number;
}

/** lizard 检测器的文件级明细 */
interface LizardFileDetail {
  filePath: string;
  functionCount?: number;
  avgFunctionLoc?: number;
  avgCyclomaticComplexity?: number;
  functionDetails?: FunctionDetail[];
}

/** duplication 检测器的文件级明细 */
interface DuplicationFileDetail {
  filePath: string;
  duplicationRate?: number;
  duplicationLineCount?: number;
  /** 该文件有效代码行数（scc loc 优先），供合并时兜底 scc 不识别扩展名文件的 loc */
  totalLines?: number;
  /** 重复块上下文快照（重复块±5行整体 Base64），由 buildContextSegments 挂载 */
  snapshotData?: string | null;
  /** 与该文件内容重复的文件列表 */
  duplicatedFiles?: string[];
}

/** 内容完全一致文件组（总文件重复率下钻用，duplicatedFiles 含组内全部文件） */
interface IdenticalFileDetail {
  duplicatedFiles: string[];
}

/** 重复块出现位置（content 为明文，uploader 做 Base64 编码后分批上报） */
interface DuplicationOccurrence {
  groupId: string;
  contentHash: string;
  occurrenceIndex: number;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** sloc 检测器整体结果（fileDetails 之外的字段原样并入合并结果） */
interface SlocResult {
  codeScale?: number;
  rawLines?: number;
  commentLines?: number;
  blankLines?: number;
  sourceLines?: number;
  complexity?: number;
  fileDetails?: SlocFileDetail[];
}

/** lizard 检测器整体结果 */
interface LizardResult {
  totalFunctions?: number;
  totalNloc?: number;
  averageFunctionLoc?: number;
  totalCyclomaticComplexity?: number;
  averageCyclomaticComplexity?: number;
  cyclomaticComplexityPerFile?: number;
  fileDetails?: LizardFileDetail[];
}

/** duplication 检测器整体结果 */
interface DuplicationResult {
  totalCodeDuplicationRate?: number;
  totalFileDuplicationRate?: number;
  duplicatedBlocks?: number;
  duplicatedLines?: number;
  totalLines?: number;
  duplicatedFiles?: number;
  totalFiles?: number;
  fileDetails?: DuplicationFileDetail[];
  identicalFileDetails?: IdenticalFileDetail[];
  duplicationOccurrences?: DuplicationOccurrence[];
}

/** 三检测器合并后的文件级明细（mergeFileDetails 输出，字段完整） */
interface MergedFileDetail {
  filePath: string;
  language: string;
  loc: number;
  commentLines: number;
  functionCount: number;
  // 无函数文件两个均值指标不适用，保持 null（0 会被误读为函数代码行很短/复杂度很低）
  avgFunctionLoc: number | null;
  avgCyclomaticComplexity: number | null;
  functionDetails: FunctionDetail[];
  duplicationRate: number;
  duplicationLineCount: number;
  duplicatedFiles: string[];
  // 仅 duplication 覆盖的文件携带上下文快照，其余场景缺省
  snapshotData?: string | null;
}

/**
 * 三检测器合并后的指标集（validate 前的中间形态）：
 * - 总体标量允许缺失，且允许字符串形式注入（上游解析外部工具产出），
 *   formatForReport 统一 Number() 归一化后才进入上报契约；
 * - 三个明细集合 validate 不校验、formatForReport 以 || [] 兜底，同样允许缺失。
 */
interface MergedMetrics {
  codeScale?: number | string;
  rawLines?: number | string;
  commentLines?: number | string;
  blankLines?: number | string;
  sourceLines?: number | string;
  complexity?: number | string;
  totalFunctions?: number | string;
  totalNloc?: number | string;
  averageFunctionLoc?: number | string | null;
  totalCyclomaticComplexity?: number | string;
  averageCyclomaticComplexity?: number | string | null;
  cyclomaticComplexityPerFile?: number | string;
  totalCodeDuplicationRate?: number | string;
  totalFileDuplicationRate?: number | string;
  duplicatedBlocks?: number | string;
  duplicatedLines?: number | string;
  totalLines?: number | string;
  duplicatedFiles?: number | string;
  totalFiles?: number | string;
  fileDetails?: MergedFileDetail[];
  identicalFileDetails?: IdenticalFileDetail[];
  duplicationOccurrences?: DuplicationOccurrence[];
}

/** 上报格式（uploader 上报契约）：数值缺省兜底 0，两个函数均值无数据保持 null。scanner 以此契约组装扫描结果 */
export interface ReportMetrics {
  codeScale: number;
  codeLineTotal: number;
  commentLines: number;
  complexityCount: number;
  cyclomaticComplexityPerFile: number;
  duplicatedBlocks: number;
  duplicatedLines: number;
  avgFunctionLoc: number | null;
  avgCyclomaticComplexity: number | null;
  totalCodeDuplicationRate: number;
  totalFileDuplicationRate: number;
  fileDetails: MergedFileDetail[];
  identicalFileDetails: IdenticalFileDetail[];
  duplicationOccurrences: DuplicationOccurrence[];
}

export class MetricsCalculator {
  static mergeResults(
    slocResult: SlocResult,
    lizardResult: LizardResult,
    duplicationResult: DuplicationResult
  ): MergedMetrics {
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

  /** 合并三个检测器的 fileDetails（以 sloc 为基础，lizard/duplication 按 filePath 匹配） */
  static mergeFileDetails(
    slocFileDetails: SlocFileDetail[],
    lizardFileDetails: LizardFileDetail[],
    duplicationFileDetails: DuplicationFileDetail[]
  ): MergedFileDetail[] {
    // 以 sloc 的 fileDetails 为基础（有 filePath, language, loc）
    const fileMap = new Map<string, MergedFileDetail>();

    for (const detail of slocFileDetails) {
      fileMap.set(detail.filePath, {
        filePath: detail.filePath,
        language: detail.language || '',
        loc: detail.loc || 0,
        commentLines: detail.commentLines || 0,
        functionCount: 0,
        // 无函数文件两个均值指标不适用，保持 null（0 会被误读为函数代码行很短/复杂度很低）
        avgFunctionLoc: null,
        avgCyclomaticComplexity: null,
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
        existing.avgFunctionLoc = detail.avgFunctionLoc ?? null;
        existing.avgCyclomaticComplexity = detail.avgCyclomaticComplexity ?? null;
        existing.functionDetails = detail.functionDetails || [];
      } else {
        fileMap.set(detail.filePath, {
          filePath: detail.filePath,
          language: '',
          loc: 0,
          commentLines: 0,
          functionCount: detail.functionCount || 0,
          avgFunctionLoc: detail.avgFunctionLoc ?? null,
          avgCyclomaticComplexity: detail.avgCyclomaticComplexity ?? null,
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
          commentLines: 0,
          functionCount: 0,
          avgFunctionLoc: null,
          avgCyclomaticComplexity: null,
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

  static validate(metrics: MergedMetrics): boolean {
    // 4 项全局指标必须有数值
    const required: (keyof MergedMetrics)[] = [
      'codeScale',
      'totalCodeDuplicationRate',
      'totalFileDuplicationRate'
    ];
    for (const key of required) {
      if (metrics[key] === undefined || metrics[key] === null) {
        throw new Error(`Missing required metric: ${key}`);
      }
    }
    // 两个函数均值在函数总数为 0 时允许为 null（无数据），但键必须存在，
    // 以区分"探测器未执行/未配置"与"无函数"
    const nullableRequired: (keyof MergedMetrics)[] = [
      'averageFunctionLoc',
      'averageCyclomaticComplexity'
    ];
    for (const key of nullableRequired) {
      if (metrics[key] === undefined) {
        throw new Error(`Missing required metric: ${key}`);
      }
    }

    return true;
  }

  /**
   * 数值指标归一化：缺失或非法值返回 null（无数据），避免 0 被当作真实指标上报
   *
   * @param value 原始值
   * @returns 数值或 null
   */
  static toOptionalNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const num = Number(value);
    return Number.isNaN(num) ? null : num;
  }

  static formatForReport(metrics: MergedMetrics): ReportMetrics {
    // 分离 fileDetails、identicalFileDetails、duplicationOccurrences 和总体指标
    const { fileDetails, identicalFileDetails, duplicationOccurrences, ...overallMetrics } = metrics;

    return {
      codeScale: Number(overallMetrics.codeScale) || 0,
      // 扫描代码总行数：代码 + 注释 + 空行的物理总行数（scc Lines 汇总，即 rawLines），
      // 区别于 codeScale（有效代码行）；sloc 检测器禁用时 rawLines 缺失，降级为 0
      codeLineTotal: Number(overallMetrics.rawLines) || 0,
      // 注释行数：直接取 sloc 检测器的 scc 汇总 commentLines（现成数据）；
      // 每文件 commentLines 明细仍随 fileDetails 落 file_detail，供文件级下钻
      commentLines: Number(overallMetrics.commentLines) || 0,
      // 总圈复杂度：lizard 函数圈复杂度总和（方法维度总量，与 avgCyclomaticComplexity 同源）
      complexityCount: Number(overallMetrics.totalCyclomaticComplexity) || 0,
      // 文件维度圈复杂度：Σ函数圈复杂度 ÷ 含函数的文件数（lizard 口径，
      // 区别于方法维度的 avgCyclomaticComplexity）
      cyclomaticComplexityPerFile: Number(overallMetrics.cyclomaticComplexityPerFile) || 0,
      // 重复代码块数量：重复块出现位置总数（与 duplication_block 表行数一致）
      duplicatedBlocks: Number(overallMetrics.duplicatedBlocks) || 0,
      // 重复代码行数量：Σ 每文件重复行数（totalCodeDuplicationRate 的分子）
      duplicatedLines: Number(overallMetrics.duplicatedLines) || 0,
      // 平均函数代码行/平均圈复杂度：分母（函数总数）为 0 时无数据，保持 null 上报，
      // 不能兜底为 0（0 会被前端当作真实指标展示与排序）
      avgFunctionLoc: MetricsCalculator.toOptionalNumber(overallMetrics.averageFunctionLoc),
      avgCyclomaticComplexity: MetricsCalculator.toOptionalNumber(overallMetrics.averageCyclomaticComplexity),
      totalCodeDuplicationRate: Number(overallMetrics.totalCodeDuplicationRate) || 0,
      totalFileDuplicationRate: Number(overallMetrics.totalFileDuplicationRate) || 0,
      fileDetails: fileDetails || [],
      identicalFileDetails: identicalFileDetails || [],
      // 重复块出现位置列表（含明文 content），uploader 会 Base64 编码后分批上报
      duplicationOccurrences: duplicationOccurrences || []
    };
  }
}
