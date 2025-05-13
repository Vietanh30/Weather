const Chat = require("../model/chat.model");
const { Weather, History, Astronomy } = require("../model/weather.model");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

// Constants
const WEATHER_API_BASE = "http://api.weatherapi.com/v1";
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const DEFAULT_LANG = "vi";
const API_KEY = process.env.WEATHERAPI_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY;

// API Endpoints
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

// Location search function
const searchLocation = async (query) => {
  try {
    console.log("Searching location:", query);
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
      console.log("No location found for:", query);
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
    if (error.response) {
      console.error("Geoapify API response:", error.response.data);
    }
    return [];
  }
};

// Question analysis function
const analyzeQuestion = async (question) => {
  try {
    const prompt = `Phân tích câu hỏi sau và trả về JSON với các thông tin:
    1. location: tên địa điểm (nếu có)
    2. time: thông tin thời gian (nếu có)
    3. type: loại thông tin thời tiết cần lấy (current, hourly, daily, range)
    4. details: các chi tiết bổ sung (nhiệt độ, mưa, gió, etc.)

    Câu hỏi: "${question}"

    Trả về JSON theo format:
    {
      "location": "string hoặc null",
      "time": {
        "type": "current/specific/range/hourly",
        "value": "giá trị cụ thể",
        "period": "morning/afternoon/evening/night hoặc null"
      },
      "type": "current/hourly/daily/range",
      "details": ["temperature", "rain", "wind", etc.]
    }`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const jsonMatch = response.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("Error analyzing question:", error);
    return manualAnalyzeQuestion(question);
  }
};

// Manual question analysis fallback
const manualAnalyzeQuestion = (question) => {
  const normalizedQuestion = question.toLowerCase();
  const analysis = {
    location: null,
    time: {
      type: "current",
      value: null,
      period: null,
    },
    type: "current",
    details: [],
  };

  // Time patterns
  const timePatterns = [
    { pattern: /(\d+)\s*giờ\s*sáng/i, period: "morning" },
    { pattern: /(\d+)\s*giờ\s*trưa/i, period: "noon" },
    { pattern: /(\d+)\s*giờ\s*chiều/i, period: "afternoon" },
    { pattern: /(\d+)\s*giờ\s*tối/i, period: "evening" },
    { pattern: /(\d+)\s*giờ\s*đêm/i, period: "night" },
    { pattern: /(\d+)\s*h/i, period: "current" },
  ];

  for (const { pattern, period } of timePatterns) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      analysis.time.type = "hourly";
      analysis.time.value = parseInt(match[1]);
      analysis.time.period = period;
      analysis.type = "hourly";
      break;
    }
  }

  // Date patterns
  const datePatterns = {
    "hôm nay": { type: "specific", value: "today" },
    "hôm qua": { type: "specific", value: "yesterday" },
    "ngày mai": { type: "specific", value: "tomorrow" },
    "ngày kia": { type: "specific", value: "day_after_tomorrow" },
    "ngày mốt": { type: "specific", value: "day_after_tomorrow" },
  };

  for (const [pattern, info] of Object.entries(datePatterns)) {
    if (normalizedQuestion.includes(pattern)) {
      if (analysis.time.type !== "hourly") {
        analysis.time.type = info.type;
        analysis.time.value = info.value;
      }
      break;
    }
  }

  // Range patterns
  const rangePatterns = [
    { pattern: /(\d+)\s*ngày\s*tới/i, type: "future" },
    { pattern: /(\d+)\s*ngày\s*sau/i, type: "future" },
    { pattern: /(\d+)\s*ngày\s*qua/i, type: "past" },
    { pattern: /(\d+)\s*ngày\s*trước/i, type: "past" },
  ];

  for (const { pattern, type } of rangePatterns) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      analysis.time.type = "range";
      analysis.time.value = parseInt(match[1]);
      analysis.time.rangeType = type;
      analysis.type = "range";
      break;
    }
  }

  return analysis;
};

// Weather data fetching function
const fetchWeatherData = async (location, analysis) => {
  const weatherData = {
    location: location || { name: "Unknown" },
    current: null,
    forecast: null,
    astronomy: null,
    future: null,
    marine: null,
    timezone: null,
    alerts: null,
    analysis,
    targetDate: new Date().toISOString().split("T")[0],
  };

  try {
    // Current weather
    const currentData = await callWeatherAPI(API_ENDPOINTS.current, {
      q: location ? `${location.lat},${location.lon}` : location.name,
      aqi: "yes",
    });
    weatherData.current = currentData.current;

    // Forecast
    const forecastData = await callWeatherAPI(API_ENDPOINTS.forecast, {
      q: location ? `${location.lat},${location.lon}` : location.name,
      days: analysis.type === "range" ? 3 : 3,
      hour: analysis.time.type === "hourly" ? analysis.time.value : undefined,
    });
    weatherData.forecast = forecastData.forecast;

    // Astronomy
    const astronomyData = await callWeatherAPI(API_ENDPOINTS.astronomy, {
      q: location ? `${location.lat},${location.lon}` : location.name,
      dt: weatherData.targetDate,
    });
    weatherData.astronomy = astronomyData.astronomy;

    // Future weather (if needed)
    const daysDiff = Math.ceil(
      (new Date(weatherData.targetDate) - new Date()) / (1000 * 60 * 60 * 24)
    );
    if (daysDiff > 14 && daysDiff <= 300) {
      const futureData = await callWeatherAPI(API_ENDPOINTS.future, {
        q: location ? `${location.lat},${location.lon}` : location.name,
        dt: weatherData.targetDate,
      });
      weatherData.future = futureData;
    }

    // Marine weather
    try {
      const marineData = await callWeatherAPI(API_ENDPOINTS.marine, {
        q: location ? `${location.lat},${location.lon}` : location.name,
        tides: "yes",
      });
      weatherData.marine = marineData;
    } catch (error) {
      console.error("Error fetching marine weather:", error.message);
    }

    // Timezone
    try {
      const timezoneData = await callWeatherAPI(API_ENDPOINTS.timezone, {
        q: location ? `${location.lat},${location.lon}` : location.name,
      });
      weatherData.timezone = timezoneData;
    } catch (error) {
      console.error("Error fetching timezone:", error.message);
    }

    // Weather alerts
    try {
      const alertsData = await callWeatherAPI(API_ENDPOINTS.alerts, {
        q: location ? `${location.lat},${location.lon}` : location.name,
      });
      weatherData.alerts = alertsData;
    } catch (error) {
      console.error("Error fetching weather alerts:", error.message);
    }

    return weatherData;
  } catch (error) {
    console.error("Error fetching weather data:", error);
    throw error;
  }
};

/**
 * Trích xuất thông tin thời gian từ câu hỏi
 * @param {string} question - Câu hỏi của người dùng
 * @returns {Object} - Thông tin thời gian
 */
const extractTimeInfo = (question) => {
  const normalizedQuestion = question.toLowerCase();
  const timeInfo = {
    type: "current", // current, specific, range, hourly
    date: null,
    startDate: null,
    endDate: null,
    days: 0,
    hour: null,
    period: null, // morning, afternoon, evening, night
  };

  // Kiểm tra thời gian cụ thể
  const timePatterns = [
    { pattern: /(\d+)\s*giờ\s*sáng/i, period: "morning" },
    { pattern: /(\d+)\s*giờ\s*trưa/i, period: "noon" },
    { pattern: /(\d+)\s*giờ\s*chiều/i, period: "afternoon" },
    { pattern: /(\d+)\s*giờ\s*tối/i, period: "evening" },
    { pattern: /(\d+)\s*giờ\s*đêm/i, period: "night" },
    { pattern: /(\d+)\s*h/i, period: "current" },
  ];

  for (const { pattern, period } of timePatterns) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      timeInfo.type = "hourly";
      timeInfo.hour = parseInt(match[1]);
      timeInfo.period = period;
      break;
    }
  }

  // Kiểm tra ngày cụ thể
  const datePatterns = {
    "hôm nay": 0,
    "hôm qua": -1,
    "ngày mai": 1,
    "ngày kia": 2,
    "ngày mốt": 2,
  };

  for (const [pattern, days] of Object.entries(datePatterns)) {
    if (normalizedQuestion.includes(pattern)) {
      timeInfo.type = timeInfo.type === "hourly" ? "hourly" : "specific";
      timeInfo.days = days;
      return timeInfo;
    }
  }

  // Kiểm tra khoảng thời gian
  const rangePatterns = [
    { pattern: /(\d+)\s*ngày\s*tới/i, type: "future" },
    { pattern: /(\d+)\s*ngày\s*sau/i, type: "future" },
    { pattern: /(\d+)\s*ngày\s*qua/i, type: "past" },
    { pattern: /(\d+)\s*ngày\s*trước/i, type: "past" },
  ];

  for (const { pattern, type } of rangePatterns) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      timeInfo.type = "range";
      timeInfo.days = parseInt(match[1]);
      timeInfo.rangeType = type;
      return timeInfo;
    }
  }

  // Kiểm tra ngày cụ thể trong tuần
  const weekDays = {
    "thứ hai": 1,
    "thứ 2": 1,
    "thứ ba": 2,
    "thứ 3": 2,
    "thứ tư": 3,
    "thứ 4": 3,
    "thứ năm": 4,
    "thứ 5": 4,
    "thứ sáu": 5,
    "thứ 6": 5,
    "thứ bảy": 6,
    "thứ 7": 6,
    "chủ nhật": 0,
    cn: 0,
  };

  for (const [day, value] of Object.entries(weekDays)) {
    if (normalizedQuestion.includes(day)) {
      timeInfo.type = timeInfo.type === "hourly" ? "hourly" : "weekday";
      timeInfo.weekday = value;
      return timeInfo;
    }
  }

  return timeInfo;
};

/**
 * Tạo prompt cho Gemini
 * @param {string} question - Câu hỏi của người dùng
 * @param {Object} weatherData - Dữ liệu thời tiết
 * @returns {string} - Prompt cho Gemini
 */
const createPrompt = (question, weatherData) => {
  let prompt = `Bạn là một trợ lý thời tiết. Hãy trả lời câu hỏi của người dùng một cách ngắn gọn và đúng trọng tâm, dựa trên dữ liệu thời tiết sau:\n\n`;

  if (weatherData) {
    // Thông tin địa điểm
    prompt += `Địa điểm: ${weatherData.location.name}\n\n`;

    // Thông tin thời tiết hiện tại
    if (weatherData.current) {
      prompt += `Thời tiết hiện tại:\n`;
      prompt += `- Nhiệt độ: ${weatherData.current.temp_c}°C\n`;
      prompt += `- Trạng thái: ${weatherData.current.condition.text}\n`;
      prompt += `- Gió: ${weatherData.current.wind_kph} km/h\n`;
      if (weatherData.current.air_quality) {
        prompt += `- Chất lượng không khí: ${weatherData.current.air_quality["us-epa-index"]}/6\n`;
      }
      prompt += "\n";
    }

    // Thông tin dự báo
    if (weatherData.forecast && weatherData.analysis) {
      const { time } = weatherData.analysis;

      if (time.type === "hourly") {
        const targetDay = weatherData.forecast.forecastday.find(
          (day) => day.date === weatherData.targetDate
        );
        if (targetDay && targetDay.hour) {
          const hourData = targetDay.hour[time.value];
          if (hourData) {
            prompt += `Thời tiết ${time.value}${
              time.period === "morning"
                ? " giờ sáng"
                : time.period === "afternoon"
                ? " giờ chiều"
                : time.period === "evening"
                ? " giờ tối"
                : time.period === "night"
                ? " giờ đêm"
                : " giờ"
            }:\n`;
            prompt += `- Nhiệt độ: ${hourData.temp_c}°C\n`;
            prompt += `- Trạng thái: ${hourData.condition.text}\n`;
            prompt += `- Gió: ${hourData.wind_kph} km/h\n`;
            prompt += `- Mưa: ${hourData.chance_of_rain}%\n`;
            prompt += "\n";
          }
        }
      } else if (time.type === "specific") {
        const targetDay = weatherData.forecast.forecastday.find(
          (day) => day.date === weatherData.targetDate
        );
        if (targetDay) {
          prompt += `Thời tiết ${
            time.value === "today"
              ? "hôm nay"
              : time.value === "tomorrow"
              ? "ngày mai"
              : time.value === "yesterday"
              ? "hôm qua"
              : "ngày kia"
          }:\n`;
          prompt += `- Nhiệt độ: ${targetDay.day.avgtemp_c}°C\n`;
          prompt += `- Trạng thái: ${targetDay.day.condition.text}\n`;
          prompt += `- Mưa: ${targetDay.day.daily_chance_of_rain}%\n`;
          prompt += "\n";
        }
      } else if (time.type === "range") {
        prompt += `Dự báo ${time.value} ngày ${
          time.rangeType === "future" ? "tới" : "qua"
        }:\n`;
        weatherData.forecast.forecastday.forEach((day) => {
          prompt += `${day.date}:\n`;
          prompt += `- Nhiệt độ: ${day.day.avgtemp_c}°C\n`;
          prompt += `- Trạng thái: ${day.day.condition.text}\n`;
          prompt += `- Mưa: ${day.day.daily_chance_of_rain}%\n`;
        });
        prompt += "\n";
      }
    }

    // Thông tin thời tiết tương lai (14-300 ngày)
    if (weatherData.future) {
      prompt += `Dự báo thời tiết tương lai (${weatherData.targetDate}):\n`;
      prompt += `- Nhiệt độ: ${weatherData.future.forecast.forecastday[0].day.avgtemp_c}°C\n`;
      prompt += `- Trạng thái: ${weatherData.future.forecast.forecastday[0].day.condition.text}\n`;
      prompt += `- Mưa: ${weatherData.future.forecast.forecastday[0].day.daily_chance_of_rain}%\n`;
      prompt += "\n";
    }

    // Thông tin thời tiết biển
    if (weatherData.marine) {
      prompt += `Thông tin thời tiết biển:\n`;
      if (weatherData.marine.forecast.forecastday[0].hour) {
        const marineData = weatherData.marine.forecast.forecastday[0].hour[0];
        prompt += `- Nhiệt độ nước: ${marineData.water_temp_c}°C\n`;
        prompt += `- Sóng: ${marineData.wave_height_m}m\n`;
        prompt += `- Hướng sóng: ${marineData.wave_direction}\n`;
        if (marineData.tide) {
          prompt += `- Thủy triều: ${marineData.tide.tide_type}\n`;
        }
      }
      prompt += "\n";
    }

    // Thông tin thiên văn
    if (weatherData.astronomy) {
      prompt += `Thông tin thiên văn:\n`;
      prompt += `- Mặt trời mọc: ${weatherData.astronomy.astro.sunrise}\n`;
      prompt += `- Mặt trời lặn: ${weatherData.astronomy.astro.sunset}\n`;
      prompt += `- Mặt trăng mọc: ${weatherData.astronomy.astro.moonrise}\n`;
      prompt += `- Mặt trăng lặn: ${weatherData.astronomy.astro.moonset}\n`;
      prompt += `- Pha mặt trăng: ${weatherData.astronomy.astro.moon_phase}\n`;
      prompt += `- Độ sáng mặt trăng: ${weatherData.astronomy.astro.moon_illumination}%\n`;
      prompt += "\n";
    }

    // Thông tin múi giờ
    if (weatherData.timezone) {
      prompt += `Thông tin múi giờ:\n`;
      prompt += `- Múi giờ: ${weatherData.timezone.location.tz_id}\n`;
      prompt += `- Giờ địa phương: ${weatherData.timezone.location.localtime}\n`;
      prompt += "\n";
    }

    // Thông tin cảnh báo thời tiết
    if (weatherData.alerts && weatherData.alerts.alert) {
      prompt += `Cảnh báo thời tiết:\n`;
      weatherData.alerts.alert.forEach((alert) => {
        prompt += `- ${alert.headline}\n`;
        prompt += `  ${alert.msg}\n`;
      });
      prompt += "\n";
    }

    // Thông tin sự kiện thể thao
    if (weatherData.sports && weatherData.sports.football) {
      prompt += `Sự kiện thể thao:\n`;
      weatherData.sports.football.forEach((event) => {
        prompt += `- ${event.tournament}: ${event.match}\n`;
        prompt += `  Thời gian: ${event.start}\n`;
        prompt += `  Địa điểm: ${event.stadium}, ${event.country}\n`;
      });
      prompt += "\n";
    }
  }

  prompt += `Câu hỏi của người dùng: ${question}\n\n`;
  prompt += `Hãy trả lời ngắn gọn, tập trung vào thông tin quan trọng nhất. Nếu có thể, hãy thêm một lời khuyên ngắn gọn liên quan đến thời tiết.`;

  return prompt;
};

/**
 * Tìm kiếm thành phố trong câu hỏi
 * @param {string} question - Câu hỏi của người dùng
 * @returns {Promise<Object|null>} - Thông tin địa điểm nếu tìm thấy
 */
const extractLocation = async (question) => {
  // Danh sách các thành phố phổ biến ở Việt Nam
  const cities = [
    "hà nội",
    "hồ chí minh",
    "đà nẵng",
    "hải phòng",
    "cần thơ",
    "huế",
    "nha trang",
    "buôn ma thuột",
    "đà lạt",
    "vũng tàu",
  ];

  const words = question.toLowerCase().split(" ");
  for (const city of cities) {
    if (words.includes(city)) {
      console.log("Found city in question:", city);
      // Tìm kiếm thông tin chi tiết của thành phố
      const results = await searchLocation(city);
      if (results.length > 0) {
        console.log("Found location details:", results[0]);
        return results[0];
      }
    }
  }
  console.log("No city found in question");
  return null;
};

/**
 * Lấy thông tin thời tiết tương lai (14-300 ngày)
 * @param {string} location - Địa điểm
 * @param {string} date - Ngày cần xem (yyyy-MM-dd)
 * @returns {Promise<Object>} - Dữ liệu thời tiết tương lai
 */
const getFutureWeather = async (location, date) => {
  try {
    const response = await axios.get(API_ENDPOINTS.future, {
      params: {
        key: API_KEY,
        q: location,
        dt: date,
        lang: "vi",
        aqi: "yes",
      },
      retry: 3,
      retryDelay: 1000,
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching future weather:", error.message);
    return null;
  }
};

/**
 * Lấy thông tin thời tiết biển
 * @param {string} location - Địa điểm
 * @returns {Promise<Object>} - Dữ liệu thời tiết biển
 */
const getMarineWeather = async (location) => {
  try {
    const response = await axios.get(API_ENDPOINTS.marine, {
      params: {
        key: API_KEY,
        q: location,
        lang: "vi",
        tides: "yes",
      },
      retry: 3,
      retryDelay: 1000,
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching marine weather:", error.message);
    return null;
  }
};

/**
 * Lấy thông tin múi giờ
 * @param {string} location - Địa điểm
 * @returns {Promise<Object>} - Dữ liệu múi giờ
 */
const getTimeZone = async (location) => {
  try {
    const response = await axios.get(API_ENDPOINTS.timezone, {
      params: {
        key: API_KEY,
        q: location,
      },
      retry: 3,
      retryDelay: 1000,
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching timezone:", error.message);
    return null;
  }
};

/**
 * Lấy thông tin cảnh báo thời tiết
 * @param {string} location - Địa điểm
 * @returns {Promise<Object>} - Dữ liệu cảnh báo
 */
const getWeatherAlerts = async (location) => {
  try {
    const response = await axios.get(API_ENDPOINTS.alerts, {
      params: {
        key: API_KEY,
        q: location,
        lang: "vi",
      },
      retry: 3,
      retryDelay: 1000,
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching weather alerts:", error.message);
    return null;
  }
};

/**
 * Lấy thông tin sự kiện thể thao
 * @param {string} location - Địa điểm
 * @returns {Promise<Object>} - Dữ liệu sự kiện thể thao
 */
const getSportsEvents = async (location) => {
  try {
    const response = await axios.get(API_ENDPOINTS.sports, {
      params: {
        key: API_KEY,
        q: location,
      },
      retry: 3,
      retryDelay: 1000,
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching sports events:", error.message);
    return null;
  }
};

/**
 * Xử lý câu hỏi về thời tiết
 * @param {string} question - Câu hỏi của người dùng
 * @param {string} city - Tên thành phố (nếu có)
 * @returns {Promise<Object>} - Câu trả lời và dữ liệu thời tiết
 */
const processWeatherQuestion = async (question, city) => {
  console.log("Processing question:", question, "for city:", city);

  try {
    // Phân tích câu hỏi bằng Gemini
    const analysis = await analyzeQuestion(question);
    console.log("Question analysis:", analysis);

    // Xác định địa điểm
    let location = null;
    if (!city && analysis.location) {
      const results = await searchLocation(analysis.location);
      if (results.length > 0) {
        location = results[0];
        city = location.name;
      }
    } else if (city) {
      const results = await searchLocation(city);
      if (results.length > 0) {
        location = results[0];
        city = location.name;
      }
    }

    if (!location && !city) {
      return {
        answer:
          "Xin lỗi, tôi không biết bạn đang hỏi về địa điểm nào. Vui lòng chỉ định tên thành phố hoặc địa điểm cụ thể.",
        weatherData: null,
      };
    }

    // Tính toán thời gian
    const today = new Date();
    let targetDate = new Date(today);

    if (analysis.time.type === "specific") {
      if (analysis.time.value === "tomorrow") {
        targetDate.setDate(today.getDate() + 1);
      } else if (analysis.time.value === "yesterday") {
        targetDate.setDate(today.getDate() - 1);
      } else if (analysis.time.value === "today") {
        // Giữ nguyên ngày hiện tại
      } else {
        const dateMatch = analysis.time.value.match(/(\d+)/);
        if (dateMatch) {
          const days = parseInt(dateMatch[1]);
          targetDate.setDate(today.getDate() + days);
        }
      }
    }

    // Lấy dữ liệu thời tiết với error handling riêng cho từng request
    let currentData = null;
    let forecastData = null;
    let astronomyData = null;
    let futureData = null;
    let marineData = null;
    let timezoneData = null;
    let alertsData = null;

    // Lấy thông tin thời tiết hiện tại
    try {
      const response = await axios.get(API_ENDPOINTS.current, {
        params: {
          key: API_KEY,
          q: location ? `${location.lat},${location.lon}` : city,
          lang: "vi",
          aqi: "yes",
        },
      });
      currentData = response.data;
    } catch (error) {
      console.error("Error fetching current weather:", error.message);
    }

    // Lấy thông tin dự báo
    try {
      const response = await axios.get(API_ENDPOINTS.forecast, {
        params: {
          key: API_KEY,
          q: location ? `${location.lat},${location.lon}` : city,
          days: analysis.type === "range" ? 3 : 3,
          lang: "vi",
          hour:
            analysis.time.type === "hourly" ? analysis.time.value : undefined,
        },
      });
      forecastData = response.data;
    } catch (error) {
      console.error("Error fetching forecast:", error.message);
    }

    // Lấy thông tin thiên văn
    try {
      const response = await axios.get(API_ENDPOINTS.astronomy, {
        params: {
          key: API_KEY,
          q: location ? `${location.lat},${location.lon}` : city,
          dt: targetDate.toISOString().split("T")[0],
          lang: "vi",
        },
      });
      astronomyData = response.data;
    } catch (error) {
      console.error("Error fetching astronomy data:", error.message);
    }

    // Lấy thông tin thời tiết tương lai nếu ngày yêu cầu > 14 ngày
    const daysDiff = Math.ceil((targetDate - today) / (1000 * 60 * 60 * 24));
    if (daysDiff > 14 && daysDiff <= 300) {
      try {
        const response = await axios.get(API_ENDPOINTS.future, {
          params: {
            key: API_KEY,
            q: location ? `${location.lat},${location.lon}` : city,
            dt: targetDate.toISOString().split("T")[0],
            lang: "vi",
          },
        });
        futureData = response.data;
      } catch (error) {
        console.error("Error fetching future weather:", error.message);
      }
    }

    // Lấy thông tin thời tiết biển nếu là vùng ven biển
    try {
      const response = await axios.get(API_ENDPOINTS.marine, {
        params: {
          key: API_KEY,
          q: location ? `${location.lat},${location.lon}` : city,
          tides: "yes",
          lang: "vi",
        },
      });
      marineData = response.data;
    } catch (error) {
      console.error("Error fetching marine weather:", error.message);
    }

    // Lấy thông tin múi giờ
    try {
      const response = await axios.get(API_ENDPOINTS.timezone, {
        params: {
          key: API_KEY,
          q: location ? `${location.lat},${location.lon}` : city,
        },
      });
      timezoneData = response.data;
    } catch (error) {
      console.error("Error fetching timezone:", error.message);
    }

    // Lấy thông tin cảnh báo thời tiết
    try {
      const response = await axios.get(API_ENDPOINTS.alerts, {
        params: {
          key: API_KEY,
          q: location ? `${location.lat},${location.lon}` : city,
          lang: "vi",
        },
      });
      alertsData = response.data;
    } catch (error) {
      console.error("Error fetching weather alerts:", error.message);
    }

    // Kiểm tra xem có đủ dữ liệu để trả lời không
    if (!currentData && !forecastData && !futureData) {
      return {
        answer:
          "Xin lỗi, hiện tại không thể lấy được thông tin thời tiết. Vui lòng thử lại sau.",
        weatherData: null,
      };
    }

    // Kết hợp dữ liệu thời tiết
    const weatherData = {
      location: location || { name: city },
      current: currentData?.current || null,
      forecast: forecastData?.forecast || null,
      astronomy: astronomyData?.astronomy || null,
      future: futureData || null,
      marine: marineData || null,
      timezone: timezoneData || null,
      alerts: alertsData || null,
      analysis: analysis,
      targetDate: targetDate.toISOString().split("T")[0],
    };

    // Tạo prompt cho Gemini với fallback mechanism
    let answer;
    try {
      const prompt = createPrompt(question, weatherData);
      console.log("Generated prompt for Gemini");

      const result = await model.generateContent(prompt);
      answer = result.response.text();
      console.log("Received answer from Gemini");
    } catch (error) {
      console.error("Error generating answer with Gemini:", error);
      answer = generateFallbackAnswer(question, weatherData);
    }

    return { answer, weatherData };
  } catch (error) {
    console.error("Error processing weather question:", error);
    return {
      answer:
        "Xin lỗi, có lỗi xảy ra khi xử lý câu hỏi của bạn. Vui lòng thử lại sau.",
      weatherData: null,
    };
  }
};

// Hàm tạo câu trả lời đơn giản khi Gemini không hoạt động
const generateFallbackAnswer = (question, weatherData) => {
  if (!weatherData) return "Xin lỗi, không thể lấy được thông tin thời tiết.";

  const { current, forecast, analysis } = weatherData;
  let answer = "";

  if (current) {
    answer += `Thời tiết hiện tại tại ${weatherData.location.name}: ${current.temp_c}°C, ${current.condition.text}. `;
  }

  if (forecast && forecast.forecastday && forecast.forecastday.length > 0) {
    const today = forecast.forecastday[0];
    answer += `Dự báo ngày mai: ${today.day.avgtemp_c}°C, ${today.day.condition.text}. `;
  }

  if (analysis.time.type === "hourly" && forecast) {
    const targetDay = forecast.forecastday.find(
      (day) => day.date === weatherData.targetDate
    );
    if (targetDay && targetDay.hour) {
      const hourData = targetDay.hour[analysis.time.value];
      if (hourData) {
        answer += `Thời tiết lúc ${analysis.time.value} giờ: ${hourData.temp_c}°C, ${hourData.condition.text}. `;
      }
    }
  }

  return answer || "Xin lỗi, không thể tạo câu trả lời phù hợp.";
};

/**
 * Xử lý chat
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const handleChat = async (req, res) => {
  const { question, city, sessionId } = req.body;

  if (!question) {
    return res.status(400).json({
      error: "Question is required",
      message: "Vui lòng nhập câu hỏi của bạn.",
    });
  }

  try {
    // Xử lý câu hỏi
    const { answer, weatherData } = await processWeatherQuestion(
      question,
      city
    );

    // Lưu vào database
    const chat = await Chat.create({
      question,
      answer,
      weatherData,
      sessionId: sessionId || Date.now().toString(),
    });

    return res.json({
      message: "Chat processed successfully",
      data: chat,
    });
  } catch (error) {
    console.error("Chat Error:", error);
    return res.status(500).json({
      error: error.message,
      message: "Có lỗi xảy ra khi xử lý câu hỏi của bạn. Vui lòng thử lại sau.",
      details: error,
    });
  }
};

/**
 * Lấy lịch sử chat
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const getChatHistory = async (req, res) => {
  const { sessionId } = req.query;

  if (!sessionId) {
    return res.status(400).json({
      error: "Session ID is required",
      message: "Vui lòng cung cấp ID phiên chat.",
    });
  }

  try {
    const history = await Chat.find({ sessionId })
      .sort({ timestamp: -1 })
      .limit(50);

    return res.json({
      message: "Chat history retrieved successfully",
      data: history,
    });
  } catch (error) {
    console.error("Get Chat History Error:", error);
    return res.status(500).json({
      error: error.message,
      message: "Có lỗi xảy ra khi lấy lịch sử chat. Vui lòng thử lại sau.",
      details: error,
    });
  }
};

module.exports = {
  handleChat,
  getChatHistory,
};
