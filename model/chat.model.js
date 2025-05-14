const mongoose = require("mongoose");

/**
 * Schema cho lịch sử chat
 * @typedef {Object} Chat
 * @property {string} question - Câu hỏi của người dùng
 * @property {string} answer - Câu trả lời từ hệ thống
 * @property {Object} weatherData - Dữ liệu thời tiết liên quan (nếu có)
 * @property {Date} timestamp - Thời gian chat
 * @property {string} sessionId - ID phiên chat
 * @property {string} location - Địa điểm được hỏi
 * @property {string} date - Ngày thời tiết được hỏi (nếu có)
 * @property {string} type - Loại thông tin thời tiết (current, forecast, history, etc.)
 * @property {Object} analysis - Kết quả phân tích câu hỏi
 */
const chatSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  weatherData: { type: mongoose.Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now },
  sessionId: { type: String, required: true },
  location: { type: String },
  date: { type: String },
  type: {
    type: String,
    enum: [
      "current",
      "forecast",
      "history",
      "future",
      "marine",
      "astronomy",
      "timezone",
      "alerts",
    ],
    default: "current",
  },
  analysis: {
    location: { type: String },
    time: {
      type: {
        type: String,
        enum: ["current", "specific", "range", "hourly", "history"],
      },
      value: { type: mongoose.Schema.Types.Mixed },
      period: { type: String },
      isHistory: { type: Boolean, default: false },
    },
    type: { type: String },
    details: [{ type: String }],
  },
});

// Indexes for better query performance
chatSchema.index({ sessionId: 1, timestamp: -1 });
chatSchema.index({ location: 1, date: 1 });
chatSchema.index({ type: 1 });

const Chat = mongoose.model("Chat", chatSchema);

module.exports = Chat;
