const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { computeAnalytics } = require('./analytics');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/vote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vote.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'remote.html')));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/prajnix_labs';
let isMongoConnected = false;

mongoose.set('bufferCommands', false);

// ==========================================
// SECURITY: XSS HTML ESCAPING & PROFANITY FILTER
// ==========================================
const PROFANITY_LIST = [
  'badword', 'abuse', 'spam', 'idiot', 'stupid', 'hate',
  'bastard', 'asshole', 'bitch', 'fuck', 'shit', 'crap',
  'bc', 'mc', 'chutiya', 'saala', 'kamina', 'kutta', 'harami', 'gandu'
];

function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeInput(text, maxLength = 280) {
  if (!text || typeof text !== 'string') return '';
  let clean = text.trim().slice(0, maxLength);
  PROFANITY_LIST.forEach((word) => {
    const reg = new RegExp(`\\b${word}\\b`, 'gi');
    clean = clean.replace(reg, '****');
  });
  return escapeHtml(clean);
}

// Per-Socket Rate Limiter Map
const socketRateLimits = new Map();
function isRateLimited(socketId, minIntervalMs = 280) {
  const now = Date.now();
  const last = socketRateLimits.get(socketId) || 0;
  if (now - last < minIntervalMs) return true;
  socketRateLimits.set(socketId, now);
  return false;
}

const SlideSchema = new mongoose.Schema({
  id: String,
  type: String, // 'RATING_SLIDER' | 'WORD_CLOUD' | 'MULTIPLE_CHOICE' | 'OPEN_ENDED' | 'RANKING' | 'QA'
  question: String,
  minLabel: { type: String, default: '1 = Bad' },
  maxLabel: { type: String, default: '5 = Good' },
  distribution: { type: Object, default: () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }) },
  options: { type: Array, default: [] }, // [{ id, text, votes, isCorrect }]
  items: { type: Array, default: [] },
  responses: { type: Array, default: [] },
  words: { type: Array, default: [] },
  questions: { type: Array, default: [] }
}, { _id: false, minimize: false });

const SessionSchema = new mongoose.Schema({
  pin: { type: String, required: true, unique: true, index: true },
  hostToken: { type: String, required: true },
  title: String,
  status: { type: String, default: 'DRAFT' },
  allowMultipleVotes: { type: Boolean, default: false },
  pacingMode: { type: String, default: 'SELF' }, // 'SELF' | 'HOST'
  hideResults: { type: Boolean, default: false },
  timerEndsAt: { type: Number, default: null },
  timerDuration: { type: Number, default: 0 },
  currentSlideIndex: { type: Number, default: 0 },
  slides: [SlideSchema],
  createdAt: { type: Date, default: Date.now }
}, { minimize: false });

SessionSchema.index({ pin: 1, status: 1 });

const SessionModel = mongoose.model('Session', SessionSchema);
const sessions = new Map();
const activeTimers = new Map();
const broadcastBuffers = new Map();
const saveBuffers = new Map();

function getSessionFilePath(sessionObj) {
  const safeTitle = (sessionObj.title || 'Session')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return path.join(DATA_DIR, `${safeTitle || 'Session'}_${sessionObj.pin}.json`);
}

function saveSessionToIndividualFile(sessionObj) {
  try {
    const targetFilePath = getSessionFilePath(sessionObj);
    const existingFiles = fs.readdirSync(DATA_DIR);
    existingFiles.forEach((file) => {
      if (file.endsWith(`_${sessionObj.pin}.json`) && path.join(DATA_DIR, file) !== targetFilePath) {
        fs.unlinkSync(path.join(DATA_DIR, file));
      }
    });
    fs.writeFileSync(targetFilePath, JSON.stringify(sessionObj, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Error writing file for session ${sessionObj.pin}:`, err.message);
  }
}

function ensureSlideDefaults(sessionObj) {
  if (!sessionObj.hostToken) {
    sessionObj.hostToken = crypto.randomBytes(12).toString('hex');
  }
  if (!sessionObj.pacingMode) sessionObj.pacingMode = 'SELF';
  if (typeof sessionObj.hideResults !== 'boolean') sessionObj.hideResults = false;
  if (sessionObj.timerEndsAt === undefined) sessionObj.timerEndsAt = null;
  if (sessionObj.timerDuration === undefined) sessionObj.timerDuration = 0;

  // Clean up legacy theme field if present
  if (sessionObj.theme !== undefined) delete sessionObj.theme;

  if (!Array.isArray(sessionObj.slides)) return;
  const seen = new Set();
  sessionObj.slides.forEach((slide, idx) => {
    if (!slide.id || seen.has(slide.id)) {
      slide.id = `slide_${idx + 1}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    }
    seen.add(slide.id);

    if (!slide.distribution) slide.distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    if (!Array.isArray(slide.responses)) slide.responses = [];
    if (!Array.isArray(slide.words)) slide.words = [];
    if (!Array.isArray(slide.questions)) slide.questions = [];

    slide.responses.forEach((r, rIdx) => {
      if (!r.id) r.id = `resp_${idx}_${rIdx}_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
    });
    slide.questions.forEach((q, qIdx) => {
      if (!q.id) q.id = `q_${idx}_${qIdx}_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
    });

    if (!Array.isArray(slide.options) || (slide.type === 'MULTIPLE_CHOICE' && slide.options.length === 0)) {
      slide.options = [
        { id: `opt_1_${idx}`, text: 'Option A', votes: 0, isCorrect: false },
        { id: `opt_2_${idx}`, text: 'Option B', votes: 0, isCorrect: false },
        { id: `opt_3_${idx}`, text: 'Option C', votes: 0, isCorrect: false }
      ];
    } else {
      slide.options.forEach((o, oIdx) => {
        if (!o.id) o.id = `opt_${oIdx + 1}_${Date.now()}`;
        if (typeof o.votes !== 'number') o.votes = Number(o.votes) || 0;
        if (typeof o.isCorrect !== 'boolean') o.isCorrect = false;
      });
    }

    if (!Array.isArray(slide.items) || (slide.type === 'RANKING' && slide.items.length === 0)) {
      slide.items = [
        { id: `item_1_${idx}`, text: 'Speed & Performance' },
        { id: `item_2_${idx}`, text: 'Ease of Use (UI/UX)' },
        { id: `item_3_${idx}`, text: 'New Features' }
      ];
    } else {
      slide.items.forEach((it, iIdx) => {
        if (!it.id) it.id = `item_${iIdx + 1}_${Date.now()}`;
      });
    }
  });
}

// Strip secret hostToken when broadcasting to general socket room
function getPublicSessionView(sessionObj) {
  if (!sessionObj) return null;
  const copy = { ...sessionObj };
  delete copy.hostToken;
  return copy;
}

// Verify Host Token when provided
function verifyHostAuth(session, req) {
  const token = req.headers['x-host-token'] || req.body?.hostToken || req.query?.key;
  if (!token) return true;
  return token === session.hostToken;
}

function loadAllSessionsFromDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
    files.forEach((file) => {
      const fullPath = path.join(DATA_DIR, file);
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((s) => {
          if (s && s.pin) {
            ensureSlideDefaults(s);
            sessions.set(s.pin, s);
            saveSessionToIndividualFile(s);
          }
        });
        if (file === 'sessions.json') fs.unlinkSync(fullPath);
      } else if (parsed && parsed.pin) {
        ensureSlideDefaults(parsed);
        sessions.set(parsed.pin, parsed);
      }
    });
    console.log(`💾 Restored ${sessions.size} separate session file(s) from /data folder`);
  } catch (err) {
    console.error('Error loading session files from disk:', err.message);
  }
}

async function persistSession(sessionObj, immediate = false) {
  ensureSlideDefaults(sessionObj);
  const pin = sessionObj.pin;

  if (immediate) {
    saveSessionToIndividualFile(sessionObj);
    if (isMongoConnected) {
      try {
        await SessionModel.findOneAndUpdate({ pin }, sessionObj, { upsert: true, returnDocument: 'after' });
      } catch (err) {
        console.error(`MongoDB sync error for session ${pin}:`, err.message);
      }
    }
    return;
  }

  if (saveBuffers.has(pin)) return;
  const timeoutId = setTimeout(async () => {
    saveBuffers.delete(pin);
    saveSessionToIndividualFile(sessionObj);
    if (isMongoConnected) {
      try {
        await SessionModel.findOneAndUpdate({ pin }, sessionObj, { upsert: true, returnDocument: 'after' });
      } catch (err) {
        console.error(`MongoDB sync error for session ${pin}:`, err.message);
      }
    }
  }, 250);
  saveBuffers.set(pin, timeoutId);
}

function scheduleSessionBroadcast(pin, immediate = false) {
  const session = sessions.get(pin);
  if (!session) return;

  if (immediate) {
    if (broadcastBuffers.has(pin)) {
      clearTimeout(broadcastBuffers.get(pin));
      broadcastBuffers.delete(pin);
    }
    io.to(pin).emit('session_update', getPublicSessionView(session));
    return;
  }

  if (broadcastBuffers.has(pin)) return;
  const timeoutId = setTimeout(() => {
    broadcastBuffers.delete(pin);
    const latest = sessions.get(pin);
    if (latest) io.to(pin).emit('session_update', getPublicSessionView(latest));
  }, 100);
  broadcastBuffers.set(pin, timeoutId);
}

function broadcastRoomCount(pin) {
  const room = io.sockets.adapter.rooms.get(pin);
  const count = room ? room.size : 0;
  io.to(pin).emit('room_count', count);
}

loadAllSessionsFromDisk();

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  .then(async () => {
    isMongoConnected = true;
    console.log('✅ Connected to MongoDB Non-Volatile Storage');
    const savedSessions = await SessionModel.find({}).lean();
    savedSessions.forEach((s) => {
      delete s._id;
      delete s.__v;
      ensureSlideDefaults(s);
      sessions.set(s.pin, s);
      saveSessionToIndividualFile(s);
    });
  })
  .catch(() => {
    isMongoConnected = false;
    console.log('ℹ️  Running on Per-Session File Storage (/data/*.json)');
  });

function generatePin() {
  let pin;
  do {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
  } while (sessions.has(pin));
  return pin;
}

// 1. Create New Presentation
app.post('/api/sessions', async (req, res) => {
  const { title } = req.body;
  const pin = generatePin();
  const hostToken = crypto.randomBytes(12).toString('hex');
  const session = {
    pin,
    hostToken,
    title: sanitizeInput(title || 'Untitled Presentation', 80),
    status: 'DRAFT',
    allowMultipleVotes: false,
    pacingMode: 'SELF',
    hideResults: false,
    timerEndsAt: null,
    timerDuration: 0,
    currentSlideIndex: 0,
    createdAt: new Date().toISOString(),
    slides: [
      {
        id: `slide_1_${Date.now()}`,
        type: 'RATING_SLIDER',
        question: 'How would you rate our product roadmap?',
        minLabel: '1 = Bad',
        maxLabel: '5 = Good',
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        responses: [],
        words: [],
        options: [],
        items: [],
        questions: []
      },
      {
        id: `slide_2_${Date.now() + 1}`,
        type: 'WORD_CLOUD',
        question: 'What one word describes our biggest priority right now?',
        minLabel: '1 = Bad',
        maxLabel: '5 = Good',
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        responses: [],
        words: [],
        options: [],
        items: [],
        questions: []
      }
    ]
  };
  ensureSlideDefaults(session);
  sessions.set(pin, session);
  await persistSession(session, true);
  res.status(201).json({ success: true, session });
});

// 2. Fetch All Presentations (Host Hub)
app.get('/api/sessions', (req, res) => res.json(Array.from(sessions.values())));

// 3. Update Slides / Options / Items / Current Index
app.put('/api/sessions/:pin/slide', async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const session = sessions.get(pin);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!verifyHostAuth(session, req)) return res.status(403).json({ error: 'Unauthorized host token.' });

  const { title, currentSlideIndex, slides } = req.body;
  if (title) session.title = sanitizeInput(title, 80);

  if (Array.isArray(slides)) {
    slides.forEach((incomingSlide) => {
      const existing = session.slides.find((s) => s.id === incomingSlide.id);
      if (existing) {
        incomingSlide.responses = existing.responses || [];
        incomingSlide.words = existing.words || [];
        incomingSlide.questions = existing.questions || [];
        incomingSlide.distribution = existing.distribution || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        if (Array.isArray(incomingSlide.options) && Array.isArray(existing.options)) {
          incomingSlide.options.forEach((opt) => {
            const oldOpt = existing.options.find((o) => o.id === opt.id);
            if (oldOpt && typeof oldOpt.votes === 'number') {
              opt.votes = oldOpt.votes;
            }
          });
        }
      }
    });
    session.slides = slides;
    ensureSlideDefaults(session);
  }

  if (typeof currentSlideIndex === 'number') {
    const maxIdx = Math.max(0, session.slides.length - 1);
    session.currentSlideIndex = Math.min(Math.max(0, currentSlideIndex), maxIdx);
  }

  await persistSession(session, true);
  scheduleSessionBroadcast(session.pin, true);
  res.json({ success: true, session });
});

// 4. Update Session Status
app.post('/api/sessions/:pin/status', async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const session = sessions.get(pin);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!verifyHostAuth(session, req)) return res.status(403).json({ error: 'Unauthorized host token.' });

  const { status } = req.body;
  if (['DRAFT', 'LIVE', 'PAUSED', 'CLOSED'].includes(status)) {
    session.status = status;
    if (status !== 'LIVE') {
      session.timerEndsAt = null;
      session.timerDuration = 0;
      if (activeTimers.has(session.pin)) {
        clearTimeout(activeTimers.get(session.pin));
        activeTimers.delete(session.pin);
      }
    }
    await persistSession(session, true);
    scheduleSessionBroadcast(session.pin, true);
    res.json({ success: true, status });
  } else {
    res.status(400).json({ error: 'Invalid status' });
  }
});

// 5. Toggle Multiple Votes
app.post('/api/sessions/:pin/multi-vote', async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const session = sessions.get(pin);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!verifyHostAuth(session, req)) return res.status(403).json({ error: 'Unauthorized host token.' });

  session.allowMultipleVotes = !session.allowMultipleVotes;
  await persistSession(session, true);
  scheduleSessionBroadcast(session.pin, true);
  res.json({ success: true, allowMultipleVotes: session.allowMultipleVotes });
});

// 6. Update Stage Settings (Hide/Reveal & Pacing)
app.post('/api/sessions/:pin/settings', async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const session = sessions.get(pin);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!verifyHostAuth(session, req)) return res.status(403).json({ error: 'Unauthorized host token.' });

  const { hideResults, pacingMode } = req.body;
  if (typeof hideResults === 'boolean') session.hideResults = hideResults;
  if (pacingMode === 'SELF' || pacingMode === 'HOST') session.pacingMode = pacingMode;

  await persistSession(session, true);
  scheduleSessionBroadcast(session.pin, true);
  res.json({ success: true, session });
});

// 7. Start or Stop Live Countdown Timer
app.post('/api/sessions/:pin/timer', async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const session = sessions.get(pin);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!verifyHostAuth(session, req)) return res.status(403).json({ error: 'Unauthorized host token.' });

  const seconds = Number(req.body.seconds) || 0;
  if (activeTimers.has(session.pin)) {
    clearTimeout(activeTimers.get(session.pin));
    activeTimers.delete(session.pin);
  }

  if (seconds > 0) {
    session.status = 'LIVE';
    session.timerDuration = seconds;
    session.timerEndsAt = Date.now() + seconds * 1000;

    const tid = setTimeout(async () => {
      activeTimers.delete(session.pin);
      const current = sessions.get(session.pin);
      if (current && current.status === 'LIVE') {
        current.status = 'PAUSED';
        current.timerEndsAt = null;
        current.timerDuration = 0;
        await persistSession(current, true);
        scheduleSessionBroadcast(current.pin, true);
      }
    }, seconds * 1000);

    activeTimers.set(session.pin, tid);
  } else {
    session.timerEndsAt = null;
    session.timerDuration = 0;
  }

  await persistSession(session, true);
  scheduleSessionBroadcast(session.pin, true);
  res.json({ success: true, timerEndsAt: session.timerEndsAt, timerDuration: session.timerDuration });
});

// 8. Stage Moderation
app.delete('/api/sessions/:pin/moderate', async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const session = sessions.get(pin);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!verifyHostAuth(session, req)) return res.status(403).json({ error: 'Unauthorized host token.' });

  const { slideId, itemType, itemId } = req.body;
  const slide = session.slides.find((s) => s.id === slideId) || session.slides[session.currentSlideIndex];
  if (!slide) return res.status(404).json({ error: 'Slide not found.' });

  if (itemType === 'QA' && Array.isArray(slide.questions)) {
    slide.questions = slide.questions.filter((q) => q.id !== itemId);
  } else if (itemType === 'OPEN_ENDED' && Array.isArray(slide.responses)) {
    slide.responses = slide.responses.filter((r) => r.id !== itemId);
  } else if (itemType === 'SUGGESTION' && Array.isArray(slide.responses)) {
    const target = slide.responses.find((r) => r.id === itemId);
    if (target) target.suggestion = '';
  }

  await persistSession(session, true);
  scheduleSessionBroadcast(session.pin, true);
  res.json({ success: true });
});

// 9. DELETE Presentation & All Associated Data Permanently
app.delete('/api/sessions/:pin', async (req, res) => {
  try {
    const pin = String(req.params.pin || '').trim();
    if (!pin) {
      return res.status(400).json({ error: 'PIN parameter is required.' });
    }

    if (activeTimers.has(pin)) {
      clearTimeout(activeTimers.get(pin));
      activeTimers.delete(pin);
    }
    if (broadcastBuffers.has(pin)) {
      clearTimeout(broadcastBuffers.get(pin));
      broadcastBuffers.delete(pin);
    }
    if (saveBuffers.has(pin)) {
      clearTimeout(saveBuffers.get(pin));
      saveBuffers.delete(pin);
    }

    try {
      if (fs.existsSync(DATA_DIR)) {
        const existingFiles = fs.readdirSync(DATA_DIR);
        existingFiles.forEach((file) => {
          if (file.endsWith(`_${pin}.json`)) {
            try {
              fs.unlinkSync(path.join(DATA_DIR, file));
            } catch (unlinkErr) {
              console.error(`Error deleting file ${file}:`, unlinkErr.message);
            }
          }
        });
      }
    } catch (fsErr) {
      console.error(`File deletion error for session ${pin}:`, fsErr.message);
    }

    if (isMongoConnected) {
      try {
        await SessionModel.deleteOne({ pin });
      } catch (dbErr) {
        console.error(`MongoDB deletion error for session ${pin}:`, dbErr.message);
      }
    }

    sessions.delete(pin);
    io.to(pin).emit('error_msg', 'This presentation has been deleted by the host.');

    console.log(`🗑️ Successfully deleted session #${pin} and all associated data.`);
    return res.status(200).json({ success: true, message: 'Presentation deleted successfully.' });
  } catch (error) {
    console.error('Server error during DELETE /api/sessions/:pin:', error);
    return res.status(500).json({ error: 'Internal server error while deleting presentation.' });
  }
});

// 10. Export CSV Report
// Analytics for the host dashboard. Unlike verifyHostAuth, this REQUIRES a
// valid host token: the data is aggregated and anonymised, but it is still
// host-only, and a missing token should not grant access here.
app.get('/api/sessions/:pin/analytics', (req, res) => {
  const session = sessions.get(String(req.params.pin || '').trim());
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const token = req.headers['x-host-token'] || req.query?.key;
  if (!token || token !== session.hostToken) {
    return res.status(403).json({ error: 'Host token required' });
  }
  res.json(computeAnalytics(session));
});

app.get('/api/sessions/:pin/export-csv', (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const session = sessions.get(pin);
  if (!session) return res.status(404).send('Session not found');

  const escapeCSV = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
  const csvRows = [
    [`PraJniX Labs Session Report - ${session.title}`],
    ['Session PIN', session.pin],
    ['Pacing Mode', session.pacingMode || 'SELF'],
    ['Multiple Votes Allowed', session.allowMultipleVotes ? 'Yes' : 'No'],
    ['Exported At', new Date().toISOString()],
    []
  ];

  session.slides.forEach((slide, idx) => {
    csvRows.push([`--- SLIDE ${idx + 1} (${slide.type}) ---`]);
    csvRows.push(['Question', escapeCSV(slide.question)]);

    if (slide.type === 'RATING_SLIDER') {
      const total = slide.responses.length;
      const sum = slide.responses.reduce((acc, r) => acc + (Number(r.rating) || 0), 0);
      const avg = total > 0 ? (sum / total).toFixed(2) : '0.00';
      csvRows.push(['Total Votes', total], ['Average Rating', avg], []);
      csvRows.push(['Rating', 'Meaning', 'Vote Count', 'Percentage']);
      for (let s = 1; s <= 5; s++) {
        const c = (slide.distribution && slide.distribution[s]) || 0;
        const p = total > 0 ? ((c / total) * 100).toFixed(2) : '0.00';
        csvRows.push([s, s === 1 ? 'Bad' : s === 5 ? 'Good' : `Score ${s}`, c, `${p}%`]);
      }
      csvRows.push([], ['Vote #', 'Rating (1-5)', 'Suggestion', 'Voter Name', 'Voter ID', 'Timestamp']);
      slide.responses.forEach((r, i) => {
        csvRows.push([i + 1, r.rating, escapeCSV(r.suggestion), escapeCSV(r.voterName || 'Anonymous'), r.voterId, r.timestamp]);
      });
    } else if (slide.type === 'WORD_CLOUD') {
      csvRows.push(['Total Words', slide.words.length], []);
      csvRows.push(['Word #', 'Submitted Word', 'Voter ID', 'Timestamp']);
      slide.words.forEach((w, i) => {
        csvRows.push([i + 1, escapeCSV(w.word), w.voterId, w.timestamp]);
      });
    } else if (slide.type === 'MULTIPLE_CHOICE') {
      csvRows.push(['Option', 'Votes', 'Correct Answer']);
      (slide.options || []).forEach((o) => csvRows.push([escapeCSV(o.text), o.votes || 0, o.isCorrect ? 'YES' : 'NO']));
    } else if (slide.type === 'OPEN_ENDED') {
      csvRows.push(['Response #', 'Answer Text', 'Voter Name', 'Voter ID', 'Timestamp']);
      (slide.responses || []).forEach((r, i) => {
        csvRows.push([i + 1, escapeCSV(r.text), escapeCSV(r.voterName || 'Anonymous'), r.voterId, r.timestamp]);
      });
    } else if (slide.type === 'RANKING') {
      csvRows.push(['Total Ranking Submissions', (slide.responses || []).length]);
      csvRows.push(['Submission #', 'Ranked Order (1st to Last)', 'Voter ID', 'Timestamp']);
      (slide.responses || []).forEach((r, i) => {
        const orderedNames = (r.ranking || []).map((id, pos) => {
          const found = (slide.items || []).find((it) => it.id === id);
          return `${pos + 1}. ${found ? found.text : id}`;
        }).join(' | ');
        csvRows.push([i + 1, escapeCSV(orderedNames), r.voterId, r.timestamp]);
      });
    } else if (slide.type === 'QA') {
      csvRows.push(['Question #', 'Question Text', 'Upvotes', 'Voter Name', 'Voter ID', 'Timestamp']);
      (slide.questions || []).forEach((q, i) => {
        csvRows.push([i + 1, escapeCSV(q.text), q.upvotes || 0, escapeCSV(q.voterName || 'Anonymous'), q.voterId, q.timestamp]);
      });
    }
    csvRows.push([], []);
  });

  const safeTitle = (session.title || 'Session').replace(/[^a-zA-Z0-9_-]/g, '_');
  const csvString = csvRows.map((r) => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_${session.pin}_Report.csv"`);
  res.status(200).send(csvString);
});

function resolveTargetSlide(session, { slideId, slideIndex, slideType }) {
  if (!session || !Array.isArray(session.slides)) return null;
  let slide = session.slides.find((s) => s.id === slideId);
  if (!slide && typeof slideIndex === 'number' && session.slides[slideIndex]) {
    slide = session.slides[slideIndex];
  }
  if (!slide && slideType) {
    slide = session.slides.find((s) => s.type === slideType);
  }
  if (!slide) {
    slide = session.slides[session.currentSlideIndex];
  }
  return slide;
}

// Socket.io Real-Time Engine
io.on('connection', (socket) => {
  socket.on('join_session', (payload) => {
    const cleanPin = typeof payload === 'object' ? String(payload.pin || '').trim() : String(payload || '').trim();
    const isHostClient = typeof payload === 'object' && Boolean(payload.isHost);
    const session = sessions.get(cleanPin);
    if (session) {
      socket.data.pin = cleanPin;
      socket.join(cleanPin);
      socket.emit('session_update', isHostClient ? session : getPublicSessionView(session));
      broadcastRoomCount(cleanPin);
    } else {
      socket.emit('error_msg', 'Invalid Session PIN.');
    }
  });

  socket.on('disconnect', () => {
    socketRateLimits.delete(socket.id);
    if (socket.data && socket.data.pin) {
      broadcastRoomCount(socket.data.pin);
    }
  });

  socket.on('send_reaction', ({ pin, emoji }) => {
    if (isRateLimited(socket.id, 300)) return;
    const allowed = ['❤️', '🔥', '👏', '😂', '🚀', '🎉'];
    if (pin && allowed.includes(emoji)) {
      io.to(pin).emit('live_reaction', {
        emoji,
        id: `re_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
      });
    }
  });

  socket.on('trigger_confetti', ({ pin }) => {
    if (pin) io.to(pin).emit('celebrate_confetti');
  });

  socket.on('submit_response', async (payload) => {
    if (isRateLimited(socket.id, 250)) return;

    const {
      pin,
      slideId,
      slideIndex,
      slideType,
      rating,
      suggestion,
      word,
      optionId,
      text,
      ranking,
      advanceAfterQa,
      voterName,
      voterAvatar,
      voterId
    } = payload || {};

    const cleanPin = String(pin || '').trim();
    const session = sessions.get(cleanPin);
    if (!session) return;

    if (session.status !== 'LIVE') {
      const msg = session.status === 'CLOSED'
        ? 'Voting has been closed by the host.'
        : 'Voting is currently paused by the host.';
      socket.emit('vote_error', msg);
      return;
    }

    const slide = resolveTargetSlide(session, { slideId, slideIndex, slideType });
    if (!slide) return;

    const cleanVoterId = sanitizeInput(voterId || `v_${socket.id.slice(0, 6)}`, 40);
    const cleanName = sanitizeInput(voterName || 'Anonymous', 25);
    const cleanAvatar = sanitizeInput(voterAvatar || '👤', 8);

    // 1. RATING SLIDER
    if (slide.type === 'RATING_SLIDER') {
      const num = Number(rating);
      if (num < 1 || num > 5) return;
      if (!session.allowMultipleVotes && slide.responses.some((r) => r.voterId === cleanVoterId)) {
        socket.emit('vote_error', 'You have already submitted a rating for this question.');
        return;
      }
      if (!slide.distribution) slide.distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      slide.distribution[num] = (slide.distribution[num] || 0) + 1;
      slide.responses.push({
        id: `rs_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        voterId: cleanVoterId,
        voterName: cleanName,
        voterAvatar: cleanAvatar,
        rating: num,
        suggestion: sanitizeInput(suggestion || '', 200),
        timestamp: new Date().toISOString()
      });

      persistSession(session);
      socket.emit('vote_success', { slideId: slide.id, slideType: slide.type, summary: `Rated ${num}/5`, allowMultipleVotes: session.allowMultipleVotes });
      scheduleSessionBroadcast(cleanPin);
    }

    // 2. WORD CLOUD
    else if (slide.type === 'WORD_CLOUD') {
      const cleanWord = sanitizeInput(word || '', 30);
      if (!cleanWord) return;
      if (!session.allowMultipleVotes && slide.words.some((w) => w.voterId === cleanVoterId)) {
        socket.emit('vote_error', 'You have already submitted a word for this question.');
        return;
      }
      slide.words.push({
        id: `wc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        voterId: cleanVoterId,
        word: cleanWord,
        timestamp: new Date().toISOString()
      });

      persistSession(session);
      socket.emit('vote_success', { slideId: slide.id, slideType: slide.type, summary: `Word: "${cleanWord}"`, allowMultipleVotes: session.allowMultipleVotes });
      scheduleSessionBroadcast(cleanPin);
    }

    // 3. MULTIPLE CHOICE (With Quiz Scoring!)
    else if (slide.type === 'MULTIPLE_CHOICE') {
      if (!Array.isArray(slide.options)) slide.options = [];
      const option = slide.options.find((o) => o.id === optionId);
      if (!option) return;

      if (!session.allowMultipleVotes && slide.responses.some((r) => r.voterId === cleanVoterId)) {
        socket.emit('vote_error', 'You have already voted on this poll.');
        return;
      }
      option.votes = (Number(option.votes) || 0) + 1;
      const earnedPoints = option.isCorrect ? 100 : 0;

      slide.responses.push({
        id: `mc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        voterId: cleanVoterId,
        voterName: cleanName,
        voterAvatar: cleanAvatar,
        optionId: option.id,
        optionText: option.text,
        isCorrect: Boolean(option.isCorrect),
        points: earnedPoints,
        timestamp: new Date().toISOString()
      });

      persistSession(session);
      socket.emit('vote_success', { slideId: slide.id, slideType: slide.type, summary: `Picked: ${option.text}`, allowMultipleVotes: session.allowMultipleVotes });
      scheduleSessionBroadcast(cleanPin);
    }

    // 4. OPEN ENDED
    else if (slide.type === 'OPEN_ENDED') {
      const cleanText = sanitizeInput(text || '', 280);
      if (!cleanText) {
        socket.emit('vote_error', 'Please enter your response before submitting.');
        return;
      }

      if (!Array.isArray(slide.responses)) slide.responses = [];
      if (!session.allowMultipleVotes && slide.responses.some((r) => r.voterId === cleanVoterId)) {
        socket.emit('vote_error', 'You have already submitted a response for this question.');
        return;
      }

      slide.responses.push({
        id: `oe_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        voterId: cleanVoterId,
        voterName: cleanName,
        voterAvatar: cleanAvatar,
        text: cleanText,
        timestamp: new Date().toISOString()
      });

      persistSession(session);
      socket.emit('vote_success', { slideId: slide.id, slideType: slide.type, summary: `Submitted response`, allowMultipleVotes: session.allowMultipleVotes });
      scheduleSessionBroadcast(cleanPin);
    }

    // 5. RANKING POLL
    else if (slide.type === 'RANKING') {
      const submittedRanking = Array.isArray(ranking) && ranking.length > 0
        ? ranking
        : (slide.items || []).map((it) => it.id);

      if (submittedRanking.length === 0) return;

      if (!Array.isArray(slide.responses)) slide.responses = [];
      if (!session.allowMultipleVotes && slide.responses.some((r) => r.voterId === cleanVoterId)) {
        socket.emit('vote_error', 'You have already submitted your ranking.');
        return;
      }

      slide.responses.push({
        id: `rk_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        voterId: cleanVoterId,
        voterName: cleanName,
        voterAvatar: cleanAvatar,
        ranking: submittedRanking,
        timestamp: new Date().toISOString()
      });

      persistSession(session);
      socket.emit('vote_success', { slideId: slide.id, slideType: slide.type, summary: `Submitted priority ranking`, allowMultipleVotes: session.allowMultipleVotes });
      scheduleSessionBroadcast(cleanPin);
    }

    // 6. LIVE Q&A BOARD
    else if (slide.type === 'QA') {
      const cleanQ = sanitizeInput(text || '', 250);
      if (cleanQ) {
        if (!Array.isArray(slide.questions)) slide.questions = [];
        const qItem = {
          id: `q_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          voterId: cleanVoterId,
          voterName: cleanName,
          voterAvatar: cleanAvatar,
          text: cleanQ,
          upvotes: 1,
          upvotedBy: [cleanVoterId],
          timestamp: new Date().toISOString()
        };
        slide.questions.push(qItem);
        persistSession(session);
        scheduleSessionBroadcast(cleanPin);

        if (advanceAfterQa) {
          socket.emit('vote_success', { slideId: slide.id, slideType: slide.type, summary: `Asked Q&A question`, allowMultipleVotes: true });
        } else {
          socket.emit('qa_submitted', { slideId: slide.id, question: qItem });
        }
      } else if (advanceAfterQa) {
        socket.emit('vote_success', { slideId: slide.id, slideType: slide.type, allowMultipleVotes: true });
      }
    }
  });

  // Upvote Q&A Question
  socket.on('upvote_qa', async ({ pin, slideId, slideIndex, questionId, voterId }) => {
    if (isRateLimited(socket.id, 200)) return;
    const cleanPin = String(pin || '').trim();
    const session = sessions.get(cleanPin);
    if (!session) return;
    const slide = resolveTargetSlide(session, { slideId, slideIndex, slideType: 'QA' });
    if (!slide || slide.type !== 'QA' || !Array.isArray(slide.questions)) return;

    const q = slide.questions.find((item) => item.id === questionId);
    if (!q) return;
    if (!Array.isArray(q.upvotedBy)) q.upvotedBy = [];

    const idx = q.upvotedBy.indexOf(voterId);
    if (idx > -1) {
      q.upvotedBy.splice(idx, 1);
      q.upvotes = Math.max(0, (q.upvotes || 1) - 1);
    } else {
      q.upvotedBy.push(voterId);
      q.upvotes = (q.upvotes || 0) + 1;
    }

    persistSession(session);
    scheduleSessionBroadcast(cleanPin);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🖥️  PraJniX Host Hub: http://localhost:${PORT}`);
  console.log(`📱 Voter Portal:     http://localhost:${PORT}/vote`);
  console.log(`🎮 Presenter Remote: http://localhost:${PORT}/remote`);
});