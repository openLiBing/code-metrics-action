# openlibing-code-metrics-action

代码度量扫描插件 - 检测代码规模、平均函数代码行数、平均圈复杂度、代码重复率和文件重复率。

## 功能

| 指标 | 说明 | 工具 |
|------|------|------|
| 代码规模 | 有效代码行数 | scc |
| 平均函数代码行数 | 函数体有效代码行的算术平均值 | lizard |
| 平均圈复杂度 | 函数级圈复杂度的算术平均值 | lizard |
| 代码重复率 | 跨文件重复代码行占有效代码行的百分比 | jscpd |
| 文件重复率 | 内容完全一致文件占总文件数的百分比 | MD5哈希比对 |

## 使用方式

```yaml
name: openlibing-code-metrics-action

on:
  workflow_dispatch:
  push:
    branches: [ "master" ]

jobs:
  code-metrics-scan:
    name: 代码度量检测
    runs-on: ["codearts-hosted", "ubuntu-latest", "x64", "slim"]
    steps:
      - name: Checkout
        uses: checkout

      - name: code-metrics-scan
        uses: openlibing-code-metrics-action
        env:
          OPENLIBING_APIG_KEY: ${{ secrets.OPENLIBING_APIG_KEY }}
          OPENLIBING_APIG_SECRET: ${{ secrets.OPENLIBING_APIG_SECRET }}
```

## 触发方式

| 触发方式     | 配置关键字                                | 适用场景                                      |
| ------------ | ----------------------------------------- | --------------------------------------------- |
| 手动触发     | `workflow_dispatch`                       | 按需验证、首次接入验证                        |
| 代码推送触发 | `push.branches` / `pull_request.branches` | 合入主分支时自动检测                 |
| 定时任务触发 | `schedule.cron`                           | Nightly 流水线，每日定期检测跟踪趋势 |

## 输入参数

| 参数 | 必填 | 默认值         | 说明                                  |
|------|------|-------------|-------------------------------------|
| exclude-dirs | 否 | -           | 排除目录列表，逗号分隔，不填时默认扫描全部路径             |
| allowed-extensions | 否 | -           | 允许的文件扩展名，逗号分隔，不填时默认扫描所有文件类型         |
| output | 否 | metrics.json | 结果输出文件路径                            |
| upload | 否 | true        | 是否上传检测结果到 coderepo 服务               |

## 环境变量

上传功能需要以下环境变量（通过 APIG 网关调用 openLiBing 接口），请在`项目设置 -> Actions 密钥与变量 -> 仓库密钥中进行配置`：

| 变量 | 必填 | 说明                                        |
|------|------|-------------------------------------------|
| OPENLIBING_APIG_KEY | 是 | APIG 网关 AppKey（即 AK，用于 HMAC-SHA256 签名）    |
| OPENLIBING_APIG_SECRET | 是 | APIG 网关 AppSecret（即 SK，用于 HMAC-SHA256 签名） |

## 输出

| 输出 | 说明 |
|------|------|
| code-scale | 代码规模（有效代码行数） |
| avg-function-loc | 平均函数代码行数 |
| avg-cyclomatic-complexity | 平均圈复杂度 |
| total-code-duplication-rate | 代码重复率（%） |
| total-file-duplication-rate | 文件重复率（%） |

## 依赖

- **scc** - 代码行数统计（内置二进制包 bin/scc）
- **lizard** - 函数复杂度分析（Python 包，需 pip install）
- **jscpd** - 代码重复检测（npm 依赖）
