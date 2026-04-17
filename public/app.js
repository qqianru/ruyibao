let sessionId = null;
let sessionMode = 'practice';
let examSubmitted = false;
let appUser = null;
try { appUser = JSON.parse(localStorage.getItem('mc_user')); } catch {}

function getUserId() {
  return appUser ? appUser.id : 'guest';
}

const els = {
  modeSelect: document.getElementById('modeSelect'),
  questionInput: document.getElementById('questionInput'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  loadSummaryBtn: document.getElementById('loadSummaryBtn'),
  stateView: document.getElementById('stateView'),
  chatLog: document.getElementById('chatLog'),
  userInput: document.getElementById('userInput'),
  deltaInput: document.getElementById('deltaInput'),
  markErrorInput: document.getElementById('markErrorInput'),
  sendBtn: document.getElementById('sendBtn'),
  summaryPanel: document.getElementById('summaryPanel'),
  summaryContent: document.getElementById('summaryContent'),
  llmBadge: document.getElementById('llmBadge')
};

function setLlmBadge(health) {
  if (!els.llmBadge) return;
  if (!health || !health.configured) {
    els.llmBadge.textContent = 'LLM: fallback';
    els.llmBadge.className = 'llm-badge warn';
    return;
  }
  if (health.healthy) {
    els.llmBadge.textContent = `LLM: healthy · ${health.model || 'model'}`;
    els.llmBadge.className = 'llm-badge ok';
    return;
  }
  els.llmBadge.textContent = 'LLM: fallback (key/config issue)';
  els.llmBadge.className = 'llm-badge warn';
}

async function checkLlmHealth(force = false) {
  try {
    const res = await fetch(`/api/llm-health${force ? '?force=1' : ''}`);
    const data = await res.json();
    setLlmBadge(data);
  } catch {
    setLlmBadge(null);
  }
}

function addMessage(role, content, type = '') {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = `
    <div class="bubble">
      <div class="meta">${role === 'user' ? '学生' : '王鹰教授'}${type ? ` · ${type}` : ''}</div>
      <div>${content}</div>
    </div>
  `;
  els.chatLog.appendChild(div);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function renderState(state) {
  if (!state) return;
  els.stateView.innerHTML = `
    <div>会话：${sessionId || '未开始'}</div>
    <div>模式：${state.mode}</div>
    <div>对话状态：${state.conversationMode || 'SOLVING'}</div>
    <div>用时：${state.timeSpentSec} 秒</div>
    <div>提示层级：${state.hintLevel}</div>
    <div>情绪风险：${state.emotionRisk}</div>
    <div>题目难度：${state.questionDifficulty}</div>
    <div>最近状态：${state.lastStateType || 'NORMAL'}</div>
    <div>建议跳题：${state.shouldOfferSkip ? '是' : '否'}</div>
  `;
}

async function createSession() {
  const mode = els.modeSelect.value;
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, userId: getUserId() })
  });
  const data = await res.json();
  sessionId = data.sessionId;
  sessionMode = mode;
  examSubmitted = false;
  els.chatLog.innerHTML = '';
  els.summaryPanel.hidden = true;
  setLlmBadge(data.llmHealth);
  updateExamUi();
  const openingMsg = mode === 'exam'
    ? '考试模式已开始。教练不会给提示。请独立作答，完成后点击"提交答案"。'
    : '会话已开始。你可以直接输入学生话语来模拟真实做题过程。';
  addMessage('assistant', openingMsg, 'SYSTEM');
  renderState({
    mode,
    conversationMode: 'SOLVING',
    timeSpentSec: 0,
    hintLevel: 0,
    emotionRisk: 'low',
    questionDifficulty: 'medium',
    shouldOfferSkip: false,
    lastStateType: 'NORMAL'
  });
}

function updateExamUi() {
  const submitBtn = document.getElementById('submitExamBtn');
  const loadBtn = els.loadSummaryBtn;
  const banner = document.getElementById('examBanner');
  if (sessionMode === 'exam' && !examSubmitted) {
    if (submitBtn) submitBtn.style.display = '';
    if (loadBtn) loadBtn.disabled = true;
    if (banner) banner.style.display = '';
  } else {
    if (submitBtn) submitBtn.style.display = 'none';
    if (loadBtn) loadBtn.disabled = false;
    if (banner) banner.style.display = 'none';
  }
}

async function submitExam() {
  if (!sessionId) return alert('还没有开始考试。');
  if (examSubmitted) return;
  const finalAnswer = prompt('请输入你的最终答案（可留空）：', '') || '';
  if (!confirm('确定要提交吗？提交后教练会开始生成复盘，过程不可撤销。')) return;
  const res = await fetch(`/api/session/${sessionId}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finalAnswer })
  });
  const data = await res.json();
  if (data.error) return alert(data.error);
  examSubmitted = true;
  addMessage('user', `【提交答案】${finalAnswer || '（未填写）'}`, 'EXAM_SUBMIT');
  addMessage('assistant', '答案已提交。你可以点击"查看复盘"看看刚才的表现。', 'SYSTEM');
  updateExamUi();
}

async function sendMessage(prefilled = null) {
  if (!sessionId) {
    await createSession();
  }
  const userInput = prefilled || els.userInput.value.trim();
  const questionText = els.questionInput.value.trim();
  if (!userInput) return;

  addMessage('user', userInput);
  els.userInput.value = '';

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      questionText,
      userInput,
      deltaSec: Number(els.deltaInput.value || 20),
      markError: els.markErrorInput.checked,
      userId: getUserId()
    })
  });
  const data = await res.json();
  addMessage('assistant', data.reply.content, data.reply.type);
  renderState(data.state);
  els.markErrorInput.checked = false;
}

async function loadSummary() {
  if (!sessionId) {
    alert('请先开始新会话，再查看复盘。');
    return;
  }
  if (sessionMode === 'exam' && !examSubmitted) {
    alert('考试还没结束，请先提交答案再查看复盘。');
    return;
  }
  els.summaryPanel.hidden = false;
  els.summaryContent.innerHTML = '<p style="color:var(--muted);padding:20px;text-align:center;">正在生成复盘，请稍候…</p>';
  els.summaryPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const res = await fetch(`/api/session/${sessionId}/summary`);
  const data = await res.json();
  if (data.error) {
    els.summaryContent.innerHTML = `<p style="color:#b91c1c;padding:20px;">${data.message || data.error}</p>`;
    return;
  }

  const esc = (s) => {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  };
  const list = (arr, empty = '暂无') => {
    if (!arr || arr.length === 0) return `<li style="color:var(--muted);">${empty}</li>`;
    return arr.map((s) => `<li>${esc(s)}</li>`).join('');
  };

  let html = '';

  // ---- 1. 学生视角的本次发生了什么 ----
  if (data.studentFacing) {
    html += `
      <div class="summary-section student-facing">
        <h3>📝 这次发生了什么</h3>
        <p>${esc(data.studentFacing.whatHappened)}</p>
        ${data.studentFacing.oneThingToSee ? `<p class="one-thing"><strong>下次只需要看见这一件事：</strong>${esc(data.studentFacing.oneThingToSee)}</p>` : ''}
      </div>
    `;
  } else {
    html += `
      <div class="summary-section">
        <h3>📝 这次发生了什么</h3>
        <p>${esc(data.whatHappened || '暂无明显问题。')}</p>
      </div>
    `;
  }

  // ---- 2. 知识点诊断（知识空白 / 欠缺 / 已掌握）----
  if (data.knowledgeDiagnosis) {
    const kd = data.knowledgeDiagnosis;
    html += `
      <div class="summary-section knowledge-diag">
        <h3>📚 知识点定位</h3>
        <div class="kd-grid">
          <div class="kd-card kd-gap">
            <div class="kd-label">知识空白（不会）</div>
            <ul>${list(kd.gaps, '未发现明显空白')}</ul>
          </div>
          <div class="kd-card kd-fuzzy">
            <div class="kd-label">知识夹生（记得但用不熟）</div>
            <ul>${list(kd.fuzzy, '未发现明显夹生点')}</ul>
          </div>
          <div class="kd-card kd-mastered">
            <div class="kd-label">已掌握</div>
            <ul>${list(kd.mastered, '本题未明显体现')}</ul>
          </div>
        </div>
      </div>
    `;
  }

  // ---- 3. S-E-R 链条 ----
  if (data.serChain && data.serChain.triggered) {
    const s = data.serChain;
    html += `
      <div class="summary-section ser-chain">
        <h3>🔗 程序轨迹（S → E → R）</h3>
        ${s.cerType && s.cerType !== '无明显CER' ? `<div class="cer-badge">识别到的程序类型：<strong>${esc(s.cerType)}</strong></div>` : ''}
        <div class="ser-flow">
          <div class="ser-node ser-s">
            <div class="ser-tag">S · 触发情境</div>
            <div class="ser-text">${esc(s.S || '—')}</div>
          </div>
          <div class="ser-arrow">→</div>
          <div class="ser-node ser-e">
            <div class="ser-tag">E · 自动情绪</div>
            <div class="ser-text">${esc(s.E || '—')}</div>
          </div>
          <div class="ser-arrow">→</div>
          <div class="ser-node ser-r">
            <div class="ser-tag">R · 行为反应</div>
            <div class="ser-text">${esc(s.R || '—')}</div>
          </div>
        </div>
        ${s.description ? `<p class="ser-desc">${esc(s.description)}</p>` : ''}
      </div>
    `;
  } else if (data.serChain && !data.serChain.triggered) {
    html += `
      <div class="summary-section">
        <h3>🔗 程序轨迹</h3>
        <p style="color:var(--muted);">本次没有明显的自动化情绪-行为程序被触发，整体推进比较平稳。</p>
      </div>
    `;
  }

  // ---- 4. 真正的卡点 ----
  if (data.rootCause) {
    html += `
      <div class="summary-section root-cause">
        <h3>🎯 真正的卡点</h3>
        <p><strong>${esc(data.rootCause)}</strong></p>
      </div>
    `;
  }

  // ---- 5. 下次的训练任务 ----
  if (data.metacognitiveTraining) {
    const mt = data.metacognitiveTraining;
    html += `
      <div class="summary-section training-task">
        <h3>🧠 下次的训练</h3>
        <div class="training-card">
          <div class="training-task-text">${esc(mt.task)}</div>
          ${mt.whenToUse ? `<div class="training-when"><strong>什么时候用：</strong>${esc(mt.whenToUse)}</div>` : ''}
          ${mt.rationale ? `<div class="training-why"><strong>为什么有用：</strong>${esc(mt.rationale)}</div>` : ''}
        </div>
      </div>
    `;
  } else if (data.nextAction) {
    html += `
      <div class="summary-section">
        <h3>🧠 下次只改一件事</h3>
        <p>${esc(data.nextAction)}</p>
      </div>
    `;
  }

  // ---- 6. 基础数据（折叠起来，不抢视觉）----
  html += `
    <details class="summary-meta">
      <summary>基础数据</summary>
      <div class="summary-grid">
        <div class="summary-card"><strong>总消息数</strong><span>${data.totalMessages}</span></div>
        <div class="summary-card"><strong>总用时</strong><span>${data.timeSpentSec} 秒</span></div>
        <div class="summary-card"><strong>提示层级</strong><span>${data.hintLevel}</span></div>
        <div class="summary-card"><strong>复盘来源</strong><span>${data.llmSummary ? 'AI 深度诊断' : '规则引擎'}</span></div>
      </div>
    </details>
  `;

  els.summaryContent.innerHTML = html;
}

els.newSessionBtn.addEventListener('click', createSession);
els.sendBtn.addEventListener('click', () => sendMessage());
els.loadSummaryBtn.addEventListener('click', loadSummary);
const submitExamBtn = document.getElementById('submitExamBtn');
if (submitExamBtn) submitExamBtn.addEventListener('click', submitExam);

document.querySelectorAll('.quick-actions button').forEach((btn) => {
  btn.addEventListener('click', () => sendMessage(btn.dataset.text));
});

checkLlmHealth();
