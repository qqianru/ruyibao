require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { hasApiKey, checkLlmHealth, getLlmHealth, generateCoachReply, generateMetacognitiveSummary, generateSurgeryStepFeedback, generateSurgeryCard } = require('./llm');
const db = require('./db');

// Daily per-user message cap
const DAILY_LIMIT = 150;

// Hash a (question + userInput) pair for response caching
function hashQuestion(questionText, userInput) {
  const normalized = ((questionText || '') + '|' + (userInput || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

const app = express();
const PORT = process.env.PORT || 3000;
const SESSIONS = new Map();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function createInitialState(mode = 'practice') {
  return {
    mode,
    createdAt: Date.now(),
    currentQuestion: '',
    timeSpentSec: 0,
    lastProgressSec: 0,
    errorCount: 0,
    hintLevel: 0,
    emotionRisk: 'low',
    questionDifficulty: 'medium',
    shouldOfferSkip: false,
    lastStateType: 'NORMAL',
    lastStrategy: null,
    askedPrompts: [],
    events: [],
    conversationMode: 'SOLVING',
    solvedClaimed: false,
    reviewRequested: false,
    offTopicCount: 0,
    emotionCycles: 0,
    answerRequestCount: 0,
    lastUserIntent: 'UNKNOWN',
    noProgressTurns: 0,
    withdrawalCount: 0,
    metaInterventionCount: 0,
    examSubmitted: false,
    examFinalAnswer: '',
    examSubmittedAt: null,
    // ---- Micro-surgery mode fields ----
    surgeryStep1: '',
    surgeryStep2: '',
    surgeryStep3: '',
    surgeryStepFeedback: { 1: null, 2: null, 3: null },
    surgeryCard: null,
    surgeryFinalizedAt: null
  };
}

function analyzeDifficulty(questionText) {
  const text = (questionText || '').toLowerCase();
  if (
    text.includes('压轴') || text.includes('证明') || text.includes('函数综合') ||
    text.includes('geometry') || text.includes('maximum') || text.includes('最值')
  ) {
    return 'high';
  }
  if (text.length > 80) return 'medium';
  return 'low';
}

function includesAny(text, patterns) {
  const lower = (text || '').toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

function detectEmotion(text) {
  return includesAny(text, [
    '我不行', '我完了', '太难了', '烦死了', '我怎么这么笨', '崩溃', '好害怕', '紧张',
    'i am done', 'i give up', 'too hard', 'stupid', 'hopeless', 'panic', 'scared'
  ]);
}

function detectLowEngagement(text) {
  return includesAny(text, [
    '直接给答案', '直接告诉我', '直接讲', '你教我', 'answer only', 'just give me the answer', '直接给我', '告诉我答案'
  ]);
}

function detectWithdrawal(text) {
  return includesAny(text, [
    '我不想学了', '不想学了', '不想说', '太费劲', '烦死了', '不想做了', '算了', '不学了',
    'i do not want to do this', 'i do not want to talk', 'too much', 'forget it', 'leave me alone'
  ]);
}

function detectStuck(text) {
  return includesAny(text, [
    '不会', '没思路', '不知道怎么开始', '卡住', '不会做', '不知道', '怎么求', '怎么做'
  ]);
}

function detectPossibleError(text) {
  return includesAny(text, ['应该是', '我算出来', '答案是', '=']);
}

function detectFinished(text) {
  return includesAny(text, [
    '我做完了', '我算完了', '做完了', '算完了', '完成了', '我做出来了', '我已经做完',
    'i finished', 'i am done', 'finished it'
  ]);
}

function detectReviewRequest(text) {
  return includesAny(text, [
    '帮我检查', '检查一下', '对不对', '验证一下', '看看对不对', '复盘', 'check my answer', 'verify'
  ]);
}

function detectOffTopic(text) {
  return includesAny(text, [
    '你太笨了', '你什么都不懂', '你不懂', '垃圾', '闭嘴', '烦死了', '滚',
    'you are dumb', 'useless', 'shut up'
  ]);
}

function isTimeMisuse(state) {
  const threshold = state.questionDifficulty === 'high' ? 240 : 180;
  return state.timeSpentSec >= threshold;
}

function isPassiveStuck(state) {
  return state.timeSpentSec - state.lastProgressSec >= 75;
}

function pushEvent(state, type, detail) {
  state.events.push({ type, detail, timestamp: Date.now() });
}

function markProgress(state, userInput) {
  const progressPatterns = ['已知', '设', '先', '所以', '因此', '我打算', '用', '交点', '令', '顶点', 'x轴', '代入', '检验'];
  const progressed = progressPatterns.some((p) => (userInput || '').includes(p)) || (userInput || '').length > 18;
  if (progressed) {
    state.lastProgressSec = state.timeSpentSec;
  }
  return progressed;
}

function detectConversationMode(userInput, state) {
  if (detectOffTopic(userInput)) return 'OFF_TOPIC';
  if (detectReviewRequest(userInput)) return 'REVIEW';
  if (detectFinished(userInput)) return 'FINISHED';
  if (state.conversationMode === 'FINISHED' && detectPossibleError(userInput)) return 'REVIEW';
  if (state.conversationMode === 'OFF_TOPIC' && detectStuck(userInput)) return 'SOLVING';
  return 'SOLVING';
}

function classifyState(state, userInput) {
  if (state.conversationMode === 'OFF_TOPIC') return 'OFF_TOPIC';
  if (state.conversationMode === 'FINISHED') return 'FINISHED';
  if (state.conversationMode === 'REVIEW') return 'REVIEW';
  if (detectWithdrawal(userInput)) return 'WITHDRAWAL';
  if (state.noProgressTurns >= 2) return 'META_INTERVENTION';
  if (detectEmotion(userInput)) return 'EMOTION';
  if (detectLowEngagement(userInput)) return 'LOW_ENGAGEMENT';
  if (isTimeMisuse(state)) return 'TIME';
  if (detectPossibleError(userInput) && state.errorCount > 0) return 'ERROR';
  if (detectStuck(userInput) || isPassiveStuck(state)) return 'STUCK';
  return 'NORMAL';
}

function selectStrategy(stateType, state) {
  if (stateType === 'EMOTION') return 'REDUCE';
  if (stateType === 'WITHDRAWAL') return 'CHOICE_CONTROL';
  if (stateType === 'META_INTERVENTION') return 'META_REFLECT';
  if (stateType === 'LOW_ENGAGEMENT') return 'REFLECT';
  if (stateType === 'TIME') return 'STRATEGY';
  if (stateType === 'ERROR') return 'CHECK';
  if (stateType === 'FINISHED') return 'VERIFY_RESULT';
  if (stateType === 'REVIEW') return 'TRACE_METHOD';
  if (stateType === 'OFF_TOPIC') return 'REPAIR_RELATION';
  if (stateType === 'STUCK') {
    if (state.hintLevel <= 1) return 'CLASSIFY';
    if (state.hintLevel === 2) return 'LOCATE';
    if (state.hintLevel === 3) return 'BRIDGE';
    return 'DIRECT_HINT';
  }
  return 'ADVANCE';
}

function getQuestionSnippet(question) {
  const text = (question || '').replace(/\s+/g, ' ').trim();
  if (!text) return '当前题目';
  return text.slice(0, 40) + (text.length > 40 ? '…' : '');
}

function chooseNonRepeating(state, candidates, fallback) {
  const unused = candidates.filter((c) => !state.askedPrompts.includes(c));
  const selected = unused[0] || fallback || candidates[0];
  state.askedPrompts.push(selected);
  if (state.askedPrompts.length > 24) state.askedPrompts.shift();
  return selected;
}

function buildRuleReply(stateType, state, payload) {
  const q = getQuestionSnippet(payload.questionText);
  const stuckReplies = {
    CLASSIFY: [
      `先别急。看一下“${q}”，这题现在是在求什么？`,
      `我们先不算。你能先说说这题要找的是哪个量吗？`
    ],
    LOCATE: [
      'A、B 这两个点在图像里通常代表什么？',
      '如果题目要找 A、B 的坐标，它们和坐标轴有什么关系？'
    ],
    BRIDGE: [
      '如果一个点在 x 轴上，它的 y 值会是多少？',
      '要找到图像和 x 轴的交点，通常会先令哪个量等于 0？'
    ],
    DIRECT_HINT: [
      '可以先试试令 y = 0，这样就能开始求和 x 轴交点的横坐标。',
      '这一步可以先从“令 y = 0”开始。算出 x 之后，再写点坐标。'
    ]
  };

  switch (stateType) {
    case 'OFF_TOPIC':
      return {
        role: 'assistant',
        type: 'OFF_TOPIC',
        content: chooseNonRepeating(state, [
          '我在这里是帮你把题目理顺的。我们先不争这个，想不想一起快速确认一下你的结果？',
          '没关系，我们先回到题目本身。你要不要用一句话说说你刚才的答案是怎么来的？'
        ])
      };
    case 'FINISHED':
      return {
        role: 'assistant',
        type: 'FINISHED',
        content: chooseNonRepeating(state, [
          '好，我们先不继续讲新步骤。你愿意快速验证一下结果是怎么得到的吗？',
          '好的。现在更适合做个小检查：你这个答案是根据哪一步推出的？'
        ])
      };
    case 'REVIEW':
      return {
        role: 'assistant',
        type: 'REVIEW',
        content: chooseNonRepeating(state, [
          '我们进入检查模式。你先用一句话说说你的思路，再看有没有哪一步最容易出错。',
          '先不重做整题。你把关键两步说出来，我们一起验证结果是否合理。'
        ])
      };
    case 'EMOTION': {
      const cycle = state.emotionCycles || 1;
      const prompts = cycle <= 1
        ? ['先别急。你现在的问题不是“笨”，而是状态乱了。我们先只决定一件事：你更卡在读题、列式，还是计算？']
        : cycle === 2
          ? ['我们先不评价自己，只看卡点。你现在更像是“不会列式”，还是“太急了所以不想做”？']
          : ['先停掉自我评价。现在不继续讲题，只做一个选择：继续拆一步，还是先暂停这题 30 秒？'];
      return { role: 'assistant', type: 'EMOTION', content: chooseNonRepeating(state, prompts, prompts[0]) };
    }
    case 'WITHDRAWAL': {
      const count = state.withdrawalCount || 1;
      const prompts = count <= 1
        ? ['先停一下。你现在不是单纯不会，而是已经被这题拖住了。现在有两个选择：继续拆一步，或者先暂停这题。你选哪个？']
        : count === 2
          ? ['好，我们先不追完整答案。你告诉我：你现在更像是看不懂题、不会列式，还是一着急就不想做？']
          : ['这题已经开始拖累你的状态了。现在先止损，不继续讲内容。你只要告诉我：要暂停，还是只做最小一步？'];
      return { role: 'assistant', type: 'WITHDRAWAL', content: chooseNonRepeating(state, prompts, prompts[0]) };
    }
    case 'META_INTERVENTION': {
      const count = state.metaInterventionCount || 1;
      const prompts = count <= 1
        ? ['先停一下，我们不继续拆题了。你现在更卡在“看不懂题”，还是“知道意思但不会列式”？']
        : count === 2
          ? ['先不求答案。你现在的问题更像“知识不会”，还是“压力上来后没法推进”？']
          : ['这题先不继续深挖。现在做一个策略决定：继续一步、先检查已知条件，还是暂时放下这题？'];
      return { role: 'assistant', type: 'META_INTERVENTION', content: chooseNonRepeating(state, prompts, prompts[0]) };
    }
    case 'LOW_ENGAGEMENT': {
      const count = state.answerRequestCount || 1;
      const prompts = count <= 1
        ? ['我可以后面给你完整讲解，但先试一步：这题第一步更像是列式、作图，还是求交点？']
        : count === 2
          ? ['先不要直接看答案。你只要回答一个很小的问题：这里两个量是增加还是减少关系？']
          : ['好，我给你一个半步提示：先用字母表示两个量，再把“增加/减少”的关系写成式子。你先补最后一小步。'];
      return { role: 'assistant', type: 'LOW_ENGAGEMENT', content: chooseNonRepeating(state, prompts, prompts[0]) };
    }
    case 'TIME':
      return {
        role: 'assistant',
        type: 'TIME',
        content: chooseNonRepeating(state, [
          '你已经在这题上花了不少时间。如果再 1 分钟还没有新进展，建议先标记，回头再做。',
          '这题可以再试一分钟；如果还是没有推进，我们就先保住后面的分。'
        ])
      };
    case 'ERROR':
      return {
        role: 'assistant',
        type: 'ERROR',
        content: chooseNonRepeating(state, [
          '这一步方向可能是对的，但最后一小步建议再检查一下，特别是符号、常数项，或者移项。',
          '先别重做整题。你只检查最后一步，看看是不是符号或常数项出了问题。'
        ])
      };
    case 'STUCK': {
      const strategy = selectStrategy(stateType, state);
      return {
        role: 'assistant',
        type: 'STUCK',
        content: chooseNonRepeating(state, stuckReplies[strategy], '我们先只找第一步，不急着求完整答案。')
      };
    }
    default:
      return {
        role: 'assistant',
        type: 'NORMAL',
        content: chooseNonRepeating(state, [
          '很好，继续往前推。你下一步准备怎么做？',
          '这一步有推进了。你想先算，还是先检查思路？'
        ])
      };
  }
}

function buildSystemPrompt(interventionType, state, history, questionText) {
  return [
    'You are an AI metacognitive learning coach guided by Professor Wang Ying (王鹰教授) pedagogical approach.',
    'Your goal is NOT to immediately solve the problem.',
    'You help the student regulate thinking, stay calm, and make better decisions while solving problems.',
    `Current intervention type: ${interventionType}`,
    `Current conversation mode: ${state.conversationMode}`,
    `Current hint level: ${state.hintLevel}`,
    `Question snippet: ${getQuestionSnippet(questionText)}`,
    '',
    'Rules:',
    '- Keep the reply short, calm, and supportive.',
    '- Do not repeat the same question that has already been asked.',
    '- If the mode is FINISHED, do not continue teaching new steps; shift to checking or verifying.',
    '- If the mode is REVIEW, ask the student to explain the method or verify the result.',
    '- If the mode is OFF_TOPIC, avoid arguing; gently redirect back to the task.',
    '- If the student is stuck, ask one focused guiding question or give one small directional hint.',
    '- If the student is emotional, do NOT stay in comfort mode. After one reassurance, switch to identifying the current blockage or making a strategy choice.',
    '- If the student shows withdrawal (e.g., 不想学了 / 不想说 / 太费劲), stop teaching content and offer a control-restoring choice.',
    '- If there are two turns with no real progress, stop content tutoring and move into meta-intervention mode.',
    '- In meta-intervention mode, ask about the blockage, attribution, or next strategy; do not continue explaining math content.',
    '- If the student asks for the answer, do NOT give the full answer immediately. First redirect, then give one tiny hint, and only give a fuller hint after repeated requests.',
    '- If the student is wasting time, suggest a strategy decision.',
    '- If the student likely made a small mistake, prompt them to re-check one specific step.',
    '- Your goal is restoring task engagement, not offering endless comfort.',
    '- Do not dump the full solution unless the student explicitly asks and hint level is already high.',
    '- Sound like a calm coach, not an examiner.',
    '- IMPORTANT: Never reveal internal terminology to the student. Do NOT say "元认知", "metacognitive", "meta-intervention", "MetaCoach", "intervention mode", or any similar jargon in your reply. Speak in plain, natural language as a patient teacher would.',
    '',
    `Recent prompts already used: ${JSON.stringify(state.askedPrompts.slice(-6))}`,
    `Recent history: ${JSON.stringify(history.slice(-6))}`
  ].join('\n');
}

async function buildReply(stateType, state, session, userInput) {
  // ---- Micro-surgery mode: coach doesn't do free chat, nudge student to the 3-step form ----
  if (state.mode === 'micro_surgery') {
    const nudges = [
      '错题手术模式下，我们按三步走。请在左边填好"定位病灶 / 寻找线索 / 写下炒菜程序"，每一步完成后可以点"让教练打磨"。',
      '这里不走自由对话。你先把那道错题写在左边题目框里，再按顺序填三步，我会逐步帮你打磨。',
      '错题手术是个结构化流程，不是聊天。请在左侧按 1-2-3 三步填入你的思考，再点击对应按钮让我看。'
    ];
    const content = nudges[Math.floor(Math.random() * nudges.length)];
    return {
      role: 'assistant',
      type: 'SURGERY_NUDGE',
      content
    };
  }

  // ---- Exam mode: coach stays silent, no coaching ----
  // Events still fire (tracked for post-exam 复盘), but no hints / no interventions.
  if (state.mode === 'exam' && !state.examSubmitted) {
    const acks = [
      '好的，继续。',
      '收到。',
      '记下了，继续写。',
      '嗯，继续你的思路。',
      '好，继续。'
    ];
    const content = acks[Math.floor(Math.random() * acks.length)];
    return {
      role: 'assistant',
      type: 'EXAM_SILENT',
      content
    };
  }

 const fallback = buildRuleReply(stateType, state, { questionText: state.currentQuestion });
  const llmHealth = getLlmHealth();
  if (!llmHealth.healthy) {
    return fallback;
  }

  // ---- Response cache lookup ----
  const cacheableStates = ['NORMAL', 'STUCK'];
  const isCacheable = cacheableStates.includes(stateType) && state.hintLevel === 0;
  let questionHash = null;

  if (isCacheable) {
    questionHash = hashQuestion(state.currentQuestion, userInput);
    try {
      const cached = await db.getCachedResponse(questionHash);
      if (cached) {
        state.askedPrompts.push(cached);
        if (state.askedPrompts.length > 24) state.askedPrompts.shift();
        return { role: 'assistant', type: stateType, content: cached };
      }
    } catch (e) {
      console.error('Cache lookup failed:', e.message);
    }
  }

  try {
    const systemPrompt = buildSystemPrompt(stateType, state, session.messages, state.currentQuestion);
    const llmText = await generateCoachReply({
      systemPrompt,
      userMessage: userInput,
      context: {
        state,
        questionText: state.currentQuestion,
        lastStateType: state.lastStateType,
        lastStrategy: state.lastStrategy,
        recentMessages: session.messages.slice(-6)
      }
    });
    if (!llmText) return fallback;
    state.askedPrompts.push(llmText);
    if (state.askedPrompts.length > 24) state.askedPrompts.shift();

    // Save to cache (fire and forget)
    if (isCacheable && questionHash) {
      db.saveCachedResponse(questionHash, llmText).catch(e => {
        console.error('Cache save failed:', e.message);
      });
    }

    return {
      role: 'assistant',
      type: stateType,
      content: llmText
    };
  } catch (err) {
    console.error('LLM call failed, using fallback:', err.message);
    return fallback;
  }
}
function analyzeTrace(state, messages) {
  const events = state.events || [];
  const counts = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});

  const firstIndex = (type) => events.findIndex((e) => e.type === type);
  const turnFromIndex = (idx) => (idx >= 0 ? idx + 1 : null);

  const firstStuck = firstIndex('STUCK');
  const firstEmotion = firstIndex('EMOTION');
  const firstWithdrawal = firstIndex('WITHDRAWAL');
  const firstMeta = firstIndex('META_INTERVENTION');
  const firstError = firstIndex('ERROR');
  const firstTime = firstIndex('TIME');

  const hasChain = (a, b) => a >= 0 && b >= 0 && b > a;
  const stuckToEmotion = hasChain(firstStuck, firstEmotion);
  const stuckToWithdrawal = hasChain(firstStuck, firstWithdrawal);
  const emotionToWithdrawal = hasChain(firstEmotion, firstWithdrawal);
  const reachedMeta = firstMeta >= 0;

  const issueMap = {
    EMOTION: '情绪波动影响了推进',
    STUCK: '启动后连续卡在关键一步',
    ERROR: '已经接近正确，但在细节上掉线',
    TIME: '在单题上投入过久，没有及时止损',
    LOW_ENGAGEMENT: '过早想直接拿答案，削弱了思考推进',
    WITHDRAWAL: '出现了回避/退出倾向，需要先恢复控制感',
    META_INTERVENTION: '连续无推进，需要先停下来定位卡点',
    FINISHED: '完成后更需要验证而不是继续展开',
    REVIEW: '已经进入检查模式，适合看关键步骤是否合理',
    OFF_TOPIC: '对话一度偏离题目，需要重新聚焦'
  };

  const topIssue = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'NORMAL';
  const topIssueText = issueMap[topIssue] || '整体状态较稳定';

  let whatHappened = '这次整体推进比较平稳，没有出现明显的卡死或退出。';
  let bottleneck = '主要还是内容理解和细节检查。';
  let cause = '当前对话里没有形成明显的失控链条。';
  let nextAction = '下次保持“先说目标，再动手”的节奏即可。';

  if (stuckToWithdrawal || emotionToWithdrawal) {
    whatHappened = `这次你不是单纯不会，而是在卡住之后逐渐进入了回避/退出状态${turnFromIndex(firstWithdrawal) ? `（大约从第 ${turnFromIndex(firstWithdrawal)} 次关键事件开始）` : ''}。`;
    bottleneck = '真正的卡点不是整题不会，而是卡在某个关键转换步骤后，没有及时降难度或止损。';
    cause = '连续没有推进后，情绪和回避接管了决策，所以后面不是不会，而是已经不想继续。';
    nextAction = '下次一旦连续两轮没推进，就不要继续硬拆内容，先只做一个选择：继续最小一步，还是先暂停这题。';
  } else if (stuckToEmotion) {
    whatHappened = `这次你先卡在关键一步，随后情绪开始上来${turnFromIndex(firstEmotion) ? `（大约从第 ${turnFromIndex(firstEmotion)} 次关键事件开始）` : ''}。`;
    bottleneck = '卡点本身不一定很大，但你在连续无推进后没有切换策略。';
    cause = '这更像“卡住 → 着急 → 更难推进”的链条，而不是知识完全不会。';
    nextAction = '下次如果同一步连续两次答不上来，先判断自己是看不懂、不会列式，还是太急了，再决定怎么走下一步。';
  } else if (firstError >= 0) {
    whatHappened = '这次你已经比较接近正确思路，问题主要出在最后的小错误或表达不精确。';
    bottleneck = '关键瓶颈在最后一步的检查，而不是前面完全不会。';
    cause = '这类失分通常来自符号、常数项、起点对齐或表达式结构没有再核对一次。';
    nextAction = '下次遇到“已经很接近”的情况，优先检查起点是否对齐、符号是否一致，不要整题重做。';
  } else if (firstTime >= 0) {
    whatHappened = '这次你在单题上投入时间偏久，后面收益开始下降。';
    bottleneck = '问题不只是会不会，而是没有及时做“继续还是止损”的决策。';
    cause = '当一题耗时过长时，继续投入未必带来更多推进。';
    nextAction = '下次遇到高耗时但无新进展，给自己设一个止损点：再试 1 分钟，没有推进就先标记。';
  } else if (reachedMeta) {
    whatHappened = '这次你连续几轮没有明显推进，需要先停下来判断卡点。';
    bottleneck = '卡点主要是没有及时说清自己到底卡在“读题、列式，还是计算”。';
    cause = '当卡点不明确时，继续讲内容帮助有限，先定位问题类型更重要。';
    nextAction = '下次一旦连续两轮没有推进，先用一句话说清自己卡的是哪一类，再继续。';
  }

  const timeline = [];
  if (firstStuck >= 0) timeline.push(`先出现卡住（第 ${turnFromIndex(firstStuck)} 次关键事件）`);
  if (firstEmotion >= 0) timeline.push(`随后情绪波动上来（第 ${turnFromIndex(firstEmotion)} 次关键事件）`);
  if (firstWithdrawal >= 0) timeline.push(`之后出现回避/退出倾向（第 ${turnFromIndex(firstWithdrawal)} 次关键事件）`);
  if (firstMeta >= 0) timeline.push(`需要先停下来定位卡点（第 ${turnFromIndex(firstMeta)} 次关键事件）`);
  if (firstError >= 0) timeline.push(`过程中还出现了关键小错误（第 ${turnFromIndex(firstError)} 次关键事件）`);
  if (firstTime >= 0) timeline.push(`并伴随单题耗时过久（第 ${turnFromIndex(firstTime)} 次关键事件）`);

  return {
    counts,
    topIssue,
    topIssueText,
    traceFlags: {
      stuckToEmotion,
      stuckToWithdrawal,
      emotionToWithdrawal,
      reachedMeta
    },
    whatHappened,
    bottleneck,
    cause,
    nextAction,
    timeline
  };
}

async function buildSummary(session) {
  const { state, messages } = session;
  const trace = analyzeTrace(state, messages);

  // Rule-based base summary (fallback / always-available)
  const base = {
    totalMessages: messages.length,
    timeSpentSec: state.timeSpentSec,
    hintLevel: state.hintLevel,
    llmEnabled: getLlmHealth().healthy,
    issueCounts: trace.counts,
    topIssue: trace.topIssue,
    topIssueText: trace.topIssueText,
    conversationMode: state.conversationMode,
    whatHappened: trace.whatHappened,
    bottleneck: trace.bottleneck,
    cause: trace.cause,
    nextAction: trace.nextAction,
    timeline: trace.timeline,
    suggestions: [trace.nextAction]
  };

  // If no messages yet, skip LLM call
  if (!messages || messages.length < 2 || !getLlmHealth().healthy) {
    return base;
  }

  try {
    const metacog = await generateMetacognitiveSummary({
      questionText: state.currentQuestion,
      messages,
      events: state.events || [],
      state,
      isExam: state.mode === 'exam'
    });

    if (metacog && typeof metacog === 'object') {
      // Merge: keep base stats for backward compat, add new structured fields
      return {
        ...base,
        // New metacognitive fields
        knowledgeDiagnosis: metacog.knowledgeDiagnosis || null,
        serChain: metacog.serChain || null,
        rootCause: metacog.rootCause || base.cause,
        metacognitiveTraining: metacog.metacognitiveTraining || null,
        studentFacing: metacog.studentFacing || null,
        // Override the user-visible text with LLM-generated if available
        whatHappened: metacog.studentFacing?.whatHappened || base.whatHappened,
        llmSummary: true
      };
    }
  } catch (e) {
    console.error('[Summary] LLM metacognitive summary failed, using fallback:', e.message);
  }

  return { ...base, llmSummary: false };
}

app.post('/api/session', async (req, res) => {
  const { mode = 'practice', userId = 'guest' } = req.body || {};
  const id = Math.random().toString(36).slice(2, 10);
  const state = createInitialState(mode);
  let convId = null;
  // Save conversation record to db
  if (userId && userId !== 'guest') {
    try {
      const result = await db.saveConversation({ id: null, userId, sessionId: id, questionText: '', messages: [], state });
      convId = result.id;
    } catch (e) { console.error('DB save error:', e.message); }
  }
  SESSIONS.set(id, {
    id,
    convId,
    userId,
    state,
    messages: []
  });
  res.json({ sessionId: id, mode, llmEnabled: getLlmHealth().healthy, llmHealth: getLlmHealth() });
});

app.post('/api/chat', async (req, res) => {
  const { sessionId, questionText, userInput, deltaSec = 20, markError = false } = req.body || {};
  const session = SESSIONS.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // ---- Rate limit check (only for logged-in users) ----
  if (session.userId && session.userId !== 'guest') {
    try {
      const count = await db.incrementUsageCounter(session.userId);
      if (count > DAILY_LIMIT) {
        return res.status(429).json({
          error: 'DAILY_LIMIT',
          message: '今天的使用次数已达上限，明天再来吧。',
          count,
          limit: DAILY_LIMIT
        });
      }
    } catch (e) {
      console.error('Rate limit check failed:', e.message);
      // Fail open — let the request through if the counter itself fails
    }
  }

  const state = session.state;
  state.currentQuestion = questionText || state.currentQuestion;
  state.questionDifficulty = analyzeDifficulty(state.currentQuestion);
  state.timeSpentSec += Number(deltaSec) || 0;

  if (markError) {
    state.errorCount += 1;
    pushEvent(state, 'ERROR', 'user_marked_error');
  }

  const progressed = markProgress(state, userInput || '');
  if (progressed) {
    state.noProgressTurns = 0;
  } else {
    state.noProgressTurns += 1;
  }
  session.messages.push({ role: 'user', content: userInput || '', timestamp: Date.now() });

  const conversationMode = detectConversationMode(userInput || '', state);
  state.conversationMode = conversationMode;
  if (conversationMode === 'FINISHED') state.solvedClaimed = true;
  if (conversationMode === 'REVIEW') state.reviewRequested = true;
  if (conversationMode === 'OFF_TOPIC') state.offTopicCount += 1;

  const stateType = classifyState(state, userInput || '');
  if (stateType !== 'NORMAL') {
    pushEvent(state, stateType, userInput || '');
  }

  if (stateType === 'TIME') state.shouldOfferSkip = true;
  if (stateType === 'EMOTION') {
    state.emotionRisk = 'high';
    state.emotionCycles += 1;
  } else {
    state.emotionCycles = 0;
  }
  if (stateType === 'WITHDRAWAL') {
    state.withdrawalCount += 1;
    state.emotionRisk = 'high';
  } else {
    state.withdrawalCount = 0;
  }
  if (stateType === 'META_INTERVENTION') {
    state.metaInterventionCount += 1;
  } else {
    state.metaInterventionCount = 0;
  }
  if (stateType === 'LOW_ENGAGEMENT') {
    state.answerRequestCount += 1;
  } else {
    state.answerRequestCount = 0;
  }
  if (stateType === 'STUCK' || stateType === 'LOW_ENGAGEMENT') {
    state.hintLevel += 1;
  } else if (stateType === 'WITHDRAWAL' || stateType === 'META_INTERVENTION') {
    state.hintLevel = Math.max(1, state.hintLevel);
  } else if (stateType === 'FINISHED' || stateType === 'REVIEW') {
    state.hintLevel = Math.max(0, state.hintLevel - 1);
  } else if (progressed && state.hintLevel > 0) {
    state.hintLevel = Math.max(0, state.hintLevel - 1);
  }

  state.lastStateType = stateType;
  state.lastStrategy = selectStrategy(stateType, state);
  state.lastUserIntent = conversationMode;

  const reply = await buildReply(stateType, state, session, userInput || '');
  session.messages.push({ ...reply, timestamp: Date.now() });

  // Persist conversation to db
  if (session.userId && session.userId !== 'guest') {
    try {
      await db.saveConversation({
        id: session.convId,
        userId: session.userId,
        sessionId: session.id,
        questionText: state.currentQuestion,
        messages: session.messages,
        state
      });
    } catch (e) { console.error('DB save error:', e.message); }
  }

  res.json({
    reply,
    state: {
      mode: state.mode,
      timeSpentSec: state.timeSpentSec,
      hintLevel: state.hintLevel,
      emotionRisk: state.emotionRisk,
      questionDifficulty: state.questionDifficulty,
      shouldOfferSkip: state.shouldOfferSkip,
      lastStateType: stateType,
      llmEnabled: getLlmHealth().healthy,
      lastStrategy: state.lastStrategy,
      conversationMode: state.conversationMode,
      offTopicCount: state.offTopicCount,
      solvedClaimed: state.solvedClaimed,
      reviewRequested: state.reviewRequested,
      noProgressTurns: state.noProgressTurns,
      withdrawalCount: state.withdrawalCount,
      metaInterventionCount: state.metaInterventionCount
    }
  });
});

// Submit exam: marks exam mode as finished and unlocks 复盘
app.post('/api/session/:id/submit', async (req, res) => {
  const session = SESSIONS.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const { finalAnswer = '' } = req.body || {};
  session.state.examSubmitted = true;
  session.state.examFinalAnswer = String(finalAnswer);
  session.state.examSubmittedAt = Date.now();
  // Log a system message so the transcript shows the submission
  session.messages.push({
    role: 'user',
    type: 'EXAM_SUBMIT',
    content: `【提交答案】${finalAnswer || '（未填写最终答案）'}`,
    timestamp: Date.now()
  });
  res.json({ ok: true, submittedAt: session.state.examSubmittedAt });
});

// ============================================================
// 错题手术 endpoints
// ============================================================

const SURGERY_STEP_NAMES = {
  1: '定位病灶',
  2: '寻找线索',
  3: '写下炒菜程序'
};

// Save/refine a single step; optionally ask LLM for feedback.
// Body: { stepNumber: 1|2|3, stepContent: string, questionText?: string, wantFeedback?: boolean }
app.post('/api/session/:id/surgery/step', async (req, res) => {
  const session = SESSIONS.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.state.mode !== 'micro_surgery') {
    return res.status(400).json({ error: '当前会话不是错题手术模式' });
  }

  const { stepNumber, stepContent = '', questionText = '', wantFeedback = true } = req.body || {};
  const n = Number(stepNumber);
  if (![1, 2, 3].includes(n)) {
    return res.status(400).json({ error: 'stepNumber 必须为 1、2 或 3' });
  }
  const trimmed = String(stepContent || '').trim();
  if (!trimmed) {
    return res.status(400).json({ error: '这一步的内容不能为空' });
  }

  // Update state
  session.state.currentQuestion = questionText || session.state.currentQuestion || '';
  session.state[`surgeryStep${n}`] = trimmed;

  // Log step submission in messages (so admin can see the trace)
  session.messages.push({
    role: 'user',
    type: `SURGERY_STEP_${n}`,
    content: `【第${n}步·${SURGERY_STEP_NAMES[n]}】${trimmed}`,
    timestamp: Date.now()
  });

  let feedback = null;
  if (wantFeedback && getLlmHealth().healthy) {
    try {
      feedback = await generateSurgeryStepFeedback({
        stepNumber: n,
        stepName: SURGERY_STEP_NAMES[n],
        stepContent: trimmed,
        questionText: session.state.currentQuestion,
        priorSteps: {
          step1: session.state.surgeryStep1,
          step2: session.state.surgeryStep2
        }
      });
    } catch (e) {
      console.error('[Surgery] step feedback failed:', e.message);
    }
  }

  // Rule-based fallback feedback so the flow never dies
  if (!feedback) {
    feedback = ruleBasedSurgeryFeedback(n, trimmed);
  }

  session.state.surgeryStepFeedback = session.state.surgeryStepFeedback || { 1: null, 2: null, 3: null };
  session.state.surgeryStepFeedback[n] = feedback;

  // Log coach feedback in messages
  if (feedback) {
    const tag = feedback.verdict === 'good' ? '✅' : '✏️';
    const body = feedback.verdict === 'good'
      ? `${tag} ${feedback.comment || '这一步写得够具体。'}`
      : `${tag} ${feedback.comment || '这一步可以更具体。'}${feedback.suggestion ? `\n建议改为：${feedback.suggestion}` : ''}`;
    session.messages.push({
      role: 'assistant',
      type: `SURGERY_FEEDBACK_${n}`,
      content: body,
      timestamp: Date.now()
    });
  }

  // Persist
  if (session.userId && session.userId !== 'guest') {
    try {
      await db.saveConversation({
        id: session.convId,
        userId: session.userId,
        sessionId: session.id,
        questionText: session.state.currentQuestion,
        messages: session.messages,
        state: session.state
      });
    } catch (e) { console.error('DB save error (surgery step):', e.message); }
  }

  res.json({
    ok: true,
    stepNumber: n,
    stepName: SURGERY_STEP_NAMES[n],
    feedback,
    llmEnabled: getLlmHealth().healthy
  });
});

// Finalize: combine three steps into a polished card.
// Body: { questionText?: string }
app.post('/api/session/:id/surgery/finalize', async (req, res) => {
  const session = SESSIONS.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.state.mode !== 'micro_surgery') {
    return res.status(400).json({ error: '当前会话不是错题手术模式' });
  }

  const { questionText = '' } = req.body || {};
  if (questionText) session.state.currentQuestion = questionText;

  const s1 = session.state.surgeryStep1 || '';
  const s2 = session.state.surgeryStep2 || '';
  const s3 = session.state.surgeryStep3 || '';
  if (!s1 || !s2 || !s3) {
    return res.status(400).json({ error: 'MISSING_STEPS', message: '请先完成三步再生成卡片。' });
  }

  let card = null;
  if (getLlmHealth().healthy) {
    try {
      card = await generateSurgeryCard({
        questionText: session.state.currentQuestion,
        step1: s1,
        step2: s2,
        step3: s3
      });
    } catch (e) {
      console.error('[Surgery] card generation failed:', e.message);
    }
  }

  if (!card) {
    // Rule-based fallback: pass the student text through with minimal polishing
    card = {
      title: '错题手术卡',
      knowledgeTag: '（未分类·可手动补充）',
      lesion: s1,
      trigger: s2,
      recipe: s3,
      insight: '把模糊的直觉，变成清晰的"如果…就…"程序。',
      qualityScore: 3,
      qualityComment: '当前未连接 LLM，这张卡是直接收录你的原文。建议连上 LLM 后重新生成以获得打磨。'
    };
  }

  card.finalizedAt = Date.now();
  session.state.surgeryCard = card;
  session.state.surgeryFinalizedAt = card.finalizedAt;

  // Log into transcript
  session.messages.push({
    role: 'assistant',
    type: 'SURGERY_CARD',
    content: `🗂️ 错题手术卡已生成：${card.title || '错题手术卡'}\n口诀：${card.recipe || s3}`,
    timestamp: Date.now()
  });

  // Persist with summary = { surgeryCard, mode: 'micro_surgery' } so admin sees it
  const summaryPayload = {
    mode: 'micro_surgery',
    surgeryCard: card,
    steps: {
      step1: s1,
      step2: s2,
      step3: s3
    },
    stepFeedback: session.state.surgeryStepFeedback,
    llmSummary: getLlmHealth().healthy,
    totalMessages: session.messages.length,
    timeSpentSec: session.state.timeSpentSec,
    hintLevel: session.state.hintLevel
  };

  if (session.userId && session.userId !== 'guest') {
    try {
      await db.saveConversation({
        id: session.convId,
        userId: session.userId,
        sessionId: session.id,
        questionText: session.state.currentQuestion,
        messages: session.messages,
        state: session.state,
        summary: summaryPayload
      });
    } catch (e) { console.error('DB save error (surgery finalize):', e.message); }
  }

  res.json({
    ok: true,
    card,
    llmEnabled: getLlmHealth().healthy
  });
});

// Rule-based surgery feedback (fallback when no LLM)
function ruleBasedSurgeryFeedback(stepNumber, content) {
  const text = String(content || '').trim();

  if (stepNumber === 1) {
    // Bad if only vague words like "粗心 / 不熟 / 马虎 / 算错"
    const vague = ['粗心', '马虎', '不熟', '不会', '算错了', '忘了', '大意'];
    const onlyVague = vague.some((v) => text.includes(v)) && text.length < 14;
    if (onlyVague || text.length < 6) {
      return {
        verdict: 'needs_work',
        comment: '这一步还停在"感觉"层面，没有落到具体知识点上。',
        suggestion: '试着写成："我不知道这里要用 ___（某个具体的公式/定理/辅助线）"——把错误命名到一个你能查到的知识点上。'
      };
    }
    return {
      verdict: 'good',
      comment: '不错，已经把错因锁定到具体的概念或方法上了。',
      suggestion: ''
    };
  }

  if (stepNumber === 2) {
    const vague = ['这种题', '这类题', '看到题目', '知道用', '就该用'];
    const onlyVague = vague.some((v) => text.includes(v)) && text.length < 16;
    if (onlyVague || text.length < 6) {
      return {
        verdict: 'needs_work',
        comment: '线索还太笼统，没有锁定题目里某个具体的"触发词"。',
        suggestion: '试着写成："看到 ___（题目中出现的某个具体词或条件，如"中点""对称""整数解"）就应该想到 ___"。'
      };
    }
    return {
      verdict: 'good',
      comment: '很好，锁定到了一个具体的触发词，这正是以后要训练自己看见的那个字眼。',
      suggestion: ''
    };
  }

  // Step 3
  const hasIfThen = /如果|只要|看到|一旦/.test(text) && /就|则|先|直接/.test(text);
  if (!hasIfThen || text.length < 10) {
    return {
      verdict: 'needs_work',
      comment: '口诀还没有写成"如果…就…"的标准结构，下次不容易被快速唤起。',
      suggestion: '改写成固定句式："如果 [触发条件]，就 [具体动作]"——触发条件用原题会出现的词，动作用一步可执行的方法。'
    };
  }
  return {
    verdict: 'good',
    comment: '这条口诀已经是"如果…就…"的结构了，下次考试时大脑能被它直接唤起。',
    suggestion: ''
  };
}

app.get('/api/session/:id/summary', async (req, res) => {
  const session = SESSIONS.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.state.mode === 'exam' && !session.state.examSubmitted) {
    return res.status(403).json({ error: 'EXAM_NOT_SUBMITTED', message: '考试还没结束，请先提交答案再查看复盘。' });
  }
  // For micro_surgery mode, return the surgery card as the summary
  if (session.state.mode === 'micro_surgery') {
    if (!session.state.surgeryCard) {
      return res.status(403).json({ error: 'SURGERY_NOT_FINALIZED', message: '请先完成三步并点击"生成手术卡"。' });
    }
    return res.json({
      mode: 'micro_surgery',
      surgeryCard: session.state.surgeryCard,
      steps: {
        step1: session.state.surgeryStep1,
        step2: session.state.surgeryStep2,
        step3: session.state.surgeryStep3
      },
      stepFeedback: session.state.surgeryStepFeedback,
      totalMessages: session.messages.length,
      timeSpentSec: session.state.timeSpentSec,
      hintLevel: session.state.hintLevel,
      llmSummary: getLlmHealth().healthy
    });
  }
  const summary = await buildSummary(session);
  // Persist summary to db
  if (session.userId && session.userId !== 'guest') {
    try {
      await db.saveConversation({
        id: session.convId,
        userId: session.userId,
        sessionId: session.id,
        questionText: session.state.currentQuestion,
        messages: session.messages,
        state: session.state,
        summary
      });
    } catch (e) { console.error('DB save summary error:', e.message); }
  }
  res.json(summary);
});

app.get('/api/session/:id/messages', (req, res) => {
  const session = SESSIONS.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ messages: session.messages, state: session.state, llmEnabled: getLlmHealth().healthy, llmHealth: getLlmHealth() });
});


app.get('/api/llm-health', async (req, res) => {
  const force = String(req.query.force || '') === '1';
  const health = await checkLlmHealth(force);
  res.json(health);
});

// ============================================================
// Auth endpoints
// ============================================================

app.post('/api/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.json({ error: '请填写用户名和密码' });
  if (username.length < 2) return res.json({ error: '用户名至少 2 个字符' });
  if (password.length < 4) return res.json({ error: '密码至少 4 个字符' });
  const result = await db.createUser({ username, password, displayName, role: 'student' });
  res.json(result);
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ error: '请填写用户名和密码' });
  const result = await db.authenticateUser(username, password);
  res.json(result);
});

// ============================================================
// Admin endpoints (teacher-only)
// ============================================================

async function requireTeacher(req, res, next) {
  const userId = req.headers['x-user-id'] || '';
  if (!userId) return res.status(401).json({ error: '未登录' });
  const user = await db.getUserById(userId);
  if (!user || user.role !== 'teacher') {
    return res.status(403).json({ error: '需要教师权限' });
  }
  req.teacher = user;
  next();
}

// List all students
app.get('/api/admin/students', requireTeacher, async (req, res) => {
  const students = await db.getAllUsers();
  res.json({ students });
});

// Add a student
app.post('/api/admin/students', requireTeacher, async (req, res) => {
  const { username, password = '123456', displayName, role = 'student' } = req.body || {};
  if (!username) return res.json({ error: '请填写用户名' });
  const result = await db.createUser({ username, password, displayName, role });
  res.json(result);
});

// Get a student's conversations
app.get('/api/admin/students/:id/conversations', requireTeacher, async (req, res) => {
  const convos = await db.getConversationsByUser(req.params.id);
  res.json({ conversations: convos });
});

// Get a single conversation detail
app.get('/api/admin/conversations/:id', requireTeacher, async (req, res) => {
  const convo = await db.getConversation(req.params.id);
  if (!convo) return res.status(404).json({ error: '会话不存在' });
  res.json(convo);
});

// Delete a student
app.delete('/api/admin/students/:id', requireTeacher, async (req, res) => {
  const result = await db.deleteUser(req.params.id);
  res.json(result);
});

app.listen(PORT, async () => {
  await db.connect();
  try {
    await db.ensureDefaultTeacher();
  } catch (e) {
    console.error('Could not create default teacher (DB not connected?):', e.message);
  }
  const health = await checkLlmHealth(true);
  console.log(`茹意宝 running on http://localhost:${PORT}`);
  console.log(`KEY IN SERVER: ${health.keyPreview || 'NO KEY'}`);
  if (!health.configured) {
    console.log('LLM mode: disabled (no LLM_API_KEY, fallback mode)');
  } else if (health.healthy) {
    console.log(`LLM mode: healthy (${health.model})`);
  } else {
    console.log(`LLM mode: fallback (${health.error})`);
  }
});
