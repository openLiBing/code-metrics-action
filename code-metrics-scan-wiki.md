# 代码仓度量指标统计解决方案

## 1. 功能入口

**开发管理 → 代码仓管理 → 仓库分支管理** 页面，每个分支行展示 5 项代码度量指标列。

## 2. 指标概览

| 指标名称 | 单位 | 含义 | 检测工具 |
|---------|------|------|---------|
| 代码规模 | 行 | 仓库有效代码行数（排除空行和注释行） | scc（内置二进制） |
| 平均函数代码行 | 行 | 函数体有效代码行的算术平均值（排除函数签名行） | lizard |
| 平均圈复杂度 | — | 函数级圈复杂度的算术平均值 | lizard |
| 总代码重复率 | % | 跨文件重复代码行占有效代码行的百分比 | jscpd（token 滑动窗口 + md5 哈希） |
| 总文件重复率 | % | 内容完全一致文件占总文件数的百分比 | 文件内容 md5 哈希比对 |

---

## 3. 页面交互说明

- 每个指标值以**蓝色可点击链接**形式呈现
- 点击指标值，弹窗展示每个指标的文件级指标详情数据，支持分页浏览、模糊搜索、排序等。
- 各指标数值均为最新一次扫描结果，每个指标独立携带来源流水线信息
- 在弹窗展示的指标详情页中，点击流水线编号可以跳转到对应的 GitCode Actions 流水线

---

## 4. 数据配置说明

页面上的指标数据由 **code-metrics-scan** 插件（`v1.0.17`）通过 GitCode Actions 流水线扫描上报。以下说明如何配置以使数据出现在页面上。

### 4.1 配置要求

| 配置项 | 说明 |
|--------|------|
| 工作流文件 | 在仓库 `.gitcode/workflows/` 下创建 YAML 工作流文件 |
| Python 依赖 | 流水线中需安装 `lizard` 和 `radon`（`pip install lizard radon`） |
| APIG 认证 | 需配置 `CODEMETRICS_APIG_BASE_URL`、`CODEMETRICS_APIG_APP_KEY`、`CODEMETRICS_APIG_APP_SECRET` 三个 Secrets |
| atomgit 上下文 | 由 GitCode Runner 自动注入（`ATOMGIT_REPOSITORY`/`ATOMGIT_RUN_ID`/`ATOMGIT_RUN_NUMBER` 等），无需手动配置 |

### 4.2 触发方式

| 触发方式 | 配置关键字 | 适用场景 |
|---------|-----------|---------|
| 手动触发 | `workflow_dispatch` | 按需验证、首次接入验证 |
| 代码推送触发 | `push.branches` | 合入主分支时自动检测，作为 PR 门禁 |
| 定时任务触发 | `schedule.cron` | Nightly 流水线，每日定期检测跟踪趋势 |

### 4.3 Action 输入参数

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `source-dir` | 否 | `./` | 源代码目录路径。线上环境由 checkout 步骤决定实际扫描内容 |
| `scan-repository` | 否 | 空 | 要扫描的目标仓库 HTTPS 克隆地址（如 `https://gitcode.com/openlibing/xxx.git`）。指定后插件会自动克隆该仓库到 `source-dir` 下扫描，与流水线所属仓解耦 |
| `scan-ref` | 否 | 空 | 扫描目标仓库的分支或标签（配合 `scan-repository` 使用） |
| `scan-token` | 否 | 空 | 扫描目标仓库的访问令牌（配合 `scan-repository` 使用） |
| `repository` | 否 | 空 | 流水线所属仓的 `owner/repo`（如 `openlibing/openlibing-cicd`），用于上报。不传则从 `ATOMGIT_REPOSITORY` 环境变量或工作区根目录 git remote 自动获取 |
| `exclude-dirs` | 否 | 空 | 排除目录列表，逗号分隔。**留空表示不排除任何目录（扫描全部路径）** |
| `allowed-extensions` | 否 | 空 | 允许的文件扩展名，逗号分隔。**留空表示不限制扩展名（扫描所有文件类型）** |
| `config-file` | 否 | 空 | 自定义 `.metrics.yml` 配置文件路径，支持 yaml/json 格式 |
| `min-lines` | 否 | `10` | jscpd 最小重复行数阈值，与华为云 cmetrics 官方定义对齐 |
| `min-tokens` | 否 | `85` | jscpd 滑动窗口 token 数 |
| `output` | 否 | `metrics.json` | 结果输出文件路径 |
| `upload` | 否 | `true` | 是否上传检测结果到 coderepo 服务 |

> ⚠️ **关键区分**：`scan-repository` 是克隆 URL（如 `https://gitcode.com/openlibing/xxx.git`），`repository` 是 `owner/repo` 格式（如 `openlibing/openlibing-cicd`）。两者语义不同，不能混用——`scan-repository` 仅用于克隆要扫描的代码仓，`repository` 仅用于上报流水线所属仓信息。

> 📌 **配置优先级**：Action 输入参数 > 用户配置文件（`.metrics.yml`） > 默认配置

### 4.4 环境变量

| 变量 | 来源 | 必填 | 说明 |
|------|------|:----:|------|
| `CODEMETRICS_APIG_BASE_URL` | workflow secrets | 是 | coderepo 服务地址（APIG 网关 baseUrl，如 `https://apig.openlibing.com:443`） |
| `CODEMETRICS_APIG_APP_KEY` | workflow secrets | 是 | APIG 网关 AppKey（即 AK，用于 HMAC-SHA256 签名） |
| `CODEMETRICS_APIG_APP_SECRET` | workflow secrets | 是 | APIG 网关 AppSecret（即 SK，用于 HMAC-SHA256 签名） |
| `ATOMGIT_REPOSITORY` | Runner 自动注入 | 否 | 当前流水线所属仓的 `owner/repo`，用于上报 |
| `ATOMGIT_REF_NAME` | Runner 自动注入 | 否 | 当前分支/标签名，作为 `branchName` 兜底 |
| `ATOMGIT_RUN_ID` | Runner 自动注入 | 否 | 流水线执行 ID（`pipelineRunId`），优先于 `PIPELINE_RUN_ID` |
| `ATOMGIT_RUN_NUMBER` | Runner 自动注入 | 否 | 流水线运行编号（`runNumber`），优先于 `PIPELINE_RUN_NUMBER` |

> 💡 **secrets 注入方式**：GitCode workflow 的 `secrets:` 块不是 step 级别合法字段，必须通过 `env:` 注入到 `process.env`，action 才能读取（见 4.6 节示例）。

### 4.5 扫描范围与重复率配置

#### 扫描范围

通过 `exclude-dirs`、`allowed-extensions` 控制哪些文件参与指标计算。典型值：

```yaml
exclude-dirs: "node_modules,target,dist,.git,.gitcode,.mvn,.trae,vendor,__pycache__,scripts,.idea,.vscode,openspec,keys"
allowed-extensions: ".js,.jsx,.ts,.tsx,.vue,.py,.java,.go,.c,.cpp,.h"
```

#### 重复率检测参数

代码重复率的检测精度受以下参数影响（也可通过 `.metrics.yml` 配置 `detectors.jscpd`）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `min-lines`（action） / `detectors.jscpd.minLines` | 10 | 最小重复行数阈值，连续超过 10 行的代码块才算一次重复 |
| `min-tokens`（action） / `detectors.jscpd.minTokens` | 85 | 滑动窗口 token 数 |
| `detectors.jscpd.threshold` | 0.3 | 重复率报告阈值（仅 `.metrics.yml` 可配） |

> 文件重复率独立于 jscpd，采用文件内容归一化后的 md5 哈希两两比对，找出内容完全一致的文件。

### 4.6 Action 输出

扫描完成后，以下输出可用于后续 step 引用（`steps.<id>.outputs.<name>`）：

| 输出 | 说明 |
|------|------|
| `code-scale` | 代码规模（有效代码行数） |
| `avg-function-loc` | 平均函数代码行数 |
| `avg-cyclomatic-complexity` | 平均圈复杂度 |
| `total-code-duplication-rate` | 代码重复率（%） |
| `total-file-duplication-rate` | 文件重复率（%） |

### 4.7 工作流配置示例

#### 场景一：扫描当前工作流所属仓

最简接入：直接 checkout 当前仓，扫描整个工作区。

```yaml
name: code-metrics-scan

on:
  workflow_dispatch:
  push:
    branches: [ "main", "master" ]

stages:
  stage1:
    name: 代码度量检测
    select: selected_by_default
    jobs:
      code-metrics-scan:
        name: 代码度量检测
        runs-on: ["codearts-hosted", "ubuntu-latest", "x64", "large"]
        steps:
          - name: Checkout repository
            uses: checkout

          - name: setup-python
            uses: setup-python

          - name: install_dependency
            run: |
              python3 -m pip install --break-system-packages lizard radon \
                -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com

          - name: code-metrics-scan
            uses: code-metrics-scan
            with:
              upload: "true"
              exclude-dirs: "node_modules,target,dist,.git,.gitcode,.mvn,.trae,vendor"
              allowed-extensions: ".js,.jsx,.ts,.tsx,.vue,.py,.java,.go,.c,.cpp,.h"
              output: "metrics.json"
            env:
              # secrets 必须通过 env 注入到 process.env，action 才能读到
              CODEMETRICS_APIG_BASE_URL: ${{ secrets.CODEMETRICS_APIG_BASE_URL }}
              CODEMETRICS_APIG_APP_KEY: ${{ secrets.CODEMETRICS_APIG_APP_KEY }}
              CODEMETRICS_APIG_APP_SECRET: ${{ secrets.CODEMETRICS_APIG_APP_SECRET }}

        pre:
          - type: auto
```

#### 场景二：扫描指定代码仓的指定分支

适用于"集中扫描仓"：在专用流水线仓中 checkout 目标仓到 `source-code` 子目录，扫描该目录。`repository` 仍上报流水线所属仓（用于拼接流水线链接）。

```yaml
name: code-metrics-scan

on:
  workflow_dispatch:
  push:
    branches: [ "main", "master" ]

stages:
  stage1:
    name: 代码度量检测
    select: selected_by_default
    jobs:
      code-metrics-scan:
        name: 代码度量检测
        runs-on: ["codearts-hosted", "ubuntu-latest", "x64", "large"]
        steps:
          # 先 checkout 当前仓，确保本地 action 文件可用
          - name: Checkout self
            uses: checkout

          # 再 checkout 要扫描的目标仓到子目录，避免覆盖当前仓的 action 文件
          - name: Checkout target repository
            uses: checkout
            with:
              repository: https://gitcode.com/${{ owner }}/${{ repo }}.git
              ref: ${{ ref }}
              token: ${{ secrets.CODEMETRICS_TOKEN }}
              path: source-code
              fetch-depth: 1

          - name: setup-python
            uses: setup-python

          - name: install_dependency
            run: |
              python3 -m pip install --break-system-packages lizard radon \
                -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com

          - name: code-metrics-scan
            uses: code-metrics-scan
            with:
              source-dir: source-code
              upload: "true"
              exclude-dirs: "node_modules,target,dist,.git,.gitcode,.mvn,.trae,vendor"
              allowed-extensions: ".js,.jsx,.ts,.tsx,.vue,.py,.java,.go,.c,.cpp,.h"
              output: "metrics.json"
            env:
              CODEMETRICS_APIG_BASE_URL: ${{ secrets.CODEMETRICS_APIG_BASE_URL }}
              CODEMETRICS_APIG_APP_KEY: ${{ secrets.CODEMETRICS_APIG_APP_KEY }}
              CODEMETRICS_APIG_APP_SECRET: ${{ secrets.CODEMETRICS_APIG_APP_SECRET }}

        pre:
          - type: auto
```

> 也可不使用 checkout 步骤，直接通过 `scan-repository`/`scan-ref`/`scan-token` 参数让插件自动克隆目标仓到 `source-dir`。

---

## 5. 插件输出文件结构

扫描完成后生成的 `metrics.json` 完整结构：

```json
{
  "codeScale": 12345,
  "avgFunctionLoc": 15.30,
  "avgCyclomaticComplexity": 3.20,
  "totalCodeDuplicationRate": 6.05,
  "totalFileDuplicationRate": 2.10,
  "fileDetails": [
    {
      "filePath": "src/main/App.java",
      "language": "Java",
      "loc": 120,
      "functionCount": 5,
      "avgFunctionLoc": 12.40,
      "avgCyclomaticComplexity": 2.80,
      "functionDetails": [
        {
          "functionName": "MyClass.myMethod",
          "functionLoc": 15,
          "startLine": 42,
          "endLine": 60
        }
      ],
      "duplicationRate": 15.50,
      "duplicationLineCount": 18,
      "duplicatedFiles": []
    }
  ],
  "identicalFileDetails": [
    {
      "filePath": "src/copy/App.java",
      "duplicatedFiles": ["src/main/App.java", "src/backup/App.java"]
    }
  ],
  "detectionInfo": {
    "startTime": "2026-06-30 10:00:00",
    "endTime": "2026-06-30 10:05:00",
    "durationMs": 300000,
    "sources": ["/path/to/source"],
    "tools": { "sloc": true, "lizard": true, "duplication": true }
  },
  "uploadInfo": {
    "success": true,
    "recordId": 42
  }
}
```

---

## 6. 依赖说明

| 依赖 | 类型 | 安装方式 | 用途 |
|------|------|---------|------|
| scc | 内置二进制（`dist/bin/scc`） | 无需安装 | 代码行数统计 |
| lizard | Python 包 | `pip install lizard` | 函数复杂度分析 |
| radon | Python 包 | `pip install radon` | 圈复杂度辅助计算 |
| jscpd | npm 依赖（已打包进 dist） | 无需安装 | 代码重复检测 |

---

> 文档更新日期：2026-07-09
