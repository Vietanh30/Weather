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
  getWeatherHistory,
  getWeatherNotifications,
  subscribeToAlerts,
  unsubscribeFromAlerts,
  getWeatherNotificationDetail,
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
  const { location, lat, lon, q, dt, date } = req.query;

  // Chuyển đổi tham số q thành location nếu có
  const finalLocation = q || location;
  // Chuyển đổi tham số dt thành date nếu có
  const finalDate = dt || date;

  // Kiểm tra nếu có lat thì phải có lon và ngược lại
  if ((lat && !lon) || (!lat && lon)) {
    return res.status(400).json({
      error: "Invalid coordinates",
      message: "Cần cung cấp cả latitude và longitude.",
    });
  }

  // Nếu không có location name thì phải có lat,lon
  if (!finalLocation && (!lat || !lon)) {
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

  // Giữ nguyên tất cả các tham số gốc và thêm các tham số mới nếu cần
  if (q && !location) req.query.location = q;
  if (dt && !date) req.query.date = dt;

  next();
};

// Middleware cho route history
const validateHistoryQuery = (req, res, next) => {
  try {
    const { q, dt, location } = req.query;

    // Kiểm tra các tham số bắt buộc
    if (!q && !location) {
      return res.status(400).json({
        error: "Missing required parameter",
        message: "Location parameter (q or location) is required",
      });
    }

    if (!dt) {
      return res.status(400).json({
        error: "Missing required parameter",
        message: "Date parameter (dt) is required",
      });
    }

    // Validate định dạng ngày
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dt)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Date must be in YYYY-MM-DD format",
      });
    }

    // Validate phạm vi ngày
    const requestDate = new Date(dt);
    const minDate = new Date("2010-01-01");

    if (requestDate < minDate) {
      return res.status(400).json({
        error: "Invalid date",
        message: "Date must be from January 1, 2010 onwards",
      });
    }

    // Chuyển đổi tham số để phù hợp với controller
    req.query = {
      ...req.query, // giữ nguyên các tham số gốc (q, dt, lang, aqi)
      location: q || location, // sử dụng q nếu có, nếu không thì dùng location
      date: dt, // thêm date từ dt
    };

    next();
  } catch (error) {
    return res.status(500).json({
      error: "Validation error",
      message: error.message,
    });
  }
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

// New notification routes
router.get("/weather/notifications", validateQuery, getWeatherNotifications);
router.get(
  "/weather/notifications/detail",
  validateQuery,
  getWeatherNotificationDetail
);
router.post(
  "/weather/notifications/subscribe",
  validateQuery,
  subscribeToAlerts
);
router.post(
  "/weather/notifications/unsubscribe",
  validateQuery,
  unsubscribeFromAlerts
);

// History route with its own middleware
router.get("/weather/history", validateHistoryQuery, getWeatherHistory);

// Chat routes
router.post("/chat", handleChat);
router.get("/chat/history", getChatHistory);

// Apply error handling middleware
router.use(errorHandler);

module.exports = router;
