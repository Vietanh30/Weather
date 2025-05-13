const mongoose = require("mongoose");

/**
 * Schema cho lịch sử chat
 * @typedef {Object} Chat
 * @property {string} question - Câu hỏi của người dùng
 * @property {string} answer - Câu trả lời từ hệ thống
 * @property {Object} weatherData - Dữ liệu thời tiết liên quan (nếu có)
 * @property {Date} timestamp - Thời gian chat
 * @property {string} sessionId - ID phiên chat
 */
const chatSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  weatherData: { type: mongoose.Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now },
  sessionId: { type: String, required: true },
});

const Chat = mongoose.model("Chat", chatSchema);

module.exports = Chat;
