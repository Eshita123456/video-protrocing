// frontend app.js (put as proctoring/frontend/app.js)

// DOM
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const statusBox = document.getElementById('statusBox');
const eventLog = document.getElementById('eventLog');
const scoreBox = document.getElementById('scoreBox');
const badgeArea = document.getElementById('badgeArea');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const uploadBtn = document.getElementById('uploadBtn');
const previewBtn = document.getElementById('previewBtn');
const genReportBtn = document.getElementById('genReportBtn');

// globals
let cocoModel = null;
let faceMesh = null;
let mediaRecorder = null;
let recordedBlobs = [];
let events = [];
let sessionId = null;
let lastEventTimes = {};
let lastFaceSeenAt = Date.now();
let lastLookAwayStart = null;
let lastObjDetectAt = 0;
let _loopRunning = false;

// thresholds
const LOOK_AWAY_MS = 5000;
const NO_FACE_MS = 10000;
const ITEM_DETECT_INTERVAL = 1000;
const ITEM_CONFIDENCE = 0.5;
const DEBOUNCE_MS = 5000;

const targetClasses = ['cell phone', 'book', 'laptop', 'keyboard', 'mouse', 'remote'];

// helpers
function resizeOverlayToVideo() {
  try {
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    overlay.width = w;
    overlay.height = h;
    overlay.style.width = video.offsetWidth + 'px';
    overlay.style.height = video.offsetHeight + 'px';
  } catch (e) { console.warn(e); }
}
video.addEventListener('loadedmetadata', resizeOverlayToVideo);
video.addEventListener('play', () => setTimeout(resizeOverlayToVideo, 200));

function canLog(key) {
  const now = Date.now();
  if (!lastEventTimes[key] || (now - lastEventTimes[key]) > DEBOUNCE_MS) {
    lastEventTimes[key] = now;
    return true;
  }
  return false;
}

function addBadge(text, color = '#f39c12') {
  const b = document.createElement('div');
  b.className = 'badge';
  b.style.background = color;
  b.textContent = text;
  badgeArea.prepend(b);
  setTimeout(() => b.remove(), 4000);
}

function computeIntegrityScore(evts) {
  let score = 100;
  const counts = evts.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
  score -= (counts['looking_away'] || 0) * 2;
  score -= (counts['no_face'] || 0) * 5;
  score -= (counts['multiple_faces'] || 0) * 10;
  score -= (counts['item_detected'] || 0) * 15;
  return Math.max(0, Math.round(score));
}

async function logEvent(evt) {
  events.push(evt);
  const li = document.createElement('li');
  li.textContent = `${new Date(evt.start).toLocaleTimeString()} — ${evt.type} ${evt.details ? JSON.stringify(evt.details) : ''}`;
  eventLog.prepend(li);

  scoreBox.innerText = computeIntegrityScore(events);

  if (sessionId) {
    try {
      await fetch(`/api/session/${sessionId}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evt)
      });
    } catch (e) { console.warn('failed to post event', e); }
  }
}

// models init
async function initModels() {
  try {
    statusBox.innerText = 'Preparing TF...';
    if (typeof tf !== 'undefined') {
      try { await tf.setBackend('cpu'); await tf.ready(); } catch (e) { console.warn('tf backend', e); }
    }

    statusBox.innerText = 'Loading coco-ssd...';
    cocoModel = await cocoSsd.load();
    console.log('coco loaded');

    if (typeof FaceMesh === 'undefined') {
      statusBox.innerText = 'face mesh missing';
      return;
    }
    faceMesh = new FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
    faceMesh.setOptions({ maxNumFaces: 2, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    faceMesh.onResults(onFaceResults);

    statusBox.innerText = 'Models ready';
  } catch (err) {
    console.error(err);
    statusBox.innerText = 'Model load error';
  }
}

// face results
function onFaceResults(results) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.save();
  ctx.scale(overlay.width, overlay.height);

  const faces = results.multiFaceLandmarks || [];
  const now = Date.now();

  if (!faces || faces.length === 0) {
    if ((now - lastFaceSeenAt) > NO_FACE_MS && canLog('no_face')) {
      const evt = { type: 'no_face', start: new Date(lastFaceSeenAt).toISOString(), end: new Date().toISOString(), duration_sec: (now - lastFaceSeenAt) / 1000 };
      logEvent(evt); addBadge('🚫 No face detected', '#e74c3c');
    }
  } else {
    lastFaceSeenAt = now;
    if (faces.length > 1 && canLog('multiple_faces')) {
      logEvent({ type: 'multiple_faces', start: new Date().toISOString(), details: { count: faces.length } });
      addBadge('👥 Multiple faces', '#9b59b6');
    }

    const lm = faces[0];
    ctx.fillStyle = 'rgba(0,255,0,0.6)';
    for (let p of lm) ctx.fillRect(p.x, p.y, 0.007, 0.007);

    const leftEye = lm[33], rightEye = lm[263], nose = lm[1];
    const eyeMidX = (leftEye.x + rightEye.x) / 2;
    const eyeMidY = (leftEye.y + rightEye.y) / 2;
    const dx = eyeMidX - nose.x;
    const dy = eyeMidY - nose.y;

    const lookingAway = Math.abs(dx) > 0.045 || Math.abs(dy) > 0.05;
    if (lookingAway) {
      if (!lastLookAwayStart) lastLookAwayStart = now;
      const duration = now - lastLookAwayStart;
      if (duration > LOOK_AWAY_MS && canLog('looking_away')) {
        logEvent({ type: 'looking_away', start: new Date(lastLookAwayStart).toISOString(), end: new Date().toISOString(), duration_sec: duration / 1000 });
        addBadge('⚠️ Candidate looking away', '#f39c12');
      }
    } else lastLookAwayStart = null;
  }

  ctx.restore();
}

// detection loop
async function loop() {
  if (video.readyState >= 2) {
    resizeOverlayToVideo();
    const now = Date.now();

    if (now - lastObjDetectAt > ITEM_DETECT_INTERVAL && cocoModel) {
      const tmp = document.createElement('canvas');
      tmp.width = video.videoWidth; tmp.height = video.videoHeight;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(video, 0, 0, tmp.width, tmp.height);

      try {
        const preds = await cocoModel.detect(tmp);
        preds.forEach(p => {
          if (targetClasses.includes(p.class) && p.score > ITEM_CONFIDENCE) {
            if (canLog('item_' + p.class)) {
              logEvent({ type: 'item_detected', start: new Date().toISOString(), details: { label: p.class, score: p.score } });
              addBadge(`📱/📖 ${p.class} detected`, '#e67e22');
            }
          }
        });
      } catch (e) { console.warn('coco detect failed', e); }
      lastObjDetectAt = now;
    }

    if (faceMesh) await faceMesh.send({ image: video });
  }
  requestAnimationFrame(loop);
}

// camera & recording (robust)
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    video.srcObject = stream;
    await video.play();
    resizeOverlayToVideo();
    recordedBlobs = [];

    // preferred mime types
    const tryTypes = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    let mime = '';
    try {
      if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
        for (const t of tryTypes) {
          if (MediaRecorder.isTypeSupported(t)) { mime = t; break; }
        }
      }
    } catch (e) { console.warn('mime detect', e); }
    if (!mime) mime = 'video/webm';

    // attempt full stream recorder
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    } catch (err) {
      console.warn('MediaRecorder with mime failed', err);
      // fallback to video-only recorder (drop audio)
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) { statusBox.innerText = 'No video track'; return; }
      const videoOnlyStream = new MediaStream([videoTrack]);
      try {
        mediaRecorder = new MediaRecorder(videoOnlyStream);
      } catch (err2) {
        console.error('MediaRecorder fallback failed', err2);
        statusBox.innerText = 'Recording not supported';
        return;
      }
    }

    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedBlobs.push(e.data); };
    mediaRecorder.onstop = () => {
      try {
        const blob = new Blob(recordedBlobs, { type: recordedBlobs[0]?.type || 'video/webm' });
        const existing = document.getElementById('debugPlayer');
        const url = URL.createObjectURL(blob);
        if (existing) existing.src = url;
        else {
          const p = document.createElement('video');
          p.id = 'debugPlayer'; p.controls = true; p.style.position = 'fixed'; p.style.right = '12px';
          p.style.bottom = '12px'; p.style.width = '320px'; p.style.zIndex = 99999; document.body.appendChild(p);
          p.src = url;
        }
      } catch (e) { console.warn(e); }
    };

    try {
      mediaRecorder.start();
    } catch (errStart) {
      console.warn('mediaRecorder.start() failed', errStart);
      try { mediaRecorder.start(1000); } catch (e) { console.error('start fallback failed', e); statusBox.innerText = 'Recording not supported'; return; }
    }

    statusBox.innerText = 'Recording...';
    if (!_loopRunning) { _loopRunning = true; loop(); }
  } catch (err) {
    console.error('startCamera error', err);
    statusBox.innerText = 'Camera error: ' + (err && err.name ? err.name : err.toString());
  }
}

// buttons
startBtn.onclick = async () => {
  // create session on server
  try {
    const res = await fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateName: 'Test Candidate', startTime: new Date().toISOString() })
    });
    const data = await res.json();
    sessionId = data._id;
    console.log('session created', sessionId);
  } catch (err) { console.warn('session create failed', err); }

  await initModels();
  await startCamera();
  stopBtn.disabled = false;
  startBtn.disabled = true;
};

stopBtn.onclick = async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    statusBox.innerText = 'Stopped';
  }
  uploadBtn.disabled = false;
  stopBtn.disabled = true;
  startBtn.disabled = false;
};

uploadBtn.onclick = async () => {
  if (!sessionId) return alert('No session id');
  if (!recordedBlobs || recordedBlobs.length === 0) return alert('No recording available');

  const blob = new Blob(recordedBlobs, { type: recordedBlobs[0]?.type || 'video/webm' });
  const fd = new FormData(); fd.append('video', blob, 'session.webm');

  try {
    const res = await fetch(`/api/session/${sessionId}/upload`, { method: 'POST', body: fd });
    const j = await res.json();
    alert('Uploaded: ' + (j.session && j.session.videoPath ? j.session.videoPath : 'ok'));
  } catch (err) {
    console.error('upload failed', err);
    alert('Upload failed');
  }
};

previewBtn.onclick = () => {
  const p = document.getElementById('debugPlayer');
  if (!p) return alert('No preview available (record & stop first)');
  p.style.display = 'block'; p.play().catch(() => { });
};

genReportBtn.onclick = () => {
  const score = computeIntegrityScore(events);
  const rows = [['Candidate', 'Test Candidate'], ['Integrity Score', score], []];
  rows.push(['type', 'start', 'end', 'duration_sec', 'details']);
  events.forEach(e => rows.push([e.type, e.start || '', e.end || '', e.duration_sec || '', JSON.stringify(e.details || {})]));
  const csv = rows.map(r => r.map(a => `"${String(a).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'proctor_report.csv'; a.click();
};
