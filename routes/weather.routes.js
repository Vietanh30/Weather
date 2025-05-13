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
  getSevenDayForecast,
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
  const { location, lat, lon } = req.query;

  // Kiểm tra nếu có lat thì phải có lon và ngược lại
  if ((lat && !lon) || (!lat && lon)) {
    return res.status(400).json({
      error: "Invalid coordinates",
      message: "Cần cung cấp cả latitude và longitude.",
    });
  }

  // Nếu không có location name thì phải có lat,lon
  if (!location && (!lat || !lon)) {
    return res.status(400).json({
      error: "Location is required",
      message: "Vui lòng cung cấp địa điểm (tên) hoặc tọa độ (lat,lon).",
    });
  }

  // Validate lat,lon nếu có
  if (lat && lon) {
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);

    if (isNaN(latNum) || isNaN(lonNum)) {
      return res.status(400).json({
        error: "Invalid coordinates",
        message: "Latitude và longitude phải là số.",
      });
    }

    if (latNum < -90 || latNum > 90) {
      return res.status(400).json({
        error: "Invalid latitude",
        message: "Latitude phải nằm trong khoảng -90 đến 90.",
      });
    }

    if (lonNum < -180 || lonNum > 180) {
      return res.status(400).json({
        error: "Invalid longitude",
        message: "Longitude phải nằm trong khoảng -180 đến 180.",
      });
    }
  }

  next();
};

// Weather routes
router.get("/weather/current", validateQuery, getCurrentWeather);
router.get("/weather/forecast", validateQuery, getForecast);
router.get("/weather/forecast/7days", validateQuery, getSevenDayForecast);
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
