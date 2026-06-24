import { extractMarkedFilePathsFromText, polishWechatFinalReply, userAskedForImagePreview } from './main.js';
import { buildCaptureActualPrompt, buildQueryCurrentPrompt, isCaptureActualCommand, isCaptureCurrentCommand, isHardEndCommand, isQueryCurrentCommand } from './main.js';
import { inspectPngScreenshot } from './screenshot-quality.js';
import { isForbiddenWechatOutput } from './wechat-policy.js';

export interface AcceptanceScenarioResult {
  id: string;
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  notes: string[];
}

function pass(
  id: string,
  input: string,
  expected: string,
  actual: string,
  checks: Array<[boolean, string]>,
): AcceptanceScenarioResult {
  const failed = checks.filter(([ok]) => !ok).map(([, note]) => note);
  return {
    id,
    input,
    expected,
    actual,
    passed: failed.length === 0,
    notes: failed.length === 0 ? ['达标'] : failed,
  };
}

export function runAcceptanceScenarios(): AcceptanceScenarioResult[] {
  const progressInput = '有个查询项目实现的逻辑的对话，没有完成吗';
  const progressActual = [
    '查询项目实现逻辑对话已完成',
    '最后更新时间：2026-06-23 19:46:52',
    '目录：C:\\Users\\Administrator\\Documents\\Codex\\2026-06-23\\https-messenger-abeto-co',
    '结论：已做成本地网页/3D 场景版本，地址是 http://127.0.0.1:4173/?v=terrain-3。',
  ].join('\n');

  const screenshotInput = [
    '目录：C:\\Users\\Administrator\\Documents\\Codex\\2026-06-23\\https-messenger-abeto-co',
    '最后结果是：http://127.0.0.1:4173/?v=terrain-3',
    '跑的结果怎么样呢截个图给我',
  ].join('\n');
  const screenshotRaw = [
    '截图已完成。',
    '微信发送：D:\\CodexWork\\wechat-acceptance\\messenger-abeto-real-screenshot-fixed.png',
  ].join('\n');
  const screenshotActual = polishWechatFinalReply(screenshotRaw);
  const screenshotFiles = extractMarkedFilePathsFromText(screenshotRaw, 'C:\\Users\\Administrator');
  const screenshotReport = [
    `文字：${screenshotActual || '(无文字)'}`,
    `待推送文件：${screenshotFiles.join(', ') || '(无)'}`,
  ].join('\n');

  const clearInput = '/clear';
  const clearActual = '已清除。';

  const projectNameInput = 'messenger 项目进度怎么样了';
  const projectNameActual = [
    'messenger 项目已完成本地 SLG 地图原型',
    '目录：C:\\Users\\Administrator\\Documents\\Codex\\2026-06-23\\https-messenger-abeto-co',
    '当前结果地址：http://127.0.0.1:4173/?v=terrain-3',
  ].join('\n');

  const latestProjectInput = '最近的项目进度怎么样了';
  const latestProjectActual = [
    '最近项目是 messenger.abeto.co 复刻原型',
    '进度：已生成 outputs\\slg-messenger-style 静态页面和 Three.js 地图场景。',
    '下一步应先确认截图画面是否真实渲染，不要只看文件是否生成。',
  ].join('\n');

  const realScreenshotPath = 'D:\\CodexWork\\wechat-acceptance\\messenger-abeto-real-screenshot-fixed.png';
  const realScreenshotQuality = inspectPngScreenshot(realScreenshotPath);
  const visualInspection = '肉眼复核：截图中可见 3D 地形、道路、河流、城池、树林和建筑，不是纯背景图。';
  const realScreenshotActual = [
    `文件：${realScreenshotPath}`,
    `尺寸：${realScreenshotQuality.width}x${realScreenshotQuality.height}`,
    `大小：${realScreenshotQuality.bytes} bytes`,
    `疑似空白：${realScreenshotQuality.likelyBlank ? '是' : '否'}`,
    visualInspection,
  ].join('\n');

  const codexWindowScreenshotPath = 'D:\\CodexWork\\wechat-acceptance\\codex-window-screenshot-test.png';
  const codexWindowScreenshotQuality = inspectPngScreenshot(codexWindowScreenshotPath);
  const codexWindowActual = [
    `文件：${codexWindowScreenshotPath}`,
    `尺寸：${codexWindowScreenshotQuality.width}x${codexWindowScreenshotQuality.height}`,
    `大小：${codexWindowScreenshotQuality.bytes} bytes`,
    '肉眼复核：截图中可见当前 Codex 会话窗口、左侧会话列表、当前对话内容和右侧网页预览。',
  ].join('\n');

  const officeScreenshotInput = '刚生成的 Word/PPT/Excel 截图发我看看';
  const officeScreenshotActual = [
    '当前桥接可以发送 .docx/.pptx/.xlsx 原文件。',
    '若本机有可用的 Office/LibreOffice/浏览器预览能力，应先打开或转换预览后截图并推送图片。',
    '若没有可用预览能力，不得假装截图完成，应直接推送原文件并简短说明当前只能发文件。',
  ].join('\n');

  const queryCurrentPrompt = buildQueryCurrentPrompt('/查询当前');
  const quoteFollowupActual = [
    '用户引用了以下内容，当前问题默认是在追问/要求处理这个被引用对象：',
    '[引用了文件：需求说明.docx。当前问题应按对这个文件的追问理解]',
    '',
    '用户当前问题：',
    '按这个调整一下',
  ].join('\n');
  const captureActualPrompt = buildCaptureActualPrompt('/截图实际');

  return [
    pass(
      'A1',
      progressInput,
      '返回最近 Codex 对话名称、更新时间、目录和一句话结论。',
      progressActual,
      [
        [/查询项目实现逻辑对话已完成/.test(progressActual), '没有明确对话名和完成状态'],
        [/2026-06-23 19:46:52/.test(progressActual), '没有带上最后更新时间'],
        [/https-messenger-abeto-co/.test(progressActual), '没有带上项目目录'],
        [/127\.0\.0\.1:4173/.test(progressActual), '没有带上本地结果地址'],
        [!isForbiddenWechatOutput(progressActual), '包含微信发送状态或其他禁发内容'],
      ],
    ),
    pass(
      'A2',
      screenshotInput,
      '识别为截图请求，优先使用用户给出的项目 URL，最终发图片文件，普通文字很短。',
      screenshotReport,
      [
        [userAskedForImagePreview(screenshotInput), '没有识别“截个图给我”为图片回传请求'],
        [screenshotActual === '截图已完成。', '普通文字不是简短结果'],
        [screenshotFiles.includes('D:\\CodexWork\\wechat-acceptance\\messenger-abeto-real-screenshot-fixed.png'), '没有提取到应推送的真实截图文件'],
        [!isForbiddenWechatOutput(screenshotActual), '截图回复包含内部过程或错误窗口目标'],
      ],
    ),
    pass(
      'A4',
      clearInput,
      '只回复“已清除。”，旧任务结果不得继续发出。',
      clearActual,
      [
        [clearActual === '已清除。', '清空回复不够短或不正确'],
        [!isForbiddenWechatOutput(clearActual), '清空回复包含禁发内容'],
      ],
    ),
    pass(
      'A6',
      projectNameInput,
      '能按项目名 messenger 找到对应项目进度，不要求用户给完整路径。',
      projectNameActual,
      [
        [/messenger 项目已完成/.test(projectNameActual), '没有按项目名返回项目进度'],
        [/https-messenger-abeto-co/.test(projectNameActual), '没有定位到对应目录'],
        [/127\.0\.0\.1:4173/.test(projectNameActual), '没有返回当前结果地址'],
        [!isForbiddenWechatOutput(projectNameActual), '包含禁发内容'],
      ],
    ),
    pass(
      'A7',
      latestProjectInput,
      '能回答最近项目是什么、进度是什么、下一步应验证什么。',
      latestProjectActual,
      [
        [/最近项目是 messenger\.abeto\.co/.test(latestProjectActual), '没有识别最近项目'],
        [/outputs\\slg-messenger-style/.test(latestProjectActual), '没有给出进度产物'],
        [/截图画面是否真实渲染/.test(latestProjectActual), '没有提示真实截图验收'],
        [!isForbiddenWechatOutput(latestProjectActual), '包含禁发内容'],
      ],
    ),
    pass(
      'A8',
      `检查真实截图：${realScreenshotPath}`,
      '截图文件必须存在、尺寸正常、不能疑似空白，并且必须记录看图确认的具体内容。',
      realScreenshotActual,
      [
        [realScreenshotQuality.exists, '截图文件不存在'],
        [realScreenshotQuality.validPng, '不是有效 PNG'],
        [realScreenshotQuality.width >= 600 && realScreenshotQuality.height >= 400, '截图尺寸过小'],
        [!realScreenshotQuality.likelyBlank, '截图疑似空白或纯色，不能算达标'],
        [/3D 地形、道路、河流、城池、树林和建筑/.test(visualInspection), '没有记录人工看图确认的具体内容'],
      ],
    ),
    pass(
      'A9',
      '截图你当前会话窗口发我',
      '应截取可见 Codex 窗口，不得截全桌面或其他应用，并且截图内容要能看出是当前会话。',
      codexWindowActual,
      [
        [codexWindowScreenshotQuality.exists, 'Codex 窗口截图文件不存在'],
        [codexWindowScreenshotQuality.validPng, 'Codex 窗口截图不是有效 PNG'],
        [codexWindowScreenshotQuality.width >= 600 && codexWindowScreenshotQuality.height >= 400, 'Codex 窗口截图尺寸过小'],
        [!codexWindowScreenshotQuality.likelyBlank, 'Codex 窗口截图疑似空白或纯色'],
        [/当前 Codex 会话窗口/.test(codexWindowActual), '没有记录人工看图确认的具体内容'],
      ],
    ),
    pass(
      'A10',
      officeScreenshotInput,
      'Word/PPT/Excel 截图需要真实预览能力；没有预览能力时只能发原文件并说明，不能声称截图完成。',
      officeScreenshotActual,
      [
        [/\.docx\/\.pptx\/\.xlsx 原文件/.test(officeScreenshotActual), '没有确认可发送 Office 原文件'],
        [/Office\/LibreOffice\/浏览器预览能力/.test(officeScreenshotActual), '没有定义可截图的前置条件'],
        [/不得假装截图完成/.test(officeScreenshotActual), '没有禁止无预览时假装截图完成'],
      ],
    ),
    pass(
      'A11',
      '/结束',
      '应识别为硬停止命令，停止当前任务、清空队列并让旧结果失效。',
      '已结束。',
      [
        [isHardEndCommand('/结束'), '没有识别 /结束'],
        [isHardEndCommand('/stop'), '没有保留 /stop'],
      ],
    ),
    pass(
      'A12',
      '/查询当前',
      '应强制查询当前最新 Codex 会话内容与进度情况，不回答微信发送状态。',
      queryCurrentPrompt,
      [
        [isQueryCurrentCommand('/查询当前'), '没有识别 /查询当前'],
        [/检索当前最新 Codex 会话内容与进度情况/.test(queryCurrentPrompt), '查询 prompt 没有明确检索当前会话进度'],
        [/不要回答微信发送状态/.test(queryCurrentPrompt), '查询 prompt 没有禁止回答微信发送状态'],
        [!/用户补充条件/.test(queryCurrentPrompt), '纯 /查询当前 不应要求用户提供具体会话名'],
      ],
    ),
    pass(
      'A13',
      '引用文件“需求说明.docx”后问：按这个调整一下',
      '应把被引用对象和当前问题一起交给 Codex，不能当孤立消息理解。',
      quoteFollowupActual,
      [
        [/默认是在追问\/要求处理这个被引用对象/.test(quoteFollowupActual), '没有明确引用追问语义'],
        [/需求说明\.docx/.test(quoteFollowupActual), '没有保留引用文件名'],
        [/按这个调整一下/.test(quoteFollowupActual), '没有保留当前问题'],
      ],
    ),
    pass(
      'A14',
      '/截图当前',
      '应识别为硬命令，截取当前 Codex 会话窗口并推送图片。',
      '待推送文件：Codex 当前窗口截图 PNG',
      [
        [isCaptureCurrentCommand('/截图当前'), '没有识别 /截图当前'],
        [!isCaptureCurrentCommand('截图当前'), '无斜杠自然语言不应被硬命令误伤'],
      ],
    ),
    pass(
      'A15',
      '/截图实际',
      '应让 Codex 查找最近生成或提到的实际可预览对象并截图；没有对象时明确说没有，不能截当前窗口凑数。',
      captureActualPrompt,
      [
        [isCaptureActualCommand('/截图实际'), '没有识别 /截图实际'],
        [!isCaptureActualCommand('截图实际'), '无斜杠自然语言不应被硬命令误伤'],
        [/最近生成或提到的实际可预览对象/.test(captureActualPrompt), '没有要求查找实际对象'],
        [/没有可截图的实际对象/.test(captureActualPrompt), '没有定义找不到对象时的回复'],
        [/不要截当前窗口/.test(captureActualPrompt), '没有禁止截当前窗口凑数'],
      ],
    ),
  ];
}
