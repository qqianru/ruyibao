// db.js - MongoDB Atlas persistence via Mongoose
// 用 Mongoose 连接 MongoDB Atlas 免费集群，数据不会因 Render 重启而丢失

const mongoose = require('mongoose');
const crypto = require('crypto');

// ============================================================
// Schemas
// ============================================================

const userSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true, trim: true },
  displayName: { type: String, default: '' },
  role:        { type: String, enum: ['student', 'teacher'], default: 'student' },
  passwordHash:{ type: String, required: true },
  createdAt:   { type: Number, default: () => Date.now() }
});

const conversationSchema = new mongoose.Schema({
  userId:       { type: String, required: true, index: true },
  sessionId:    { type: String },
  questionText: { type: String, default: '' },
  messages:     { type: Array, default: [] },
  state:        { type: Object, default: {} },
  summary:      { type: Object, default: null },
  createdAt:    { type: Number, default: () => Date.now() },
  updatedAt:    { type: Number, default: () => Date.now() }
});

const User = mongoose.model('User', userSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

// ============================================================
// Connect
// ============================================================

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('WARNING: No MONGODB_URI set. Database will NOT work.');
    console.error('Set MONGODB_URI in your .env or Render environment variables.');
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
// Password hashing (sha256 + salt)
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
  // Also delete user's conversations
  await Conversation.deleteMany({ userId: id });
  return { ok: true };
}

async function authenticateUser(username, password) {
  const user = await User.findOne({ username });
  if (!user) return { error: '用户名或密码错误' };
  if (!verifyPassword(password, user.passwordHash)) return { error: '用户名或密码错误' };
  return { user: safeUser(user) };
}

// ============================================================
// Conversation CRUD
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

async function saveConversation({ id, userId, sessionId, questionText, messages, state, summary }) {
  if (id) {
    // Try to update existing
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
  // Create new
  const convo = await Conversation.create({
    userId,
    sessionId,
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
// Bootstrap: create default teacher if none exists
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
  deleteConversation
};
