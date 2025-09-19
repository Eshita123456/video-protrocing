// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Session = require('./models/Session');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(cors());

// --- Uploads directory (robust)
const UPLOAD_DIR = path.resolve(
  // prefer a sibling 'uploads' next to server.js, else fallback to project-root/uploads
  fs.existsSync(path.join(__dirname, 'uploads')) ? path.join(__dirname, 'uploads') : path.join(process.cwd(), 'uploads')
);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer storage (filename sanitized)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = (file.originalname || 'upload')
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_.-]/g, '');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// --- MongoDB connection
const MONGO = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/proctoring';
if (!process.env.MONGO_URI) {
  console.warn('⚠️  MONGO_URI not provided — using local MongoDB fallback:', MONGO);
}
mongoose
  .connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e => console.error('❌ Mongo connection error', e.message || e));

// --- Frontend static serving: try a few likely locations
let FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend'); // if server/ is nested
if (!fs.existsSync(FRONTEND_DIR)) {
  const alt = path.resolve(__dirname, 'frontend'); // if server.js is at project root
  if (fs.existsSync(alt)) FRONTEND_DIR = alt;
  else {
    const cwdFront = path.resolve(process.cwd(), 'frontend'); // last fallback
    if (fs.existsSync(cwdFront)) FRONTEND_DIR = cwdFront;
    else FRONTEND_DIR = null;
  }
}

if (FRONTEND_DIR) {
  app.use(express.static(FRONTEND_DIR));
  console.log('📁 Serving frontend from', FRONTEND_DIR);
} else {
  console.warn('⚠️ Frontend folder not found (tried multiple locations). SPA routes will 404 if no index.html present.');
}

app.use('/uploads', express.static(UPLOAD_DIR));

// --- Routes
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/session', async (req, res) => {
  try {
    const { candidateName, startTime } = req.body || {};
    const s = await Session.create({
      candidateName: candidateName || 'Candidate',
      startTime: startTime || new Date().toISOString()
    });
    res.json(s);
  } catch (err) {
    console.error('create session err', err);
    res.status(500).json({ error: 'create failed' });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const list = await Session.find().sort({ createdAt: -1 }).limit(200);
    res.json(list);
  } catch (err) {
    console.error('list sessions err', err);
    res.status(500).json({ error: 'list failed' });
  }
});

app.post('/api/session/:id/events', async (req, res) => {
  try {
    const { id } = req.params;
    const evt = req.body;
    if (!evt || !evt.type) return res.status(400).json({ error: 'invalid event' });
    const s = await Session.findById(id);
    if (!s) return res.status(404).json({ error: 'session not found' });
    s.events.push(evt);
    s.endTime = new Date().toISOString();
    await s.save();
    res.json({ ok: true, session: s });
  } catch (err) {
    console.error('post event err', err);
    res.status(500).json({ error: 'post failed' });
  }
});

app.post('/api/session/:id/upload', upload.single('video'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const s = await Session.findById(id);
    if (!s) return res.status(404).json({ error: 'session not found' });
    // store relative path for portability
    s.videoPath = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
    s.endTime = new Date().toISOString();
    await s.save();
    res.json({ ok: true, session: s });
  } catch (err) {
    console.error('upload err', err);
    res.status(500).json({ error: 'upload failed' });
  }
});

app.get('/api/session/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const s = await Session.findById(id).lean();
    if (!s) return res.status(404).json({ error: 'session not found' });
    const counts = (s.events || []).reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {});
    let score = 100;
    score -= (counts['looking_away'] || 0) * 2;
    score -= (counts['no_face'] || 0) * 5;
    score -= (counts['multiple_faces'] || 0) * 10;
    score -= (counts['item_detected'] || 0) * 15;
    score = Math.max(0, Math.round(score));
    res.json({ session: s, integrityScore: score });
  } catch (err) {
    console.error('report err', err);
    res.status(500).json({ error: 'report failed' });
  }
});

app.delete('/api/session/:id', async (req, res) => {
  try {
    await Session.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete session err', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

// Serve SPA index.html for non-API routes (if present)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  if (FRONTEND_DIR) {
    const indexPath = path.join(FRONTEND_DIR, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  }
  return res.status(404).send('Not Found');
});

// --- Start server (Railway-friendly)
const PORT = Number(process.env.PORT || 5000);
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} (host: ${process.env.HOST || '0.0.0.0'})`);
});

// graceful shutdown handlers
process.on('unhandledRejection', err => {
  console.error('Unhandled Rejection', err);
  server.close(() => process.exit(1));
});
process.on('uncaughtException', err => {
  console.error('Uncaught Exception', err);
  server.close(() => process.exit(1));
});
