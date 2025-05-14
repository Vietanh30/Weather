const axios = require("axios");
const {
  Weather,
  Astronomy,
  Marine,
  AirQuality,
  History,
} = require("../model/weather.model");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

// Constants
const API_KEY = process.env.WEATHERAPI_KEY;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const DEFAULT_LANG = "vi";
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Add OpenWeatherMap API constants
const OPENWEATHER_API_KEY =
  process.env.OPENWEATHER_API_KEY || "f147385a13b582f46c1de3374c8cdaec"; // Default key for testing
const OPENWEATHER_BASE = "https://api.openweathermap.org/data/2.5";

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  generationConfig: {
    temperature: 0.7,
    topK: 40,
    topP: 0.95,
    maxOutputTokens: 1024,
  },
});

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
const validateLocation = (location, lat, lon) => {
  // Nếu có location thì không cần kiểm tra lat,lon
  if (location) {
    if (typeof location !== "string") {
      throw new Error("Location must be a string");
    }
    return;
  }

  // Nếu không có location thì phải có cả lat và lon
  if (!lat || !lon) {
    throw new Error("Location or coordinates (lat,lon) is required");
  }

  // Validate lat,lon nếu có
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  if (isNaN(latNum) || isNaN(lonNum)) {
    throw new Error("Latitude and longitude must be numbers");
  }

  if (latNum < -90 || latNum > 90) {
    throw new Error("Latitude must be between -90 and 90");
  }

  if (lonNum < -180 || lonNum > 180) {
    throw new Error("Longitude must be between -180 and 180");
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

// Helper functions for database operations
const findInDatabase = async (Model, query, timeWindow) => {
  const timeAgo = new Date();
  timeAgo.setHours(timeAgo.getHours() - timeWindow);
  return await Model.findOne({
    ...query,
    time: { $gte: timeAgo },
  }).sort({ time: -1 });
};

const saveToDatabase = async (Model, data) => {
  return await Model.create(data);
};

// Cache durations in hours
const CACHE_DURATIONS = {
  current: 1, // 1 hour
  forecast: 3, // 3 hours
  future: 24, // 24 hours
  marine: 6, // 6 hours
  astronomy: 24, // 24 hours
  timezone: 24, // 24 hours
  alerts: 1, // 1 hour
  history: 24, // 24 hours
};

/**
 * Lấy thông tin thời tiết hiện tại
 */
const getCurrentWeather = async (req, res) => {
  try {
    const { location, lat, lon } = req.query;
    validateLocation(location, lat, lon);

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Kiểm tra trong database
    const dbQuery = {
      type: "current",
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : location }),
    };

    const existingData = await findInDatabase(
      Weather,
      dbQuery,
      CACHE_DURATIONS.current
    );

    if (existingData) {
      console.log("Retrieved current weather from database");
      return res.json({
        message: "Current weather retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching current weather from API");
    const data = await callWeatherAPI(API_ENDPOINTS.current, {
      q: queryParam,
      aqi: "yes",
    });

    // Lưu vào database
    await saveToDatabase(Weather, {
      type: "current",
      source: "weatherapi",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: locationData ? locationData[0].name : location || `${lat},${lon}`,
      location: location || `${lat},${lon}`,
      data: data,
    });

    return res.json({
      message: "Current weather retrieved from API and saved to database",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Current Weather");
  }
};

/**
 * Lấy dự báo thời tiết
 */
const getForecast = async (req, res) => {
  try {
    const { location, days = 3, lat, lon } = req.query;
    validateLocation(location, lat, lon);
    validateDays(days);

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Kiểm tra trong database
    const dbQuery = {
      type: "forecast",
      days: days,
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : location }),
    };

    const existingData = await findInDatabase(
      Weather,
      dbQuery,
      CACHE_DURATIONS.forecast
    );

    if (existingData) {
      console.log("Retrieved forecast from database");
      return res.json({
        message: "Forecast retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching forecast from API");
    const data = await callWeatherAPI(API_ENDPOINTS.forecast, {
      q: queryParam,
      days,
      aqi: "yes",
    });

    // Lưu vào database
    await saveToDatabase(Weather, {
      type: "forecast",
      source: "weatherapi",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: locationData ? locationData[0].name : location,
      location: location || `${lat},${lon}`,
      days: days,
      data: data,
    });

    return res.json({
      message: "Forecast retrieved from API and saved to database",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Forecast");
  }
};

/**
 * Lấy thông tin thời tiết tương lai
 */
const getFutureWeather = async (req, res) => {
  try {
    const { location, date, lat, lon } = req.query;
    validateLocation(location, lat, lon);
    validateDate(date);

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Kiểm tra trong database
    const dbQuery = {
      type: "future",
      date: date,
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : location }),
    };

    const existingData = await findInDatabase(
      Weather,
      dbQuery,
      CACHE_DURATIONS.future
    );

    if (existingData) {
      console.log("Retrieved future weather from database");
      return res.json({
        message: "Future weather retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching future weather from API");
    const data = await callWeatherAPI(API_ENDPOINTS.future, {
      q: queryParam,
      dt: date,
      aqi: "yes",
    });

    // Lưu vào database
    await saveToDatabase(Weather, {
      type: "future",
      source: "weatherapi",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: locationData ? locationData[0].name : location,
      location: location || `${lat},${lon}`,
      date: date,
      data: data,
    });

    return res.json({
      message: "Future weather retrieved from API and saved to database",
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
    const { location, lat, lon } = req.query;
    validateLocation(location, lat, lon);

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Kiểm tra trong database
    const dbQuery = {
      type: "marine",
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : location }),
    };

    const existingData = await findInDatabase(
      Marine,
      dbQuery,
      CACHE_DURATIONS.marine
    );

    if (existingData) {
      console.log("Retrieved marine weather from database");
      return res.json({
        message: "Marine weather retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching marine weather from API");
    const data = await callWeatherAPI(API_ENDPOINTS.marine, {
      q: queryParam,
      tides: "yes",
    });

    // Lưu vào database
    await saveToDatabase(Marine, {
      source: "weatherapi",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: locationData ? locationData[0].name : location,
      location: location || `${lat},${lon}`,
      data: data,
    });

    return res.json({
      message: "Marine weather retrieved from API and saved to database",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Marine Weather");
  }
};

/**
 * Lấy thông tin múi giờ
 */
const getTimeZone = async (req, res) => {
  try {
    const { location, lat, lon } = req.query;
    validateLocation(location, lat, lon);

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Kiểm tra trong database
    const dbQuery = {
      type: "timezone",
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : location }),
    };

    const existingData = await findInDatabase(
      Weather,
      dbQuery,
      CACHE_DURATIONS.timezone
    );

    if (existingData) {
      console.log("Retrieved timezone from database");
      return res.json({
        message: "Time zone data retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching timezone from API");
    const data = await callWeatherAPI(API_ENDPOINTS.timezone, {
      q: queryParam,
    });

    // Lưu vào database
    await saveToDatabase(Weather, {
      type: "timezone",
      source: "weatherapi",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: locationData ? locationData[0].name : location,
      location: location || `${lat},${lon}`,
      data: data,
    });

    return res.json({
      message: "Time zone data retrieved from API and saved to database",
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
    const { location, lat, lon } = req.query;
    validateLocation(location, lat, lon);

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Xác định tên thành phố
    const cityName = locationData
      ? locationData[0].name
      : location || `${lat},${lon}`;

    // Kiểm tra trong database
    const dbQuery = {
      type: "alerts",
      ...(lat && lon ? { latitude: lat, longitude: lon } : { city: cityName }),
    };

    const existingData = await findInDatabase(
      Weather,
      dbQuery,
      CACHE_DURATIONS.alerts
    );

    if (existingData) {
      console.log("Retrieved weather alerts from database");
      return res.json({
        message: "Weather alerts retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching weather alerts from API");
    const data = await callWeatherAPI(API_ENDPOINTS.alerts, {
      q: queryParam,
    });

    // Lưu vào database
    await saveToDatabase(Weather, {
      type: "alerts",
      source: "weatherapi",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: cityName,
      location: location || `${lat},${lon}`,
      data: data,
    });

    return res.json({
      message: "Weather alerts retrieved from API and saved to database",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Weather Alerts");
  }
};

/**
 * Lấy thông tin thiên văn
 */
const getAstronomy = async (req, res) => {
  try {
    const { location, date, lat, lon } = req.query;
    validateLocation(location, lat, lon);
    if (date) {
      validateDate(date);
    }

    const targetDate = date || new Date().toISOString().split("T")[0];

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Kiểm tra trong database
    const dbQuery = {
      date: targetDate,
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : location }),
    };

    const existingData = await findInDatabase(
      Astronomy,
      dbQuery,
      CACHE_DURATIONS.astronomy
    );

    if (existingData) {
      console.log("Retrieved astronomy data from database");
      return res.json({
        message: "Astronomy data retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching astronomy data from API");
    const data = await callWeatherAPI(API_ENDPOINTS.astronomy, {
      q: queryParam,
      dt: targetDate,
    });

    // Lưu vào database
    await saveToDatabase(Astronomy, {
      source: "weatherapi",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: locationData ? locationData[0].name : location,
      location: location || `${lat},${lon}`,
      date: targetDate,
      sunrise: data.astronomy.astro.sunrise,
      sunset: data.astronomy.astro.sunset,
      moonrise: data.astronomy.astro.moonrise,
      moonset: data.astronomy.astro.moonset,
      moon_phase: data.astronomy.astro.moon_phase,
      moon_illumination: data.astronomy.astro.moon_illumination,
      is_sun_up: data.astronomy.astro.is_sun_up,
      is_moon_up: data.astronomy.astro.is_moon_up,
      data: data,
    });

    return res.json({
      message: "Astronomy data retrieved from API and saved to database",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Astronomy");
  }
};

/**
 * Lấy dự báo thời tiết 7 ngày
 */
const getSevenDayForecast = async (req, res) => {
  try {
    const { location, lat, lon } = req.query;

    // Kiểm tra API key
    if (!OPENWEATHER_API_KEY) {
      throw new Error("OpenWeatherMap API key is not configured");
    }

    // Kiểm tra nếu không có location thì phải có lat và lon
    if (!location && (!lat || !lon)) {
      throw new Error("Location or coordinates (lat,lon) is required");
    }

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Kiểm tra trong database
    const dbQuery = {
      type: "seven_day_forecast",
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : location }),
    };

    const existingData = await findInDatabase(
      Weather,
      dbQuery,
      CACHE_DURATIONS.forecast
    );

    if (existingData) {
      console.log("Retrieved 7-day forecast from database");
      return res.json({
        message: "7-day forecast retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi OpenWeatherMap API
    console.log("Fetching 5-day forecast from OpenWeatherMap API");
    try {
      const response = await axios.get(`${OPENWEATHER_BASE}/forecast`, {
        params: {
          ...(lat && lon
            ? { lat, lon }
            : { q: locationData ? locationData[0].name : location }),
          appid: OPENWEATHER_API_KEY,
          units: "metric",
          lang: "vi",
        },
        timeout: 10000, // 10 seconds timeout
        retry: 3,
        retryDelay: 1000,
      });

      if (!response.data || !response.data.list) {
        throw new Error("Invalid response from OpenWeatherMap API");
      }

      // Xử lý dữ liệu từ OpenWeatherMap
      const processedData = {
        location: {
          name: response.data.city.name,
          country: response.data.city.country,
          coord: response.data.city.coord,
        },
        forecast: [],
      };

      // Nhóm dữ liệu theo ngày
      const dailyData = {};
      response.data.list.forEach((item) => {
        const date = item.dt_txt.split(" ")[0];
        if (!dailyData[date]) {
          dailyData[date] = {
            temps: [],
            feels_like: [],
            humidity: [],
            weather: item.weather,
            wind_speeds: [],
            wind_deg: [],
            pop: [],
          };
        }
        dailyData[date].temps.push(item.main.temp);
        dailyData[date].feels_like.push(item.main.feels_like);
        dailyData[date].humidity.push(item.main.humidity);
        dailyData[date].wind_speeds.push(item.wind.speed);
        dailyData[date].wind_deg.push(item.wind.deg);
        dailyData[date].pop.push(item.pop);
      });

      // Tính trung bình cho mỗi ngày
      Object.entries(dailyData).forEach(([date, data]) => {
        processedData.forecast.push({
          dt: new Date(date).getTime() / 1000,
          dt_txt: date,
          main: {
            temp: data.temps.reduce((a, b) => a + b) / data.temps.length,
            feels_like:
              data.feels_like.reduce((a, b) => a + b) / data.feels_like.length,
            temp_min: Math.min(...data.temps),
            temp_max: Math.max(...data.temps),
            humidity: Math.round(
              data.humidity.reduce((a, b) => a + b) / data.humidity.length
            ),
          },
          weather: data.weather,
          wind: {
            speed:
              data.wind_speeds.reduce((a, b) => a + b) /
              data.wind_speeds.length,
            deg: Math.round(
              data.wind_deg.reduce((a, b) => a + b) / data.wind_deg.length
            ),
          },
          pop: Math.max(...data.pop),
          clouds: { all: 0 },
          visibility: 10000,
        });
      });

      // Xác định tên thành phố
      const cityName =
        response.data.city.name ||
        (locationData ? locationData[0].name : location) ||
        `${lat},${lon}`;

      // Thử dự đoán 2 ngày còn lại bằng Gemini
      let predictedData = null;
      try {
        // Tính toán xu hướng thời tiết từ 5 ngày trước
        const last5Days = processedData.forecast.slice(-5);
        const tempTrend = last5Days.map((day) => day.main.temp);
        const avgTemp = tempTrend.reduce((a, b) => a + b) / tempTrend.length;
        const tempRange = Math.max(...tempTrend) - Math.min(...tempTrend);
        const humidityTrend = last5Days.map((day) => day.main.humidity);
        const avgHumidity =
          humidityTrend.reduce((a, b) => a + b) / humidityTrend.length;
        const windTrend = last5Days.map((day) => day.wind.speed);
        const avgWind = windTrend.reduce((a, b) => a + b) / windTrend.length;

        // Lấy danh sách các loại thời tiết phổ biến từ 5 ngày trước
        const weatherTypes = last5Days.map((day) => day.weather[0].main);
        const weatherDescriptions = last5Days.map(
          (day) => day.weather[0].description
        );
        const weatherIcons = last5Days.map((day) => day.weather[0].icon);

        // Mapping cho các loại thời tiết
        const weatherMapping = {
          Clear: {
            icon: "01d",
            description: "trời quang",
          },
          Clouds: {
            icon: "02d",
            description: "mây rải rác",
          },
          Rain: {
            icon: "10d",
            description: "mưa nhẹ",
          },
          Thunderstorm: {
            icon: "11d",
            description: "dông",
          },
          Snow: {
            icon: "13d",
            description: "tuyết",
          },
          Mist: {
            icon: "50d",
            description: "sương mù",
          },
        };

        const prompt = `Dựa trên dữ liệu thời tiết 5 ngày qua của ${cityName}, hãy dự đoán thời tiết cho 2 ngày tiếp theo (ngày 6 và 7). 
        Dữ liệu 5 ngày qua:
        ${JSON.stringify(processedData.forecast, null, 2)}
        
        Xu hướng thời tiết:
        - Nhiệt độ trung bình: ${avgTemp.toFixed(1)}°C
        - Biên độ nhiệt: ${tempRange.toFixed(1)}°C
        - Độ ẩm trung bình: ${avgHumidity.toFixed(1)}%
        - Tốc độ gió trung bình: ${avgWind.toFixed(1)} m/s
        - Các loại thời tiết phổ biến: ${[...new Set(weatherTypes)].join(", ")}
        
        Hãy dự đoán 2 ngày tiếp theo với các điều kiện sau:
        1. Nhiệt độ phải nằm trong khoảng: ${(avgTemp - tempRange).toFixed(
          1
        )}°C đến ${(avgTemp + tempRange).toFixed(1)}°C
        2. Độ ẩm phải nằm trong khoảng: ${Math.max(0, avgHumidity - 20).toFixed(
          1
        )}% đến ${Math.min(100, avgHumidity + 20).toFixed(1)}%
        3. Tốc độ gió phải nằm trong khoảng: ${Math.max(0, avgWind - 5).toFixed(
          1
        )} đến ${(avgWind + 5).toFixed(1)} m/s
        4. Thời tiết phải là một trong các loại sau: ${Object.keys(
          weatherMapping
        ).join(", ")}
        
        Hãy trả về JSON với format chính xác như sau (không thêm bất kỳ text nào khác):
        {
          "day6": {
            "date": "YYYY-MM-DD",
            "main": {
              "temp": 25.5,
              "feels_like": 26.0,
              "temp_min": 24.0,
              "temp_max": 27.0,
              "humidity": 75
            },
            "weather": [
              {
                "main": "Clouds",
                "description": "mây rải rác",
                "icon": "02d"
              }
            ],
            "wind": {
              "speed": 3.5,
              "deg": 180
            },
            "pop": 0.2
          },
          "day7": {
            "date": "YYYY-MM-DD",
            "main": {
              "temp": 26.0,
              "feels_like": 26.5,
              "temp_min": 25.0,
              "temp_max": 28.0,
              "humidity": 80
            },
            "weather": [
              {
                "main": "Rain",
                "description": "mưa nhẹ",
                "icon": "10d"
              }
            ],
            "wind": {
              "speed": 4.0,
              "deg": 190
            },
            "pop": 0.4
          }
        }`;

        const geminiResponse = await model.generateContent(prompt);
        const geminiText = geminiResponse.response.text();
        const jsonMatch = geminiText.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          predictedData = JSON.parse(jsonMatch[0]);

          // Validate dự đoán
          const validatePrediction = (day, dayNum) => {
            const temp = day.main.temp;
            const humidity = day.main.humidity;
            const windSpeed = day.wind.speed;
            const weatherMain = day.weather[0].main;

            // Kiểm tra nhiệt độ
            if (temp < avgTemp - tempRange || temp > avgTemp + tempRange) {
              console.warn(`Day ${dayNum} temperature out of range: ${temp}°C`);
              return false;
            }

            // Kiểm tra độ ẩm
            if (
              humidity < Math.max(0, avgHumidity - 20) ||
              humidity > Math.min(100, avgHumidity + 20)
            ) {
              console.warn(`Day ${dayNum} humidity out of range: ${humidity}%`);
              return false;
            }

            // Kiểm tra tốc độ gió
            if (
              windSpeed < Math.max(0, avgWind - 5) ||
              windSpeed > avgWind + 5
            ) {
              console.warn(
                `Day ${dayNum} wind speed out of range: ${windSpeed} m/s`
              );
              return false;
            }

            // Kiểm tra loại thời tiết
            if (!weatherMapping[weatherMain]) {
              console.warn(
                `Day ${dayNum} invalid weather type: ${weatherMain}`
              );
              return false;
            }

            return true;
          };

          // Validate cả 2 ngày
          const isDay6Valid = validatePrediction(predictedData.day6, 6);
          const isDay7Valid = validatePrediction(predictedData.day7, 7);

          if (!isDay6Valid || !isDay7Valid) {
            console.warn("Prediction validation failed, using fallback values");
            predictedData = null;
          } else {
            // Cập nhật icon và description cho cả 2 ngày
            predictedData.day6.weather[0] = {
              ...predictedData.day6.weather[0],
              icon: weatherMapping[predictedData.day6.weather[0].main].icon,
              description:
                weatherMapping[predictedData.day6.weather[0].main].description,
            };

            predictedData.day7.weather[0] = {
              ...predictedData.day7.weather[0],
              icon: weatherMapping[predictedData.day7.weather[0].main].icon,
              description:
                weatherMapping[predictedData.day7.weather[0].main].description,
            };
          }
        }
      } catch (geminiError) {
        console.error("Gemini prediction failed:", geminiError);
        predictedData = null;
      }

      // Thêm dự đoán nếu có và hợp lệ
      if (predictedData) {
        // Thêm dự đoán ngày 6
        processedData.forecast.push({
          dt: new Date(predictedData.day6.date).getTime() / 1000,
          dt_txt: predictedData.day6.date,
          main: {
            temp: Number(predictedData.day6.main.temp),
            feels_like: Number(predictedData.day6.main.feels_like),
            temp_min: Number(predictedData.day6.main.temp_min),
            temp_max: Number(predictedData.day6.main.temp_max),
            humidity: Number(predictedData.day6.main.humidity),
          },
          weather: predictedData.day6.weather,
          wind: {
            speed: Number(predictedData.day6.wind.speed),
            deg: Number(predictedData.day6.wind.deg),
          },
          pop: Number(predictedData.day6.pop),
          clouds: { all: 0 },
          visibility: 10000,
        });

        // Thêm dự đoán ngày 7
        processedData.forecast.push({
          dt: new Date(predictedData.day7.date).getTime() / 1000,
          dt_txt: predictedData.day7.date,
          main: {
            temp: Number(predictedData.day7.main.temp),
            feels_like: Number(predictedData.day7.main.feels_like),
            temp_min: Number(predictedData.day7.main.temp_min),
            temp_max: Number(predictedData.day7.main.temp_max),
            humidity: Number(predictedData.day7.main.humidity),
          },
          weather: predictedData.day7.weather,
          wind: {
            speed: Number(predictedData.day7.wind.speed),
            deg: Number(predictedData.day7.wind.deg),
          },
          pop: Number(predictedData.day7.pop),
          clouds: { all: 0 },
          visibility: 10000,
        });

        processedData.notice =
          "Dự báo 7 ngày bao gồm: 5 ngày từ OpenWeatherMap API và 2 ngày được dự đoán bởi AI.";
      } else {
        processedData.notice =
          "Dự báo 5 ngày từ OpenWeatherMap API (không có dự đoán AI do không đảm bảo độ chính xác).";
      }

      // Lưu vào database
      await saveToDatabase(Weather, {
        type: "seven_day_forecast",
        source: "openweathermap+gemini",
        time: new Date(),
        longitude: lon || (locationData ? locationData[0].lon : null),
        latitude: lat || (locationData ? locationData[0].lat : null),
        city: cityName,
        location: location || `${lat},${lon}`,
        data: processedData,
      });

      return res.json({
        message: "7-day forecast retrieved successfully",
        data: processedData,
      });
    } catch (apiError) {
      console.error("API Error:", apiError.response?.data || apiError.message);
      throw new Error(
        apiError.response?.data?.message || "Failed to fetch weather data"
      );
    }
  } catch (error) {
    console.error("7-Day Forecast Error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch weather data",
      message: error.message || "Có lỗi xảy ra khi lấy dự báo thời tiết",
      details: error.response?.data || error.message,
    });
  }
};

/**
 * Lấy thông tin thời tiết trong quá khứ
 */
const getWeatherHistory = async (req, res) => {
  try {
    console.log("Weather History Request Query:", req.query);
    const { q, dt, location, date, lat, lon } = req.query;

    // Sử dụng q nếu có, nếu không thì dùng location
    const finalLocation = q || location;
    // Sử dụng dt nếu có, nếu không thì dùng date
    const finalDate = dt || date;

    // Validate location and date
    try {
      validateLocation(finalLocation, lat, lon);
      validateDate(finalDate);
    } catch (validationError) {
      console.error("Validation Error:", validationError);
      throw validationError;
    }

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : finalLocation;
    console.log("Query Parameter:", queryParam);

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      try {
        locationData = await searchLocation(finalLocation);
        console.log("Location Search Result:", locationData);
        if (!locationData || locationData.length === 0) {
          throw new Error("Location not found");
        }
      } catch (searchError) {
        console.error("Location Search Error:", searchError);
        throw searchError;
      }
    }

    // Kiểm tra trong database
    const dbQuery = {
      type: "history",
      date: finalDate,
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : finalLocation }),
    };
    console.log("Database Query:", dbQuery);

    try {
      const existingData = await findInDatabase(
        History,
        dbQuery,
        CACHE_DURATIONS.history
      );

      if (existingData) {
        console.log("Retrieved weather history from database");
        return res.json({
          message: "Weather history retrieved from database",
          data: existingData.data,
        });
      }
    } catch (dbError) {
      console.error("Database Error:", dbError);
      // Continue to API call if database fails
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching weather history from API");
    try {
      const data = await callWeatherAPI(API_ENDPOINTS.history, {
        q: queryParam,
        dt: finalDate,
        lang: "vi",
        aqi: "yes",
      });
      console.log("API Response:", data);

      // Lưu vào database
      try {
        await saveToDatabase(History, {
          type: "history",
          source: "weatherapi",
          time: new Date(),
          longitude: lon || (locationData ? locationData[0].lon : null),
          latitude: lat || (locationData ? locationData[0].lat : null),
          city: locationData ? locationData[0].name : finalLocation,
          location: finalLocation || `${lat},${lon}`,
          date: finalDate,
          data: data,
        });
      } catch (saveError) {
        console.error("Database Save Error:", saveError);
        // Continue even if save fails
      }

      return res.json({
        message: "Weather history retrieved from API and saved to database",
        data,
      });
    } catch (apiError) {
      console.error("API Error:", apiError);
      if (apiError.response) {
        console.error("API Error Response:", apiError.response.data);
      }
      throw apiError;
    }
  } catch (error) {
    console.error("Weather History Error:", error);
    return handleError(res, error, "Weather History");
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

/**
 * Dịch nội dung cảnh báo sang tiếng Việt
 */
const translateAlert = async (alert) => {
  try {
    const prompt = `Hãy dịch nội dung cảnh báo thời tiết sau sang tiếng Việt, giữ nguyên format JSON và các trường kỹ thuật:
    ${JSON.stringify(alert, null, 2)}
    
    Yêu cầu:
    1. Chỉ dịch các trường: headline, desc, instruction
    2. Giữ nguyên các trường kỹ thuật và định dạng
    3. Dịch sang tiếng Việt tự nhiên, dễ hiểu
    4. Trả về đúng format JSON
    
    Trả về JSON với format:
    {
      "headline": "Bản dịch tiếng Việt của headline",
      "desc": "Bản dịch tiếng Việt của desc",
      "instruction": "Bản dịch tiếng Việt của instruction"
    }`;

    const geminiResponse = await model.generateContent(prompt);
    const geminiText = geminiResponse.response.text();
    const jsonMatch = geminiText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const translation = JSON.parse(jsonMatch[0]);
      return {
        ...alert,
        headline: translation.headline,
        desc: translation.desc,
        instruction: translation.instruction,
      };
    }
    return alert;
  } catch (error) {
    console.error("Translation error:", error);
    return alert;
  }
};

/**
 * Lấy thông tin cảnh báo thời tiết với bộ lọc mức độ
 */
const getWeatherNotifications = async (req, res) => {
  try {
    const { location, lat, lon, severity, type, area } = req.query;
    validateLocation(location, lat, lon);

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Xác định tên thành phố
    const cityName = locationData
      ? locationData[0].name
      : location || `${lat},${lon}`;

    // Kiểm tra trong database
    const dbQuery = {
      type: "notifications",
      ...(lat && lon ? { latitude: lat, longitude: lon } : { city: cityName }),
    };

    const existingData = await findInDatabase(
      Weather,
      dbQuery,
      CACHE_DURATIONS.alerts
    );

    if (existingData) {
      console.log("Retrieved weather notifications from database");
      return res.json({
        message: "Weather notifications retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching weather notifications from API");
    const data = await callWeatherAPI(API_ENDPOINTS.alerts, {
      q: queryParam,
      severity: severity || undefined,
      type: type || undefined,
      area: area || undefined,
    });

    // Lọc và định dạng cảnh báo
    const alerts = data.alerts?.alert
      ? Array.isArray(data.alerts.alert)
        ? data.alerts.alert
        : [data.alerts.alert]
      : [];

    // Dịch các cảnh báo sang tiếng Việt
    const translatedAlerts = await Promise.all(
      alerts.map(async (alert) => {
        const translatedAlert = await translateAlert(alert);
        return {
          id: translatedAlert.alert_id,
          type: translatedAlert.alert_type,
          severity: translatedAlert.severity,
          title: translatedAlert.headline,
          description: translatedAlert.desc,
          area: translatedAlert.area,
          startTime: translatedAlert.effective,
          endTime: translatedAlert.expires,
          source: translatedAlert.source,
          instructions: translatedAlert.instruction,
        };
      })
    );

    // Lưu vào database
    await saveToDatabase(Weather, {
      type: "notifications",
      source: "weatherapi",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: cityName,
      location: location || `${lat},${lon}`,
      data: {
        alerts: translatedAlerts,
        total: translatedAlerts.length,
        location: data.location,
      },
    });

    return res.json({
      message: "Weather notifications retrieved from API and saved to database",
      data: {
        alerts: translatedAlerts,
        total: translatedAlerts.length,
        location: data.location,
      },
    });
  } catch (error) {
    return handleError(res, error, "Weather Notifications");
  }
};

/**
 * Đăng ký nhận thông báo thời tiết
 */
const subscribeToAlerts = async (req, res) => {
  try {
    const { deviceId, location, severity, types, fcmToken } = req.body;

    // Validate required parameters
    if (!deviceId || !location) {
      return res.status(400).json({
        success: false,
        error: "Device ID and location are required",
        message: "Vui lòng cung cấp ID thiết bị và địa điểm",
      });
    }

    // Validate location
    let locationData = null;
    try {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: "Invalid location",
        message: "Địa điểm không hợp lệ",
      });
    }

    // Validate severity if provided
    if (
      severity &&
      !["minor", "moderate", "severe", "extreme"].includes(severity)
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid severity level",
        message: "Mức độ cảnh báo không hợp lệ",
      });
    }

    // Save subscription to database
    await Weather.create({
      type: "alert_subscription",
      deviceId,
      fcmToken,
      location: locationData[0].name,
      latitude: locationData[0].lat,
      longitude: locationData[0].lon,
      severity,
      types,
      active: true,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      message: "Đăng ký nhận thông báo thành công",
      data: {
        deviceId,
        location: locationData[0].name,
        severity,
        types,
      },
    });
  } catch (error) {
    console.error("Error subscribing to alerts:", error);
    res.status(500).json({
      success: false,
      error: "Failed to subscribe to alerts",
      message: "Có lỗi xảy ra khi đăng ký nhận thông báo",
      details: error.message,
    });
  }
};

/**
 * Hủy đăng ký thông báo thời tiết
 */
const unsubscribeFromAlerts = async (req, res) => {
  try {
    const { deviceId } = req.body;

    // Validate required parameters
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: "Device ID is required",
        message: "Vui lòng cung cấp ID thiết bị",
      });
    }

    // Update subscription status in database
    const result = await Weather.updateMany(
      {
        type: "alert_subscription",
        deviceId,
        active: true,
      },
      {
        $set: {
          active: false,
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({
        success: false,
        error: "No active subscription found",
        message: "Không tìm thấy đăng ký thông báo nào",
      });
    }

    res.json({
      success: true,
      message: "Hủy đăng ký thông báo thành công",
    });
  } catch (error) {
    console.error("Error unsubscribing from alerts:", error);
    res.status(500).json({
      success: false,
      error: "Failed to unsubscribe from alerts",
      message: "Có lỗi xảy ra khi hủy đăng ký thông báo",
      details: error.message,
    });
  }
};

/**
 * Lấy thông tin chi tiết về thông báo thời tiết
 */
const getWeatherNotificationDetail = async (req, res) => {
  try {
    const { alertId, location, lat, lon } = req.query;

    if (!alertId) {
      return res.status(400).json({
        success: false,
        error: "Alert ID is required",
        message: "Vui lòng cung cấp ID cảnh báo",
      });
    }

    validateLocation(location, lat, lon);

    // Xác định query parameter
    const queryParam = lat && lon ? `${lat},${lon}` : location;

    // Lấy thông tin địa điểm nếu chỉ có tên
    let locationData = null;
    if (!lat || !lon) {
      locationData = await searchLocation(location);
      if (!locationData || locationData.length === 0) {
        throw new Error("Location not found");
      }
    }

    // Xác định tên thành phố
    const cityName = locationData
      ? locationData[0].name
      : location || `${lat},${lon}`;

    // Kiểm tra trong database
    const dbQuery = {
      type: "notification_detail",
      alertId,
      ...(lat && lon ? { latitude: lat, longitude: lon } : { city: cityName }),
    };

    const existingData = await findInDatabase(
      Weather,
      dbQuery,
      CACHE_DURATIONS.alerts
    );

    if (existingData) {
      console.log("Retrieved weather notification detail from database");
      return res.json({
        message: "Weather notification detail retrieved from database",
        data: existingData.data,
      });
    }

    // Nếu không có trong database, gọi API
    console.log("Fetching weather notification detail from API");
    const data = await callWeatherAPI(API_ENDPOINTS.alerts, {
      q: queryParam,
    });

    // Tìm alert cụ thể
    const alerts = data.alerts?.alert
      ? Array.isArray(data.alerts.alert)
        ? data.alerts.alert
        : [data.alerts.alert]
      : [];

    const alert = alerts.find((a) => a.alert_id === alertId);
    if (!alert) {
      return res.status(404).json({
        success: false,
        error: "Alert not found",
        message: "Không tìm thấy thông báo với ID này",
      });
    }

    // Dịch nội dung cảnh báo
    const translatedAlert = await translateAlert(alert);

    // Tạo prompt cho Gemini để phân tích và bổ sung thông tin
    const prompt = `Dựa trên thông tin cảnh báo thời tiết sau, hãy phân tích và bổ sung thêm thông tin chi tiết:
    ${JSON.stringify(translatedAlert, null, 2)}
    
    Hãy trả về JSON với các thông tin sau:
    1. Phân tích mức độ nguy hiểm
    2. Các biện pháp phòng chống cụ thể
    3. Các đối tượng cần lưu ý
    4. Các khu vực có nguy cơ cao
    5. Thời gian ảnh hưởng
    6. Các nguồn thông tin đáng tin cậy
    7. Các số điện thoại khẩn cấp
    
    Format JSON:
    {
      "risk_analysis": {
        "level": "cao/trung bình/thấp",
        "description": "Mô tả chi tiết về mức độ nguy hiểm"
      },
      "prevention_measures": [
        "Danh sách các biện pháp phòng chống"
      ],
      "affected_groups": [
        "Danh sách các đối tượng cần lưu ý"
      ],
      "high_risk_areas": [
        "Danh sách các khu vực có nguy cơ cao"
      ],
      "impact_time": {
        "start": "Thời điểm bắt đầu ảnh hưởng",
        "peak": "Thời điểm ảnh hưởng mạnh nhất",
        "end": "Thời điểm kết thúc ảnh hưởng"
      },
      "reliable_sources": [
        "Danh sách các nguồn thông tin đáng tin cậy"
      ],
      "emergency_contacts": [
        "Danh sách các số điện thoại khẩn cấp"
      ]
    }`;

    let additionalInfo = null;
    try {
      const geminiResponse = await model.generateContent(prompt);
      const geminiText = geminiResponse.response.text();
      const jsonMatch = geminiText.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        additionalInfo = JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.error("Error getting additional info:", error);
    }

    // Tạo response chi tiết
    const detailedAlert = {
      id: translatedAlert.alert_id,
      type: translatedAlert.alert_type,
      severity: translatedAlert.severity,
      title: translatedAlert.headline,
      description: translatedAlert.desc,
      area: translatedAlert.area,
      startTime: translatedAlert.effective,
      endTime: translatedAlert.expires,
      source: translatedAlert.source,
      instructions: translatedAlert.instruction,
      additional_info: additionalInfo || {
        risk_analysis: {
          level: "Không xác định",
          description: "Không thể phân tích mức độ nguy hiểm",
        },
        prevention_measures: ["Không có thông tin phòng chống"],
        affected_groups: ["Không có thông tin về đối tượng ảnh hưởng"],
        high_risk_areas: ["Không có thông tin về khu vực nguy hiểm"],
        impact_time: {
          start: translatedAlert.effective,
          peak: "Không xác định",
          end: translatedAlert.expires,
        },
        reliable_sources: ["Cơ quan khí tượng thủy văn"],
        emergency_contacts: ["112 - Cấp cứu", "114 - Cứu hỏa"],
      },
    };

    // Lưu vào database
    await saveToDatabase(Weather, {
      type: "notification_detail",
      source: "weatherapi+gemini",
      time: new Date(),
      longitude: lon || (locationData ? locationData[0].lon : null),
      latitude: lat || (locationData ? locationData[0].lat : null),
      city: cityName,
      location: location || `${lat},${lon}`,
      alertId,
      data: detailedAlert,
    });

    return res.json({
      message: "Weather notification detail retrieved successfully",
      data: detailedAlert,
    });
  } catch (error) {
    return handleError(res, error, "Weather Notification Detail");
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
  getSevenDayForecast,
  getWeatherHistory,
  getWeatherNotifications,
  subscribeToAlerts,
  unsubscribeFromAlerts,
  getWeatherNotificationDetail,
};
