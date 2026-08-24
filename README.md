# code-metrics-action

代码度量扫描插件，检测代码规模、扫描总行数、注释行数、总圈复杂度、文件维度圈复杂度、重复代码块数量、重复代码行数量、平均函数代码行数、平均圈复杂度、代码重复率和文件重复率，帮助团队量化代码质量与重复度。

## 功能

| 指标             | 说明                               |
| ---------------- | ---------------------------------- |
| 代码规模         | 有效代码行数                       |
| 扫描总行数       | 代码 + 注释 + 空行的物理总行数     |
| 注释行数         | 所有文件注释行数之和               |
| 总圈复杂度       | 所有函数圈复杂度之和               |
| 文件维度圈复杂度 | 总圈复杂度 ÷ 含函数的文件数        |
| 重复代码块数量   | 重复块出现位置总数                 |
| 重复代码行数量   | 所有文件重复行数之和               |
| 平均函数代码行数 | 函数体有效代码行的算术平均值       |
| 平均圈复杂度     | 函数级圈复杂度的算术平均值         |
| 代码重复率       | 重复代码行占有效代码行的百分比     |
| 文件重复率       | 内容完全一致文件占总文件数的百分比 |

## 指标说明

- **有效代码行**：非空非注释代码行。C/C++ 预处理指令（`#include`/`#define` 等）计入代码行。
- **扫描总行数**（`codeLineTotal`）：扫描范围内所有文件的物理总行数（代码行 + 注释行 + 空行），区别于代码规模（有效代码行）。
- **注释行数**（`commentLines`）：扫描范围内所有文件注释行数的总和（直接取 scc 汇总值；每文件注释行数另存于 `code_metrics_file_detail` 供文件级下钻）。
- **总圈复杂度**（`complexityCount`）：所有函数圈复杂度之和（方法维度总量，与平均圈复杂度同源）。
- **文件维度圈复杂度**（`cyclomaticComplexityPerFile`）：总圈复杂度 ÷ 含函数的文件数，区别于方法维度的平均圈复杂度。
- **重复代码块数量**（`duplicatedBlocks`）：重复块出现位置总数（同一代码内容在 3 个文件中出现计 3），与 `code_metrics_duplication_block` 表行数一致。
- **重复代码行数量**（`duplicatedLines`）：所有文件重复行数之和（代码重复率的分子）。
- **函数体有效代码行**：不包含函数名和函数参数在内的有效代码行。
- **重复代码**：非空非注释源代码行连续 10 行相同的代码片段即为重复代码（import 行也计入）。
- **代码重复率**：重复代码行占有效代码行的百分比。
- **文件级代码重复率**：将该文件的代码与代码仓中所有文件的代码进行比对，重复代码行数占该文件有效代码行数的百分比。
- **总文件重复率**：内容完全一致的文件数 ÷ 仓库总文件数 × 100%。若文件 A 与文件 B 内容完全一致，则 A 和 B 均计入分子（共 2 个文件），源文件本身也计入比率。

### 重复代码计数规则

- **多文件相同重复块**：若 3 个文件都包含相同的 10 行重复代码，则总代码重复行数 +30（每个文件的 10 行均计入）。
- **同文件多段重复取并集**：若 A 文件第 1-10 行与 B 文件重复，第 2-11 行与 C 文件重复，则 A 文件的重复代码行数取两段重复区间的并集，即第 1-11 行共 11 行；此时总代码重复行数为 31（A 的 11 行 + B 的 10 行 + C 的 10 行）。

## 使用方式

```yaml
name: code-metrics-scan

on:
  workflow_dispatch:
  push:
    branches:
      - master
  schedule:
    - cron: "0 0 0 * * ?"

jobs:
  code-metrics-scan:
    name: 代码度量指标扫描
    runs-on: ["codearts-hosted", "ubuntu-latest", "x64", "slim"]
    steps:
      - name: Checkout
        uses: checkout

      - name: code-metrics-scan
        uses: openlibing-code-metrics-action
        with:
          # 可选：排除指定目录/文件，不传 exclude-dirs 默认全路径扫描
          # exclude-dirs: "node_modules,target,dist,.git,.gitcode,.mvn,.trae,vendor"
          # 可选：扫描指定文件后缀的文件，不传 allowed-extensions 默认扫描全部文件
          # allowed-extensions: ".c,.cpp,.h"
          apig-app-key: ${{ secrets.OPENLIBING_APIG_KEY }}
          apig-app-secret: ${{ secrets.OPENLIBING_APIG_SECRET }}
```

## 触发方式

| 触发方式     | 配置关键字                                | 适用场景                             |
| ------------ | ----------------------------------------- | ------------------------------------ |
| 手动触发     | `workflow_dispatch`                       | 按需验证、首次接入验证               |
| 代码推送触发 | `push.branches` / `pull_request.branches` | 合入主分支时自动检测                 |
| 定时任务触发 | `schedule.cron`                           | Nightly 流水线，每日定期检测跟踪趋势 |

## 输入参数

| 参数               | 必填 | 默认值       | 说明                                                                                                  |
| ------------------ | ---- | ------------ | ----------------------------------------------------------------------------------------------------- |
| exclude-dirs       | 否   | -            | 排除目录列表，逗号分隔，不填时默认扫描全部路径                                                        |
| allowed-extensions | 否   | -            | 允许的文件扩展名，逗号分隔，不填时默认扫描所有文件类型                                                |
| output             | 否   | metrics.json | 结果输出文件路径                                                                                      |
| apig-app-key       | 是   | -            | APIG 网关 AppKey，用于上传检测结果到 openLiBing 平台（上传功能默认开启，此项必填，经 `with` 传入）    |
| apig-app-secret    | 是   | -            | APIG 网关 AppSecret，用于上传检测结果到 openLiBing 平台（上传功能默认开启，此项必填，经 `with` 传入） |

上传功能默认开启，凭据通过以下输入参数传入（通过 APIG 网关调用 openLiBing 接口）：`apig-app-key` / `apig-app-secret`。请在 workflow 的 `with` 中传入，凭证值使用 `${{ secrets.OPENLIBING_APIG_KEY }}` / `${{ secrets.OPENLIBING_APIG_SECRET }}` 引用。

## 输出

| 输出                        | 说明                     |
| --------------------------- | ------------------------ |
| code-scale                  | 代码规模（有效代码行数） |
| avg-function-loc            | 平均函数代码行数         |
| avg-cyclomatic-complexity   | 平均圈复杂度             |
| total-code-duplication-rate | 代码重复率（%）          |
| total-file-duplication-rate | 文件重复率（%）          |

## 依赖

- **scc** — 代码行数统计（内置二进制包）
- **lizard** — 计算函数数、函数代码行数与圈复杂度（Python 包，运行时自动安装）
- **重复代码与文件重复检测** — 插件内置实现，无需额外依赖
