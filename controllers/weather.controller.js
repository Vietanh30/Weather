const axios = require("axios");
const {
  Weather,
  Astronomy,
  Marine,
  AirQuality,
  History,
} = require("../model/weather.model");
require("dotenv").config();

// Constants
const API_KEY = process.env.WEATHERAPI_KEY;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const DEFAULT_LANG = "vi";
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY;

if (!API_KEY) {
  throw new Error("WEATHERAPI_KEY is not defined in environment variables");
}

// WeatherAPI.com API Endpoints
const WEATHER_API_BASE = "http://api.weatherapi.com/v1";
const API_ENDPOINTS = {
  current: `${WEATHER_API_BASE}/current.json`,
  forecast: `${WEATHER_API_BASE}/forecast.json`,
  future: `${WEATHER_API_BASE}/future.json`,
  history: `${WEATHER_API_BASE}/history.json`,
  marine: `${WEATHER_API_BASE}/marine.json`,
  astronomy: `${WEATHER_API_BASE}/astronomy.json`,
  timezone: `${WEATHER_API_BASE}/timezone.json`,
  alerts: `${WEATHER_API_BASE}/alerts.json`,
};

// Configure axios defaults
axios.defaults.timeout = 10000;
axios.defaults.retry = 3;
axios.defaults.retryDelay = 1000;

// Add retry interceptor
axios.interceptors.response.use(null, async (error) => {
  const config = error.config;
  if (!config || !config.retry) {
    return Promise.reject(error);
  }
  config.retryCount = config.retryCount || 0;
  if (config.retryCount >= config.retry) {
    return Promise.reject(error);
  }
  config.retryCount += 1;
  const delay = config.retryDelay || 1000;
  await new Promise((resolve) => setTimeout(resolve, delay));
  return axios(config);
});

// Cache implementation
const cache = new Map();

const getCachedData = (key) => {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  return null;
};

const setCachedData = (key, data) => {
  cache.set(key, {
    data,
    timestamp: Date.now(),
  });
};

// Validation functions
const validateLocation = (location) => {
  if (!location) {
    throw new Error("Location is required");
  }
  if (typeof location !== "string") {
    throw new Error("Location must be a string");
  }
};

const validateDate = (date) => {
  if (!date) {
    throw new Error("Date is required");
  }
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    throw new Error("Date must be in YYYY-MM-DD format");
  }
};

const validateDays = (days) => {
  if (days) {
    const numDays = parseInt(days);
    if (isNaN(numDays) || numDays < 1 || numDays > 14) {
      throw new Error("Days must be a number between 1 and 14");
    }
  }
};

// Common API call function
const callWeatherAPI = async (endpoint, params) => {
  try {
    const response = await axios.get(endpoint, {
      params: {
        key: API_KEY,
        lang: DEFAULT_LANG,
        ...params,
      },
      retry: 3,
      retryDelay: 1000,
    });
    return response.data;
  } catch (error) {
    console.error(`API Error (${endpoint}):`, error.message);
    throw error;
  }
};

// Common response handler
const handleResponse = async (
  res,
  data,
  type,
  location,
  additionalData = {}
) => {
  try {
    // Save to database
    await Weather.create({
      type,
      location,
      data: { ...data, ...additionalData },
    });

    return res.json({
      message: `${type} data retrieved successfully`,
      data,
    });
  } catch (error) {
    console.error(`Database Error (${type}):`, error.message);
    throw error;
  }
};

// Error handler
const handleError = (res, error, type) => {
  console.error(`${type} Error:`, error);
  return res.status(error.response?.status || 500).json({
    error: error.message,
    message: `Có lỗi xảy ra khi lấy thông tin ${type}.`,
  });
};

/**
 * Lấy thông tin thời tiết hiện tại
 */
const getCurrentWeather = async (req, res) => {
  try {
    const { location } = req.query;
    validateLocation(location);

    // Check cache
    const cacheKey = `current_${location}`;
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
      return res.json({
        message: "Current weather retrieved from cache",
        data: cachedData,
      });
    }

    const data = await callWeatherAPI(API_ENDPOINTS.current, {
      q: location,
      aqi: "yes",
    });

    // Set cache
    setCachedData(cacheKey, data);

    return handleResponse(res, data, "current", location);
  } catch (error) {
    return handleError(res, error, "Current Weather");
  }
};

/**
 * Lấy dự báo thời tiết
 */
const getForecast = async (req, res) => {
  try {
    const { location, days = 3 } = req.query;
    validateLocation(location);
    validateDays(days);

    // Check cache
    const cacheKey = `forecast_${location}_${days}`;
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
      return res.json({
        message: "Forecast retrieved from cache",
        data: cachedData,
      });
    }

    const data = await callWeatherAPI(API_ENDPOINTS.forecast, {
      q: location,
      days,
      aqi: "yes",
    });

    // Set cache
    setCachedData(cacheKey, data);

    return handleResponse(res, data, "forecast", location);
  } catch (error) {
    return handleError(res, error, "Forecast");
  }
};

/**
 * Lấy thông tin thời tiết tương lai
 */
const getFutureWeather = async (req, res) => {
  try {
    const { location, date } = req.query;
    validateLocation(location);
    validateDate(date);

    // Check cache
    const cacheKey = `future_${location}_${date}`;
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
      return res.json({
        message: "Future weather retrieved from cache",
        data: cachedData,
      });
    }

    // Lấy thông tin địa điểm
    const locationData = await searchLocation(location);
    if (!locationData || locationData.length === 0) {
      throw new Error("Location not found");
    }

    const data = await callWeatherAPI(API_ENDPOINTS.future, {
      q: location,
      dt: date,
      aqi: "yes",
    });

    // Set cache
    setCachedData(cacheKey, data);

    // Lưu vào database với đầy đủ thông tin
    await Weather.create({
      type: "future",
      source: "weatherapi",
      time: new Date(),
      longitude: locationData[0].lon,
      latitude: locationData[0].lat,
      city: locationData[0].name,
      location: location,
      data: data,
    });

    return res.json({
      message: "Future weather retrieved successfully",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Future Weather");
  }
};

/**
 * Lấy thông tin thời tiết biển
 */
const getMarineWeather = async (req, res) => {
  try {
    const { location } = req.query;
    validateLocation(location);

    // Check cache
    const cacheKey = `marine_${location}`;
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
      return res.json({
        message: "Marine weather retrieved from cache",
        data: cachedData,
      });
    }

    const data = await callWeatherAPI(API_ENDPOINTS.marine, {
      q: location,
      tides: "yes",
    });

    // Set cache
    setCachedData(cacheKey, data);

    return handleResponse(res, data, "marine", location);
  } catch (error) {
    return handleError(res, error, "Marine Weather");
  }
};

/**
 * Lấy thông tin thiên văn
 */
const getAstronomy = async (req, res) => {
  try {
    const { location, date } = req.query;
    validateLocation(location);
    if (date) {
      validateDate(date);
    }

    const targetDate = date || new Date().toISOString().split("T")[0];

    // Check cache
    const cacheKey = `astronomy_${location}_${targetDate}`;
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
      return res.json({
        message: "Astronomy data retrieved from cache",
        data: cachedData,
      });
    }

    const data = await callWeatherAPI(API_ENDPOINTS.astronomy, {
      q: location,
      dt: targetDate,
    });

    // Set cache
    setCachedData(cacheKey, data);

    // Save to database
    await Astronomy.create({
      location,
      date: targetDate,
      data,
    });

    return res.json({
      message: "Astronomy data retrieved successfully",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Astronomy");
  }
};

/**
 * Lấy thông tin múi giờ
 */
const getTimeZone = async (req, res) => {
  try {
    const { location } = req.query;
    validateLocation(location);

    // Check cache
    const cacheKey = `timezone_${location}`;
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
      return res.json({
        message: "Time zone data retrieved from cache",
        data: cachedData,
      });
    }

    const data = await callWeatherAPI(API_ENDPOINTS.timezone, {
      q: location,
    });

    // Set cache
    setCachedData(cacheKey, data);

    return res.json({
      message: "Time zone data retrieved successfully",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Time Zone");
  }
};

/**
 * Lấy thông tin cảnh báo thời tiết
 */
const getWeatherAlerts = async (req, res) => {
  try {
    const { location } = req.query;
    validateLocation(location);

    // Check cache
    const cacheKey = `alerts_${location}`;
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
      return res.json({
        message: "Weather alerts retrieved from cache",
        data: cachedData,
      });
    }

    const data = await callWeatherAPI(API_ENDPOINTS.alerts, {
      q: location,
    });

    // Set cache
    setCachedData(cacheKey, data);

    return res.json({
      message: "Weather alerts retrieved successfully",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Weather Alerts");
  }
};

const searchLocation = async (query) => {
  try {
    const response = await axios.get(
      `https://api.geoapify.com/v1/geocode/search`,
      {
        params: {
          text: query,
          lang: DEFAULT_LANG,
          limit: 10,
          apiKey: GEOAPIFY_KEY,
        },
      }
    );

    if (!response.data.features || response.data.features.length === 0) {
      return [];
    }

    return response.data.features.map((feature) => ({
      name: feature.properties.formatted,
      city: feature.properties.city,
      state: feature.properties.state,
      country: feature.properties.country,
      lat: feature.properties.lat,
      lon: feature.properties.lon,
    }));
  } catch (error) {
    console.error("Error searching location:", error.message);
    return [];
  }
};

module.exports = {
  getCurrentWeather,
  getForecast,
  getFutureWeather,
  getMarineWeather,
  getAstronomy,
  getTimeZone,
  getWeatherAlerts,
};
