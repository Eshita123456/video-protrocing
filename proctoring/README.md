# 🎥 Video Proctoring System

A minimal **video proctoring ** with frontend + backend running together.

---

## 🚀 Features
- 👀 Focus Detection — Detects if candidate is looking away (MediaPipe FaceMesh)  
- 📦 Object Detection — Flags suspicious items like phone, books, laptop (TensorFlow.js coco-ssd)  
- 🎥 Recording — Captures candidate’s video using MediaRecorder API  
- 🖥️ Backend — Node.js + Express + MongoDB for storing sessions, events, and video  
- 📊 Reporting — Integrity score + downloadable CSV report  

---

## ⚙️ Installation & Setup

```bash
# 1. Clone repository
git clone https://github.com/your-username/video-proctoring-system.git
cd video-proctoring-system

# 2. Install dependencies
cd proctoring/server
npm install

# 3. Run the server (serves both frontend + backend)
cd server
npm install
npm run dev

🖥️ Usage

Open http://localhost:5000

📊 Sample Report (CSV)

Candidate,Test Candidate
Integrity Score,85

type,start,end,duration_sec,details
looking_away,10:05:33,10:05:40,7,
item_detected,10:06:12,,,"{ label: 'cell phone' }"

