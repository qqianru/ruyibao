// db.js - MongoDB Atlas persistence via Mongoose
// 扩展版：增加 parent role + parent chat + expert request

const mongoose = require('mongoose');
const crypto = require('crypto');

// ============================================================
// Schemas
// ============================================================

const userSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true, trim: true },
  displayName: { type: String, default: '' },
  // ★ 扩展 enum: 增加 'parent'
  role:        { type: String, enum: ['student', 'parent', 'teacher'], default: 'student' },
  passwordHash:{ type: String, required: true },
  createdAt:   { type: Number, default: () => Date.now() }
});

// 学生会话（保持原有结构）
const conversationSchema = new mongoose.Schema({
  userId:       { type: String, required: true, index: true },
  // creatorRole: 这条 session 是哪种角色的人产生的。
  // 一般是 'student'；家长进学生区试用时记 'parent'；老师试用时 'teacher'。
  // 旧数据没有这个字段，读出来是 undefined，admin 端按 'student' 处理即可。
  creatorRole:  { type: String, default: 'student', index: true },
  sessionId:    { type: String, index: true},
  questionText: { type: String, default: '' },
  messages:     { type: Array, default: [] },
  state:        { type: Object, default: {} },
  summary:      { type: Object, default: null },
  createdAt:    { type: Number, default: () => Date.now() },
  updatedAt:    { type: Number, default: () => Date.now() }
});

// ★ 新增：家长会话（结构更简单——只是聊天记录）
const parentConversationSchema = new mongoose.Schema({
  userId:       { type: String, required: true, index: true },
  scenarioId:   { type: String, default: null },
  messages:     { type: Array, default: [] },
  expertRequested: { type: Boolean, default: false },
  createdAt:    { type: Number, default: () => Date.now() },
  updatedAt:    { type: Number, default: () => Date.now() }
});

// ★ 新增：专家转介请求
const expertRequestSchema = new mongoose.Schema({
  userId:                { type: String, required: true, index: true },
  parentConversationId:  { type: String, required: true, index: true },
  urgency:               { type: String, enum: ['severe', 'non_crisis'], required: true },
  status:                { type: String, enum: ['pending', 'contacted', 'resolved'], default: 'pending' },
  parentPhone:           { type: String, default: '' },
  conversationSummary:   { type: String, default: '' },
  notes:                 { type: String, default: '' },
  createdAt:             { type: Number, default: () => Date.now() },
  contactedAt:           { type: Number, default: null }
});

const rateLimitSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  date:   { type: String, required: true },
  count:  { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 172800 }
});
rateLimitSchema.index({ userId: 1, date: 1 }, { unique: true });

const responseCacheSchema = new mongoose.Schema({
  questionHash: { type: String, required: true, unique: true, index: true },
  content:      { type: String, required: true },
  createdAt:    { type: Date, default: Date.now, expires: 2592000 }
});

const RateLimit = mongoose.model('RateLimit', rateLimitSchema);
const ResponseCache = mongoose.model('ResponseCache', responseCacheSchema);
const User = mongoose.model('User', userSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);
const ParentConversation = mongoose.model('ParentConversation', parentConversationSchema);
const ExpertRequest = mongoose.model('ExpertRequest', expertRequestSchema);

// ============================================================
// Connect
// ============================================================

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('WARNING: No MONGODB_URI set. Database will NOT work.');
    return;
  }
  try {
    await mongoose.connect(uri);
    console.log('Connected to MongoDB Atlas');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
}

// ============================================================
// Password hashing
// ============================================================

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + plain).digest('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.createHash('sha256').update(salt + plain).digest('hex');
  return check === hash;
}

// ============================================================
// User CRUD
// ============================================================

function safeUser(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  const { passwordHash, __v, ...safe } = obj;
  safe.id = safe._id?.toString() || safe.id;
  delete safe._id;
  return safe;
}

async function getAllUsers() {
  const users = await User.find({}).lean();
  return users.map(u => {
    const { passwordHash, __v, _id, ...safe } = u;
    return { id: _id.toString(), ...safe };
  });
}

async function getUserById(id) {
  try {
    const u = await User.findById(id);
    return u;
  } catch { return null; }
}

async function getUserByUsername(username) {
  return User.findOne({ username });
}

async function createUser({ username, password, displayName = '', role = 'student' }) {
  if (!['student', 'parent', 'teacher'].includes(role)) {
    return { error: '无效的角色类型' };
  }
  const existing = await User.findOne({ username });
  if (existing) return { error: '用户名已存在' };
  const user = await User.create({
    username,
    displayName: displayName || username,
    role,
    passwordHash: hashPassword(password)
  });
  return { user: safeUser(user) };
}

async function updateUser(id, updates) {
  if (updates.password) {
    updates.passwordHash = hashPassword(updates.password);
    delete updates.password;
  }
  const user = await User.findByIdAndUpdate(id, updates, { new: true });
  if (!user) return { error: '用户不存在' };
  return { user: safeUser(user) };
}

async function deleteUser(id) {
  const user = await User.findByIdAndDelete(id);
  if (!user) return { error: '用户不存在' };
  await Conversation.deleteMany({ userId: id });
  await ParentConversation.deleteMany({ userId: id });
  return { ok: true };
}

async function authenticateUser(username, password) {
  const user = await User.findOne({ username });
  if (!user) return { error: '用户名或密码错误' };
  if (!verifyPassword(password, user.passwordHash)) return { error: '用户名或密码错误' };
  return { user: safeUser(user) };
}

// ============================================================
// Student Conversation CRUD (existing, unchanged)
// ============================================================

async function getConversationsByUser(userId) {
  const convos = await Conversation.find({ userId }).sort({ createdAt: -1 }).lean();
  return convos.map(c => {
    const { _id, __v, ...rest } = c;
    return { id: _id.toString(), ...rest };
  });
}

async function getConversation(id) {
  try {
    const c = await Conversation.findById(id).lean();
    if (!c) return null;
    const { _id, __v, ...rest } = c;
    return { id: _id.toString(), ...rest };
  } catch { return null; }
}

async function saveConversation({ id, userId, creatorRole, sessionId, questionText, messages, state, summary }) {
  if (id) {
    const existing = await Conversation.findById(id);
    if (existing) {
      if (questionText !== undefined) existing.questionText = questionText;
      if (messages !== undefined) existing.messages = messages;
      if (state !== undefined) existing.state = state;
      if (summary !== undefined) existing.summary = summary;
      existing.updatedAt = Date.now();
      await existing.save();
      return { id: existing._id.toString() };
    }
  }
  const convo = await Conversation.create({
    userId, sessionId,
    // 默认 'student'，跟 schema 默认值一致；调用方传了别的（'parent'/'teacher'）就用传的
    creatorRole: creatorRole || 'student',
    questionText: questionText || '',
    messages: messages || [],
    state: state || {},
    summary: summary || null
  });
  return { id: convo._id.toString() };
}

async function deleteConversation(id) {
  const c = await Conversation.findByIdAndDelete(id);
  if (!c) return { error: '会话不存在' };
  return { ok: true };
}

// ============================================================
// ★ Parent Conversation CRUD (NEW)
// ============================================================

async function createParentConversation({ userId, scenarioId = null, openingMessages = [] }) {
  const convo = await ParentConversation.create({
    userId,
    scenarioId,
    messages: openingMessages
  });
  return { id: convo._id.toString() };
}

async function getParentConversation(id) {
  try {
    const c = await ParentConversation.findById(id).lean();
    if (!c) return null;
    const { _id, __v, ...rest } = c;
    return { id: _id.toString(), ...rest };
  } catch { return null; }
}

async function getParentConversationsByUser(userId) {
  const convos = await ParentConversation.find({ userId })
    .sort({ updatedAt: -1 })
    .lean();
  return convos.map(c => {
    const { _id, __v, ...rest } = c;
    return { id: _id.toString(), ...rest };
  });
}

async function appendParentMessage(conversationId, message) {
  const convo = await ParentConversation.findById(conversationId);
  if (!convo) return { error: '会话不存在' };
  convo.messages.push(message);
  convo.updatedAt = Date.now();
  await convo.save();
  return { ok: true, messageCount: convo.messages.length };
}

async function markParentConversationExpertRequested(conversationId) {
  await ParentConversation.findByIdAndUpdate(conversationId, {
    expertRequested: true,
    updatedAt: Date.now()
  });
}

// ============================================================
// ★ Expert Request CRUD (NEW)
// ============================================================

async function createExpertRequest({ userId, parentConversationId, urgency, parentPhone = '', conversationSummary = '' }) {
  const existing = await ExpertRequest.findOne({
    parentConversationId,
    status: 'pending'
  });
  if (existing) {
    if (parentPhone && !existing.parentPhone) existing.parentPhone = parentPhone;
    if (urgency === 'severe' && existing.urgency !== 'severe') existing.urgency = 'severe';
    if (conversationSummary) existing.conversationSummary = conversationSummary;
    await existing.save();
    return { id: existing._id.toString(), updated: true };
  }
  const req = await ExpertRequest.create({
    userId,
    parentConversationId,
    urgency,
    parentPhone,
    conversationSummary
  });
  await markParentConversationExpertRequested(parentConversationId);
  return { id: req._id.toString(), created: true };
}

async function getExpertRequests({ status = null, urgency = null } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (urgency) filter.urgency = urgency;
  const requests = await ExpertRequest.find(filter)
    .sort({ urgency: 1, createdAt: -1 })
    .lean();
  const userIds = [...new Set(requests.map(r => r.userId))];
  const users = await User.find({ _id: { $in: userIds } }).lean();
  const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));
  return requests.map(r => {
    const { _id, __v, ...rest } = r;
    const user = userMap[r.userId];
    return {
      id: _id.toString(),
      ...rest,
      username: user ? user.username : '(unknown)',
      displayName: user ? user.displayName : ''
    };
  });
}

async function updateExpertRequest(id, updates) {
  const allowedFields = ['status', 'parentPhone', 'notes', 'contactedAt'];
  const filtered = {};
  for (const k of allowedFields) {
    if (updates[k] !== undefined) filtered[k] = updates[k];
  }
  if (filtered.status === 'contacted' && !filtered.contactedAt) {
    filtered.contactedAt = Date.now();
  }
  const req = await ExpertRequest.findByIdAndUpdate(id, filtered, { new: true });
  if (!req) return { error: '请求不存在' };
  return { ok: true };
}

// ============================================================
// Bootstrap
// ============================================================

async function ensureDefaultTeacher() {
  const count = await User.countDocuments({ role: 'teacher' });
  if (count === 0) {
    await createUser({
      username: 'teacher',
      password: 'teacher123',
      displayName: '默认教师',
      role: 'teacher'
    });
    console.log('Created default teacher account: teacher / teacher123');
  }
}

// ============================================================
// Rate limiting + response cache
// ============================================================
async function incrementUsageCounter(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = await RateLimit.findOneAndUpdate(
    { userId, date: today },
    { $inc: { count: 1 }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, new: true }
  );
  return doc.count;
}

async function getUsageCount(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = await RateLimit.findOne({ userId, date: today }).lean();
  return doc ? doc.count : 0;
}

async function getCachedResponse(questionHash) {
  const doc = await ResponseCache.findOne({ questionHash }).lean();
  return doc ? doc.content : null;
}

async function saveCachedResponse(questionHash, content) {
  try {
    await ResponseCache.create({ questionHash, content });
  } catch (err) {
    if (err.code !== 11000) console.error('Cache save error:', err.message);
  }
}

module.exports = {
  connect,
  ensureDefaultTeacher,
  getAllUsers,
  getUserById,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  safeUser,
  authenticateUser,
  getConversationsByUser,
  getConversation,
  saveConversation,
  deleteConversation,
  // NEW: parent conversation
  createParentConversation,
  getParentConversation,
  getParentConversationsByUser,
  appendParentMessage,
  markParentConversationExpertRequested,
  // NEW: expert request
  createExpertRequest,
  getExpertRequests,
  updateExpertRequest,
  // existing
  incrementUsageCounter,
  getUsageCount,
  getCachedResponse,
  saveCachedResponse
};
