const express = require("express");
const router = express.Router();
const {
  getCurrentWeather,
  getForecast,
  getFutureWeather,
  getMarineWeather,
  getAstronomy,
  getTimeZone,
  getWeatherAlerts,
} = require("../controllers/weather.controller");
const {
  handleChat,
  getChatHistory,
} = require("../controllers/chat.controller");

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message,
    message: "Có lỗi xảy ra khi xử lý yêu cầu.",
  });
};

// Input validation middleware
const validateQuery = (req, res, next) => {
  const { location } = req.query;
  if (!location) {
    return res.status(400).json({
      error: "Location is required",
      message: "Vui lòng cung cấp địa điểm.",
    });
  }
  next();
};

// Weather routes
router.get("/weather/current", validateQuery, getCurrentWeather);
router.get("/weather/forecast", validateQuery, getForecast);
router.get("/weather/future", validateQuery, getFutureWeather);
router.get("/weather/marine", validateQuery, getMarineWeather);
router.get("/weather/astronomy", validateQuery, getAstronomy);
router.get("/weather/timezone", validateQuery, getTimeZone);
router.get("/weather/alerts", validateQuery, getWeatherAlerts);

// Chat routes
router.post("/chat", handleChat);
router.get("/chat/history", getChatHistory);

// Apply error handling middleware
router.use(errorHandler);

module.exports = router;
