const mongoose = require('mongoose');
const S = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  type: String,
  start: Date,
  end: Date,
  duration_sec: Number,
  details: mongoose.Schema.Types.Mixed
});
module.exports = mongoose.model('Event', S);
