const SlocDetector = require('./detectors/SlocDetector');
const LizardDetector = require('./detectors/LizardDetector');
const DuplicationDetector = require('./detectors/DuplicationDetector');
const MetricsCalculator = require('./calculators/MetricsCalculator');
const CoderepoUploader = require('./uploaders/CoderepoUploader');
const ConfigLoader = require('./config/loader');
const Logger = require('./utils/logger');
const FileUtils = require('./utils/fileUtils');
const FileCollector = require('./utils/fileCollector');
const path = require('path');

// 将日期格式化为 yyyy-MM-dd HH:mm:ss
function formatDateTime(date) {
  // 固定按东八区输出：CI runner 容器时区多为 UTC，用本地组件取值会使检测时间比实际早 8 小时
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  // en-CA 输出形如 "2026-08-24, 11:05:29"，把逗号替换为空格统一为 yyyy-MM-dd HH:mm:ss
  return fmt.format(date).replace(',', '');
}

class MetricsScanner {
  constructor(config = {}) {
    this.config = config;
    this.logger = new Logger({ verbose: config.verbose });
    this.workingDir = config.workingDir || process.cwd();

    const allowedExtensions = config.allowedExtensions || [];

    this.slocDetector = new SlocDetector({
      excludeDirs: config.excludeDirs,
      allowedExtensions: allowedExtensions
    });

    this.lizardDetector = new LizardDetector({
      excludeDirs: config.excludeDirs,
      allowedExtensions: allowedExtensions,
      lizardPath: config.detectors?.lizard?.path || 'lizard',
      workingDir: this.workingDir
    });

    this.duplicationDetector = new DuplicationDetector({
      excludeDirs: config.excludeDirs,
      allowedExtensions: allowedExtensions,
      // 与华为云 cmetrics 官方定义对齐："连续超过 10 行代码块在其他地方重复记为一次重复"
      // - minLines=10：连续代码块至少 10 行才算一次重复
      minLines: config.detectors?.duplication?.minLines || 10
    });

    this.uploader = new CoderepoUploader({
      coderepoUrl: config.uploader?.coderepoUrl,
      timeout: (config.uploader?.timeout || 30) * 1000
    });
  }

  async scan(options = {}) {
    const startTime = new Date();
    const startTimeFormatted = formatDateTime(startTime);
    this.logger.info('Starting code metrics scan...');

    const sourceInput = options.sourceDir || this.config.sourceDir;
    const sources = Array.isArray(sourceInput) ? sourceInput : [sourceInput];
    const resolvedSources = sources.map(src =>
      path.isAbsolute(src) ? src : path.resolve(this.workingDir, src)
    );

    const previewFiles = FileCollector.collectFiles(
      resolvedSources,
      this.config.excludeDirs || [],
      this.config.allowedExtensions || []
    );
    let slocResult = {};
    let lizardResult = {};
    let duplicationResult = {};
    let status = 0;

    try {
      if (this.config.detectors?.sloc?.enabled !== false) {
        this.logger.info('Running scc detector (code size)...');
        slocResult = await this.slocDetector.detect(resolvedSources);
      }

      if (this.config.detectors?.lizard?.enabled !== false) {
        this.logger.info('Running lizard detector (function complexity)...');
        lizardResult = await this.lizardDetector.detect(resolvedSources);
      }

      if (this.config.detectors?.duplication?.enabled !== false) {
        this.logger.info('Running duplication detector (code duplication)...');
        // 传入 slocResult：既提供 codeScale（总重复率分母），也提供每个文件的 scc loc（文件重复率分母）
        duplicationResult = await this.duplicationDetector.detect(resolvedSources, slocResult);
      }

      const mergedMetrics = MetricsCalculator.mergeResults(slocResult, lizardResult, duplicationResult);
      MetricsCalculator.validate(mergedMetrics);
      const formattedMetrics = MetricsCalculator.formatForReport(mergedMetrics);

      // 从格式化结果中分离 fileDetails 和总体指标
      const { fileDetails, ...overallMetrics } = formattedMetrics;

      const endTime = new Date();
      const endTimeFormatted = formatDateTime(endTime);
      const durationMs = endTime.getTime() - startTime.getTime();

      const result = {
        ...overallMetrics,
        fileDetails: fileDetails,
        detectionInfo: {
          startTime: startTimeFormatted,
          endTime: endTimeFormatted,
          durationMs: durationMs,
          sources: resolvedSources,
          tools: {
            sloc: this.config.detectors?.sloc?.enabled !== false,
            lizard: this.config.detectors?.lizard?.enabled !== false,
            duplication: this.config.detectors?.duplication?.enabled !== false
          }
        }
      };

      this.logger.info(`Scan completed in ${durationMs}ms`);

      // 诊断日志：输出扫描结果规模，用于定位大数据量下的序列化超限问题
      let snapshotTotal = 0;
      for (const fd of fileDetails || []) {
        if (fd.snapshotData) snapshotTotal += fd.snapshotData.length;
      }
      this.logger.info(
        `Result scale: fileDetails=${(fileDetails || []).length}, snapshotDataTotal=${snapshotTotal} bytes, occurrences=${(formattedMetrics.duplicationOccurrences || []).length}`
      );

      if (options.output || this.config.output) {
        const outputPath = path.isAbsolute(options.output || this.config.output)
          ? (options.output || this.config.output)
          : path.resolve(this.workingDir, options.output || this.config.output);
        // 本地输出文件剥离大数据字段（snapshotData 与 duplicationOccurrences 的明文 content），
        // 避免超大代码库的 metrics.json 序列化触发 V8 Invalid string length。
        // - snapshotData 仅详情页展示用，DB 上报另有一份
        // - occurrence 的明文 content 仅上报用（uploader 已 Base64 编码后分批上报），
        //   本地保留 groupId/filePath/起止行等元数据即可
        const compactResult = {
          ...result,
          fileDetails: (result.fileDetails || []).map(fd => {
            const { snapshotData, ...rest } = fd;
            return rest;
          }),
          // 重复块出现位置：超长明文 content 裁剪为「头部 + 省略标记 + 尾部」，
          // 防止累计超 V8 单字符串上限（复用上报侧 clipOversizeContent，按行省略）
          duplicationOccurrences: (result.duplicationOccurrences || []).map(occ => {
            const MAX_CONTENT_CHARS = 15 * 1024;
            if (typeof occ.content === 'string' && occ.content.length > MAX_CONTENT_CHARS) {
              return {
                ...occ,
                content: this.uploader.clipOversizeContent(occ.content, MAX_CONTENT_CHARS)
              };
            }
            return occ;
          })
        };
        FileUtils.writeJsonFile(outputPath, compactResult);
        this.logger.info(`Results saved to: ${outputPath}`);
        this.logger.info(`Local output size approx: ${JSON.stringify(compactResult).length} bytes`);
      }

      if (options.upload || this.config.uploader?.enabled) {
        const uploadResult = await this.uploader.upload(formattedMetrics, {
          gitUrl: options.gitUrl,
          branchName: options.branchName,
          pipelineRunId: options.pipelineRunId,
          commitId: options.commitId,
          runNumber: options.runNumber,
          startTime: startTimeFormatted,
          endTime: endTimeFormatted,
          status: status
        });

        if (uploadResult.success) {
          this.logger.info(`Successfully uploaded metrics, recordId: ${uploadResult.recordId}`);
          result.uploadInfo = { success: true, recordId: uploadResult.recordId };
        } else {
          this.logger.error(`Failed to upload metrics: ${uploadResult.error}`);
          result.uploadInfo = { success: false, error: uploadResult.error };
        }
      }

      return result;

    } catch (error) {
      this.logger.error(`Scan failed: ${error.message}`);
      if (error && error.stack) {
        // 输出堆栈头部，辅助定位是哪个 JSON.stringify / 哪个阶段抛错
        this.logger.error(`Stack head: ${error.stack.split('\n').slice(0, 12).join('\n')}`);
      }

      // 失败时也上传报告，附带错误信息
      if (options.upload || this.config.uploader?.enabled) {
        const endTimeFormatted = formatDateTime(new Date());
        try {
          await this.uploader.upload({}, {
            gitUrl: options.gitUrl,
            branchName: options.branchName,
            pipelineRunId: options.pipelineRunId,
            commitId: options.commitId,
            runNumber: options.runNumber,
            startTime: startTimeFormatted,
            endTime: endTimeFormatted,
            status: 1,
            errorMessage: error.message
          });
        } catch (uploadError) {
          this.logger.error(`Failed to upload error report: ${uploadError.message}`);
        }
      }

      throw error;
    }
  }
}

module.exports = {
  MetricsScanner,
  ConfigLoader,
  SlocDetector,
  LizardDetector,
  DuplicationDetector,
  MetricsCalculator
};
