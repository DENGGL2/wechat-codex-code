import { runAcceptanceScenarios } from '../dist/wechat-acceptance-scenarios.js';

const results = runAcceptanceScenarios();

for (const result of results) {
  console.log(`## ${result.id}`);
  console.log(`输入：${result.input}`);
  console.log(`期望：${result.expected}`);
  console.log(`实际返回：${result.actual}`);
  console.log(`是否达标：${result.passed ? '是' : '否'}`);
  console.log(`说明：${result.notes.join('；')}`);
  console.log('');
}

const failed = results.filter(result => !result.passed);
if (failed.length > 0) {
  process.exit(1);
}
