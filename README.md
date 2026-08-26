# code-metrics-action

代码度量扫描插件，检测代码规模、平均函数代码行数、平均圈复杂度、代码重复率和文件重复率，帮助团队量化代码质量与重复度。

## 功能

| 指标             | 说明                               |
| ---------------- | ---------------------------------- |
| 代码规模         | 有效代码行数                       |
| 平均函数代码行数 | 函数体有效代码行的算术平均值       |
| 平均圈复杂度     | 函数级圈复杂度的算术平均值         |
| 代码重复率       | 重复代码行占有效代码行的百分比     |
| 文件重复率       | 内容完全一致文件占总文件数的百分比 |

## 指标说明

- **有效代码行**：非空非注释代码行。C/C++ 预处理指令（`#include`/`#define` 等）计入代码行。
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
          # 可选：指定扫描的文件扩展名（覆盖式：只扫指定扩展名 + 文件名特例，
          # 如 CMakeLists.txt / Makefile 等构建文件始终放行）；
          # 不传时按内置"常见代码扩展名白名单 + 文件名特例"扫描
          # allowed-extensions: ".c,.cpp,.h"
          apig-app-key: ${{ secrets.OPENLIBING_APIG_KEY }}
          apig-app-secret: ${{ secrets.OPENLIBING_APIG_SECRET }}
          obs-ak: ${{ secrets.OPENLIBING_OBS_AK }}
          obs-sk: ${{ secrets.OPENLIBING_OBS_SK }}
```

## 触发方式

| 触发方式     | 配置关键字                                | 适用场景                             |
| ------------ | ----------------------------------------- | ------------------------------------ |
| 手动触发     | `workflow_dispatch`                       | 按需验证、首次接入验证               |
| 代码推送触发 | `push.branches` / `pull_request.branches` | 合入主分支时自动检测                 |
| 定时任务触发 | `schedule.cron`                           | Nightly 流水线，每日定期检测跟踪趋势 |

## 输入参数

| 参数               | 必填 | 默认值                              | 说明                                                                                                                                           |
| ------------------ | ---- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| exclude-dirs       | 否   | -                                   | 排除目录/文件列表，逗号分隔，支持通配符，不填时默认扫描全部路径                                                                                |
| allowed-extensions | 否   | 50+ 常见代码扩展名，<br/>详情见下文 | 允许的文件扩展名，逗号分隔。                                                                                                                   |
| output             | 否   | metrics.json                        | 结果输出文件路径                                                                                                                               |
| apig-app-key       | 是   | -                                   | APIG 网关 AppKey，用于上报检测结果到 openLiBing 平台（上传功能默认开启，此项必填，经 `with` 传入）                                             |
| apig-app-secret    | 是   | -                                   | APIG 网关 AppSecret，用于上报检测结果到 openLiBing 平台（上传功能默认开启，此项必填，经 `with` 传入）                                          |
| obs-ak             | 是   | -                                   | OBS 访问密钥 AK，全量上报文件上传到 openLiBing 统一桶（openlibing-gitcode-action/code-metrics-action/），与 upload-sarif-action 复用同一套凭证 |
| obs-sk             | 是   | -                                   | OBS 访问密钥 SK，与 obs-ak 配套                                                                                                                |

上传功能默认开启：全量上报文件（元数据 + 总体指标 + fileDetails + identicalFileDetails + duplicationOccurrences）先上传到 OBS，再通过 APIG 接口上报元数据与 OBS 下载链接。凭据通过 `apig-app-key` / `apig-app-secret`（APIG）与 `obs-ak` / `obs-sk`（OBS）传入，请在 workflow 的 `with` 中传入。

### 扫描范围（文件过滤规则）

文件按"三段式"规则决定是否参与扫描，优先级从高到低：

1. **文件名特例（始终放行）**：`CMakeLists.txt`、`Makefile`、`GNUMakefile`、`Dockerfile`、`Jenkinsfile`、`Rakefile`、`Gemfile`、`build`、`build.bazel`、`WORKSPACE` 等按文件名识别的构建/入口文件，不受扩展名白名单限制。
2. **`allowed-extensions` 显式指定（覆盖式）**：用户指定扩展名后，扫描范围 = 指定扩展名 + 文件名特例，**不再叠加缺省白名单**。例如指定 `.h,.cpp`，则只扫描这两类扩展名的文件（外加 CMakeLists.txt 等特例文件）。
3. **缺省代码扩展名白名单（未配置 `allowed-extensions` 时生效）**：内置 50+ 常见代码扩展名（C/C++、Java、Python、JS/TS、Go、Rust、Shell、JSON/XML/YAML 等数据配置，以及 `.gn`/`.gni`/`.prelds` 等 OHOS 构建体系脚本），避免二进制、文档等非代码文件干扰度量。

### 排除规则（exclude-dirs）

`exclude-dirs` 用逗号分隔，支持通配符，大小写敏感，匹配目标为条目相对扫描根的路径：

| 写法                                                     | 匹配范围                                         |
| -------------------------------------------------------- | ------------------------------------------------ |
| 裸名称（如 `test.ts`、`docs`）                           | 仅扫描根顶层同名条目                             |
| 通配符名称（如 `*.test.js`、`*test*`）                   | 任意层级同名条目                                 |
| 路径（如 `src/opensource/grapesjs`、`src/opensource/*`） | 锚定扫描根，匹配相对路径，命中目录即整棵子树剪枝 |

通配符说明：`*` 匹配单段内任意字符（不含 `/`）、`**` 跨目录、`?` 单字符、`[abc]`/`[!abc]` 字符类。前导 `/` 为可选锚定写法（`/test.ts` 仅匹配顶层），尾部 `/` 忽略（`docs/` ≡ `docs`）。目录与文件统一适用同一条规则。

示例：`exclude-dirs: "*.test.js,src/opensource/*"` 排除任意层级的 `.test.js` 文件和 `src/opensource` 直属子目录。

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
