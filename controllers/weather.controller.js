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
};

/**
 * Lấy thông tin thời tiết hiện tại
 */
const getCurrentWeather = async (req, res) => {
  try {
    const { location, lat, lon } = req.query;
    validateLocation(location);

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
      city: locationData ? locationData[0].name : location,
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
    validateLocation(location);
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
    validateLocation(location);
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
    validateLocation(location);

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
    validateLocation(location);

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
    validateLocation(location);

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
      type: "alerts",
      ...(lat && lon
        ? { latitude: lat, longitude: lon }
        : { city: locationData ? locationData[0].name : location }),
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
      city: locationData ? locationData[0].name : location,
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
    validateLocation(location);
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

      // Tạo prompt cho Gemini để dự đoán thêm 2 ngày
      const prompt = `Dựa trên dữ liệu thời tiết 5 ngày qua của ${cityName}, hãy dự đoán thời tiết cho 2 ngày tiếp theo (ngày 6 và 7). 
      Dữ liệu 5 ngày qua:
      ${JSON.stringify(processedData.forecast, null, 2)}
      
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
              "description": "mây rải rác"
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
              "description": "mưa nhẹ"
            }
          ],
          "wind": {
            "speed": 4.0,
            "deg": 190
          },
          "pop": 0.4
        }
      }

      Lưu ý:
      1. Chỉ cần dự đoán theo ngày, không cần theo mốc 3 giờ
      2. Các giá trị số phải là số thực, không phải chuỗi
      3. Các giá trị chuỗi phải được đặt trong dấu ngoặc kép
      4. Không thêm bất kỳ text nào khác ngoài JSON
      5. Dựa trên xu hướng thời tiết 5 ngày qua để dự đoán`;

      // Gọi Gemini API để dự đoán
      const geminiResponse = await model.generateContent(prompt);
      const geminiText = geminiResponse.response.text();
      console.log("Raw Gemini response:", geminiText);

      // Tìm JSON trong response
      const jsonMatch = geminiText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error("No JSON found in Gemini response");
        throw new Error("No valid JSON found in AI prediction response");
      }

      try {
        // Thử parse JSON
        const jsonStr = jsonMatch[0];
        console.log("Extracted JSON string:", jsonStr);

        const predictedData = JSON.parse(jsonStr);
        console.log("Parsed prediction data:", predictedData);

        // Validate dữ liệu
        if (!predictedData.day6 || !predictedData.day7) {
          throw new Error("Invalid prediction data structure");
        }

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

        // Thêm thông báo về dự đoán
        processedData.notice =
          "Dự báo 7 ngày bao gồm: 5 ngày từ OpenWeatherMap API và 2 ngày được dự đoán bởi AI.";
      } catch (parseError) {
        console.error("Error parsing Gemini response:", parseError);
        console.error("Raw response:", geminiText);
        throw new Error(
          "Invalid response format from AI prediction: " + parseError.message
        );
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
        message:
          "7-day forecast retrieved from OpenWeatherMap API and Gemini AI",
        data: processedData,
      });
    } catch (apiError) {
      console.error("API Error:", apiError.response?.data || apiError.message);
      if (apiError.response?.data?.message) {
        throw new Error(apiError.response.data.message);
      }
      throw new Error("Failed to fetch weather data");
    }
  } catch (error) {
    return handleError(res, error, "7-Day Forecast");
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
  getSevenDayForecast,
};
