const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema({
  type: { type: String, required: true },
  start: { type: String },
  end: { type: String },
  duration_sec: { type: Number },
  details: { type: mongoose.Schema.Types.Mixed }
}, { _id: false, strict: false });

const SessionSchema = new mongoose.Schema({
  candidateName: { type: String, default: 'Unknown' },
  startTime: { type: String },
  endTime: { type: String },
  events: { type: [EventSchema], default: [] },
  videoPath: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Session', SessionSchema);
