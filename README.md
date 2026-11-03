# code-metrics-action

代码度量扫描插件，检测代码规模、平均函数代码行数、平均圈复杂度、代码重复率和文件重复率，帮助团队量化代码质量与重复度。

## 功能

| 指标             | 说明                               | 支持语言             |
| ---------------- | ---------------------------------- | -------------------- |
| 代码规模         | 有效代码行数                       | 200+ 种（scc 驱动）  |
| 平均函数代码行数 | 函数体有效代码行的算术平均值       | 26 种（lizard 驱动） |
| 平均圈复杂度     | 函数级圈复杂度的算术平均值         | 同上（lizard 驱动）  |
| 代码重复率       | 重复代码行占有效代码行的百分比     | 语言无关             |
| 文件重复率       | 内容完全一致文件占总文件数的百分比 | 语言无关             |

> 💡 **语言支持交集说明**：插件的 5 项指标由不同能力驱动——代码规模走 `scc`（200+ 语言），平均函数代码行数 / 平均圈复杂度走 `lizard`，两项重复率走内置文本比对（语言无关）。因此**能完整产出全部 5 项指标的语言**即 `scc 与 lizard` 的支持交集。`lizard` 未覆盖的语言仍可统计代码规模与两项重复率，但无法产出函数级指标。

`lizard` 支持（可完整扫描 5 项指标）的 26 种语言：

```text
C/C++  C#  Java  JavaScript/JSX  TypeScript/TSX  Python  Ruby  PHP  Go  Rust
Kotlin  Scala  Swift  Objective-C  Lua  Perl  R  PL/SQL  Vue.js  Erlang
Fortran  GDScript  Solidity  Structured Text  TTCN-3  Zig
```

> 上述 26 种语言是缺省扩展名白名单（50+，见「扫描范围」）中能完整产出 5 项指标的子集；白名单中的其他语言（Shell、JSON/XML/YAML 等）仅统计代码规模与重复率。

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

## GitHub Actions 接入（OIDC 免密）

插件支持在 GitHub Actions 中运行，采用 **OIDC 免密认证**：插件向 GitHub Actions 申请 OIDC ID Token，再换取华为云临时凭证，仓库中无需配置任何长期密钥。

引用方式：

```yaml
name: code-metrics-scan

on:
  # 手动触发：仓库 Actions 页面点击 Run workflow
  workflow_dispatch:
  # 代码推送触发：合并到主分支后自动扫描
  push:
    branches:
      - master

# OIDC 免密认证：必须声明 id-token: write，插件据此向平台申请 ID Token 换取华为云临时凭证
permissions:
  contents: read
  id-token: write

concurrency:
  group: code-metrics-scan-${{ github.ref }}
  cancel-in-progress: true

jobs:
  code-metrics-scan:
    name: 代码度量检测
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      # 使用本仓库内的插件（迁移验证），OIDC 模式调用 APIG 接口，无需配置任何密钥
      - name: Code metrics scan
        uses: openlibing/code-metrics-action@master
        with:
```

> OIDC 免密依赖华为云侧已完成 GitHub 身份提供商（`GitHubActions`，颁发者 `https://token.actions.githubusercontent.com`）与信任委托配置，未配置时换证会失败。

工作流支持手动触发与推送到主分支自动触发；运行结束后在运行摘要页以表格展示仓库/分支/提交/流水线等扫描信息、5 项指标及平台详情链接。

> 插件运行时自动识别平台：GitHub 取 `GITHUB_*` 上下文（分支、提交、运行编号、工作流名），GitCode 回退 `ATOMGIT_*`，同一份代码可在两个平台运行。

## GitCode Actions 接入

```yaml
name: code-metrics-scan

on:
  # 三种触发方式可按需选择（可组合启用），示例默认只保留手动触发：
  # 1) workflow_dispatch：手动触发，在流水线页面按需执行
  workflow_dispatch:
  # 2) push：代码推送触发，推送到指定分支时自动执行（按需启用，示例已注释）
  # push:
  #   branches:
  #     - master
  # 3) schedule：定时触发，按 cron 表达式定期执行（按需启用，示例已注释）
  # schedule:
  #   - cron: "0 0 0 * * ?"

permissions:
  repository: read
  id-token: write

jobs:
  code-metrics-scan:
    name: 代码度量指标扫描
    # 这里使用的是官方默认执行机，请按需切换为自定义执行机（如 ["self-hosted", "region=cn"]）
    runs-on: ["codearts-hosted", "ubuntu-latest", "x64", "slim"]
    steps:
      - name: Checkout
        uses: checkout

      - name: code-metrics-scan
        uses: openlibing/code-metrics-action@v1.0.3
        with:
          # 可选：排除指定目录/文件，不传 exclude-dirs 时除内置排除目录外默认全量扫描
          # exclude-dirs: "node_modules,target,dist,.git,.gitcode,.mvn,.trae,vendor"
          # 可选：指定扫描的文件扩展名（覆盖式：只扫指定扩展名 + 文件名特例，
          # 如 CMakeLists.txt / Makefile 等构建文件始终放行）；
          # 不传时按内置"常见代码扩展名白名单 + 文件名特例"扫描
          # allowed-extensions: ".c,.cpp,.h"
```

## 触发方式

| 触发方式     | 配置关键字                                | 适用场景                             |
| ------------ | ----------------------------------------- | ------------------------------------ |
| 手动触发     | `workflow_dispatch`                       | 按需验证、首次接入验证               |
| 代码推送触发 | `push.branches` / `pull_request.branches` | 合入主分支时自动检测                 |
| 定时任务触发 | `schedule.cron`                           | Nightly 流水线，每日定期检测跟踪趋势 |

## 输入参数

| 参数               | 必填 | 默认值                                      | 说明                                                                                                |
| ------------------ | ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| exclude-dirs       | 否   | -                                           | 排除目录/文件列表，逗号分隔，支持通配符，不填时除内置排除目录外默认全量扫描                         |
| allowed-extensions | 否   | 50+ 常见代码扩展名，<br/>详情见「扫描范围」 | 允许的文件扩展名，逗号分隔。                                                                        |
| output             | 否   | metrics.json                                | 结果输出文件路径                                                                                    |
| apig-app-key       | 否   | -                                           | **已废弃**：APIG 网关 AppKey（AK）。请使用新的 OIDC 认证方式（见下方「上传认证」），无需任何凭证    |
| apig-app-secret    | 否   | -                                           | **已废弃**：APIG 网关 AppSecret（SK），与 apig-app-key 配套。请使用新的 OIDC 认证方式，无需任何凭证 |
| obs-ak             | 否   | -                                           | **已废弃**：OBS 访问密钥 AK。请使用新的 OIDC 认证方式，无需任何凭证                                 |
| obs-sk             | 否   | -                                           | **已废弃**：OBS 访问密钥 SK，与 obs-ak 配套。请使用新的 OIDC 认证方式，无需任何凭证                 |

上传功能默认开启：全量上报文件（元数据 + 总体指标 + fileDetails + identicalFileDetails + duplicationOccurrences）先上传到 OBS，再通过 APIG 接口上报元数据与 OBS 下载链接。

### 上传认证

上传功能默认开启，插件使用OIDC 联邦认证，无需任何凭证。已适配 OIDC 的 workflow 示例：

```yaml
permissions:
  id-token: write
```

### 扫描范围（文件过滤规则）

文件按"三段式"规则决定是否参与扫描，优先级从高到低：

1. **文件名特例（始终放行）**：`CMakeLists.txt`、`Makefile`、`GNUMakefile`、`Dockerfile`、`Jenkinsfile`、`Rakefile`、`Gemfile`、`build`、`build.bazel`、`WORKSPACE` 等按文件名识别的构建/入口文件，不受扩展名白名单限制。
2. **`allowed-extensions` 显式指定（覆盖式）**：用户指定扩展名后，扫描范围 = 指定扩展名 + 文件名特例，**不再叠加缺省白名单**。例如指定 `.h,.cpp`，则只扫描这两类扩展名的文件（外加 CMakeLists.txt 等特例文件）。
3. **缺省代码扩展名白名单（未配置 `allowed-extensions` 时生效）**：内置 50+ 常见代码扩展名（C/C++、Java、Python、JS/TS、Go、Rust、Shell、JSON/XML/YAML 等数据配置，以及 `.gn`/`.gni`/`.prelds` 等 OHOS 构建体系脚本），避免二进制、文档等非代码文件干扰度量。

**目录剪枝**：上述规则只针对文件；目录层面默认自动排除版本控制与 IDE 私有目录（`.git`、`.svn`、`.hg`、`.idea`、`.vscode`），其下文件不参与任何指标计算；其余隐藏目录（如平台流水线的 `.gitcode`、`.github`）正常参与扫描。需要排除更多目录请使用 `exclude-dirs`。

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

### 概览输出（ATOMGIT_OUTPUT）

扫描完成后，插件会将每项指标通过 `ATOMGIT_OUTPUT` 输出为独立的键值对，便于工作流页面直接查看概览（不含明细）。每项指标的标识为 中文名（英文名），按顺序排列为：代码规模（codeScale）、平均代码行数（avgFunctionLoc）、平均圈复杂度（avgCyclomaticComplexity）、总代码重复率（totalCodeDuplicationRate）、总文件重复率（totalFileDuplicationRate）。重复率指标为带 `%` 的百分数。

| 输出标识                                   | 值     |
| ------------------------------------------ | ------ |
| `代码规模（codeScale）`                    | `2025` |
| `平均代码行数（avgFunctionLoc）`           | `12.5` |
| `平均圈复杂度（avgCyclomaticComplexity）`  | `3.2`  |
| `总代码重复率（totalCodeDuplicationRate）` | `0.5%` |
| `总文件重复率（totalFileDuplicationRate）` | `1.2%` |

#### 平台详情链接输出

上报成功后，插件输出 1 条该扫描仓在 openLiBing 平台分支管理页的跳转链接（固定 1 行）；运行日志（`core.info`）同时打印实际链接便于查看。

输出标识为`扫描结果url`，示例：

```text
扫描结果url=https://www.openlibing.com/apps/repos?projectId=3&platforms=gitcode&repoUrlLike=test%2Frepo&branchNameLike=master
```

仓未录入 openLiBing 平台或分支未登记时，不输出链接，改为输出提示行（文案由服务端返回，插件不硬编码）：

```text
扫描结果=当前仓未录入openLiBing平台，无法生成跳转链接，请先联系SRE完成代码仓录入。
```

```text
扫描结果=当前分支未录入openLiBing平台，请前往openLiBing平台同步最新分支
```

> **说明**
>
> - 链接由服务端拼接，同一代码仓关联多个项目时，固定输出查询第一个项目对应的 1 条链接（不输出多链接）。
> - 链接落地页展示的指标数据恒为该分支**最新一次成功检测结果**，非历史流水线运行数据。
> - 上报失败或链接构建异常时既不输出链接也不输出提示；写入失败时跳过输出，不影响上报结果。

## 依赖

- **scc** — 代码行数统计（内置二进制包）
- **lizard** — 计算函数数、函数代码行数与圈复杂度（Python 包，运行时自动安装）
- **重复代码与文件重复检测** — 插件内置实现，无需额外依赖
