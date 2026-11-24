// 规范化 ncc 构建产物 dist/index.js，使其通过 pre-commit 通用钩子检查。
//
// 背景：ncc 会把依赖包源码（如 @actions/core、esdk-obs-nodejs）原样内联进 bundle，
// 这些第三方代码自带行尾空白，且 ncc 输出末尾缺少换行符，导致提交的 dist/index.js
// 无法通过 trailing-whitespace / end-of-file-fixer 钩子。CI 的 dist 一致性门禁
// 重建时执行同一条 npm run package，因此本规范化步骤必须挂在 package 脚本内，
// 保证"重建输出 === 已提交产物"。
const fs = require('fs');

const file = 'dist/index.js';
let content = fs.readFileSync(file, 'utf8');

// 1) 统一为 LF 行尾，避免本地 Windows 构建与 CI Linux 构建产出不同行尾
content = content.replace(/\r\n/g, '\n');
// 2) 去除每行行尾空白（空格/Tab），消除第三方内联代码自带的尾随空白
content = content
  .split('\n')
  .map((line) => line.replace(/[ \t]+$/, ''))
  .join('\n');
// 3) 确保文件以恰好一个换行符结尾：缺失则补一个，多余则收敛为一个
if (!content.endsWith('\n')) {
  content += '\n';
}
while (content.endsWith('\n\n')) {
  content = content.slice(0, -1);
}

fs.writeFileSync(file, content);
