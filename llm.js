// llm.js - GLM (Zhipu AI) integration using OpenAI-compatible SDK
// GLM 的 OpenAI 兼容接口，通过设置 baseURL 指向智谱的 endpoint

const OpenAI = require('openai');

// ---- Configuration (via env vars) --------------------------------------
// LLM_API_KEY   : 你的 GLM API key（来自 https://open.bigmodel.cn/）
// LLM_BASE_URL  : 默认 https://open.bigmodel.cn/api/paas/v4（国内）
//                 国际用户可用 https://api.z.ai/api/paas/v4
// LLM_MODEL     : 默认 glm-4-flash（便宜、快）；可改为 glm-4-plus 等
//
// 为了兼容老的 .env，OPENAI_API_KEY / OPENAI_MODEL 仍然作为 fallback。
// ------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-4-flash';

function getApiKey() {
  return (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();
}

function getBaseUrl() {
  return (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).trim();
}

function getModel() {
  return (process.env.LLM_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL).trim();
}

let client = null;
let llmHealth = {
  configured: false,
  healthy: false,
  checkedAt: null,
  model: getModel(),
  provider: 'GLM',
  baseUrl: getBaseUrl(),
  error: null,
  keyPreview: null
};

function hasApiKey() {
  return Boolean(getApiKey());
}

function getKeyPreview() {
  const key = getApiKey();
  if (!key) return null;
  if (key.length <= 16) return `${key.slice(0, 4)}...${key.slice(-2)}`;
  return `${key.slice(0, 10)}...${key.slice(-6)}`;
}

function getClient() {
  if (!hasApiKey()) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: getApiKey(),
      baseURL: getBaseUrl()
    });
  }
  return client;
}

async function checkLlmHealth(force = false) {
  llmHealth.configured = hasApiKey();
  llmHealth.keyPreview = getKeyPreview();
  llmHealth.model = getModel();
  llmHealth.baseUrl = getBaseUrl();
  llmHealth.provider = 'GLM';

  if (!llmHealth.configured) {
    llmHealth.healthy = false;
    llmHealth.error = 'No LLM_API_KEY found';
    llmHealth.checkedAt = Date.now();
    return llmHealth;
  }

  if (!force && llmHealth.checkedAt && llmHealth.healthy) {
    return llmHealth;
  }

  try {
    const openai = getClient();
    // GLM's OpenAI-compatible endpoint uses chat.completions
    const resp = await openai.chat.completions.create({
      model: llmHealth.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5
    });
    const ok = Boolean(resp?.choices?.[0]?.message);
    llmHealth.healthy = ok;
    llmHealth.error = ok ? null : 'Empty response from LLM';
    llmHealth.checkedAt = Date.now();
    return llmHealth;
  } catch (err) {
    llmHealth.healthy = false;
    llmHealth.error = err?.message || 'Unknown LLM health error';
    llmHealth.checkedAt = Date.now();
    return llmHealth;
  }
}

function getLlmHealth() {
  return { ...llmHealth };
}

async function generateCoachReply({ systemPrompt, userMessage, context }) {
  const openai = getClient();
  if (!openai) return null;

  try {
    const response = await openai.chat.completions.create({
      model: getModel(),
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Context:\n${JSON.stringify(context, null, 2)}\n\nStudent message:\n${userMessage}`
        }
      ],
      temperature: 0.6,
      max_tokens: 800
    });

    const text = response?.choices?.[0]?.message?.content || '';
    return text.trim() || null;
  } catch (err) {
    console.error('[LLM] generateCoachReply error:', err?.message || err);
    return null;
  }
}

// ============================================================
// 复盘：基于金洪源元认知心理干预技术生成结构化复盘
// 返回：知识点定位 + S-E-R 链条 + CER 程序识别 + 元认知训练任务
// ============================================================
async function generateMetacognitiveSummary({ questionText, messages, events, state, isExam = false }) {
  const openai = getClient();
  if (!openai) return null;

  const systemPrompt = `你是一位熟悉金洪源教授《元认知心理干预技术》的学习诊断专家。你的任务是复盘一次中学生数学做题过程，输出严格的 JSON 结构。

核心理论依据：
1. 学生在做题中遇到困难时，会自动启动"条件性情绪反应(CER)程序"——即 S(刺激情境) → E(自动情绪) → R(思维/行为反应) 的自动链条。
2. 学生遇到困难时的卡点，可能是"知识性问题"（不会、夹生），也可能是"元认知性问题"（CER 程序在作怪）。这两类必须分开诊断，因为解法完全不同。
3. 元认知干预不是讲道理、不是鼓励，而是帮学生"看见自己的程序"并给出可执行的觉察训练任务。

你必须严格输出以下 JSON（不要任何 markdown 代码块包裹，直接输出 JSON 对象）：
{
  "knowledgeDiagnosis": {
    "gaps": ["学生明显不会的知识点（空白），每条一句话"],
    "fuzzy": ["学生似乎记得但用不熟的知识点（夹生/欠缺）"],
    "mastered": ["本题中明确表现出已掌握的知识点"]
  },
  "serChain": {
    "triggered": true 或 false,
    "S": "具体触发情境，要引用学生在哪一轮、遇到什么步骤。如果未触发则为空字符串",
    "E": "学生出现的自动情绪反应（用学生原话 + 情绪类型标注，如'自我否定型''焦虑型''回避型'）",
    "R": "学生接下来的思维/行为反应（如：放弃尝试、转向要答案、重复错误、沉默等）",
    "cerType": "识别出的 CER 程序类型：'自我否定型' | '回避型' | '急躁型' | '启动困难型' | '完美主义型' | '无明显CER'",
    "description": "一段话解释这个程序是怎么在本次会话中跑起来的，面向学生本人"
  },
  "rootCause": "一句话说清本次的真正卡点：是'知识空白'、'知识夹生'，还是'CER 程序接管了决策'，还是两者叠加",
  "metacognitiveTraining": {
    "task": "一个具体、可操作的元认知觉察训练任务，针对本次识别出的 CER 类型定制。不要讲道理，不要鼓励。要像行为指令一样可执行。",
    "whenToUse": "下次什么情境下启动这个训练",
    "rationale": "为什么这个训练对本次的 CER 程序有效（1-2 句话）"
  },
  "studentFacing": {
    "whatHappened": "面向学生的 2-3 句话，说清这次发生了什么。不用术语，不说'CER''元认知'。",
    "oneThingToSee": "下次训练时只需要看见的一件事"
  }
}

要求：
- 所有文字用中文，面向学生的部分语气要温和、具体、不教条。
- 不要在任何字段（包括 serChain.description, metacognitiveTraining, rootCause, studentFacing 等）中使用以下术语："元认知""CER""条件性情绪反应""metacognitive""潜意识程序""心理干预"。cerType 字段只能在 "自我否定型/回避型/急躁型/启动困难型/完美主义型/无明显CER" 这几个标签里选，不得展开解释这些术语。
- 描述程序时用日常语言，例如"一遇到变形步骤就想放弃""心里一急就说自己笨"等，不要使用心理学术语。
- 如果对话内容不足以诊断（如消息太少），也要尽量基于已有信息给出判断，不要输出"信息不足"。
- 知识点要具体到题目中的概念（如"二次函数配方法""根的判别式"），不要笼统说"代数"。`;

  const convoText = messages.map((m, i) => {
    const role = m.role === 'user' ? '学生' : '教练';
    return `[第${i + 1}轮·${role}·${m.type || ''}] ${m.content}`;
  }).join('\n');

  const eventText = (events || []).map((e, i) => `${i + 1}. ${e.type}: ${e.note || ''}`).join('\n') || '（无关键事件记录）';

  const userMessage = `题目：
${questionText || '（未提供题目文本）'}

完整对话记录：
${convoText || '（无对话）'}

系统识别的关键事件序列：
${eventText}

学生状态快照：
- 用时：${state.timeSpentSec} 秒
- 提示层级：${state.hintLevel}
- 连续无推进轮数：${state.noProgressTurns}
- 情绪波动次数：${state.emotionCycles}
- 要答案次数：${state.answerRequestCount}
- 回避次数：${state.withdrawalCount}
${isExam ? `
⚠️ 重要背景：本次是考试模式。教练全程没有介入，没有给任何提示，学生是在独立、类似真实考场的压力下作答。
- 这意味着学生展现出的反应（卡点、情绪、回避、放弃、要答案的倾向等）就是他在真实考场里的自动反应。
- 复盘时请在 studentFacing.whatHappened 中点明这一点：这次看到的是"没人帮你时你会怎么做"，这正是最真实的自己。
- metacognitiveTraining 要针对"下次真实考场遇到同样触发时"如何做出不同反应。
- 如果学生提交了最终答案（会出现在对话最后一条【提交答案】里），评估时可以结合答案正确性和过程推理的一致性。` : ''}

请严格按 JSON schema 输出复盘结果。`;

  try {
    const response = await openai.chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 1800,
      response_format: { type: 'json_object' }
    });

    const text = response?.choices?.[0]?.message?.content || '';
    if (!text) return null;

    // Clean up any markdown fences just in case
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[LLM] generateMetacognitiveSummary JSON parse error:', parseErr.message, 'raw:', cleaned.slice(0, 300));
      return null;
    }
  } catch (err) {
    console.error('[LLM] generateMetacognitiveSummary error:', err?.message || err);
    return null;
  }
}

module.exports = {
  hasApiKey,
  checkLlmHealth,
  getLlmHealth,
  generateCoachReply,
  generateMetacognitiveSummary
};
