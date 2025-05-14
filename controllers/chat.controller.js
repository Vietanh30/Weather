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

// Initialize Gemini with retry logic
const initGemini = () => {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    return genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
      },
    });
  } catch (error) {
    console.error("Error initializing Gemini:", error);
    return null;
  }
};

const model = initGemini();

// Add retry logic for Gemini API calls
const generateWithRetry = async (prompt, maxRetries = 3) => {
  let lastError = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      if (!model) {
        throw new Error("Gemini model not initialized");
      }

      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error(`Gemini API attempt ${i + 1} failed:`, error);
      lastError = error;

      // Wait before retrying (exponential backoff)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, i) * 1000)
      );

      // Try to reinitialize model on error
      if (i === maxRetries - 1) {
        const newModel = initGemini();
        if (newModel) {
          model = newModel;
        }
      }
    }
  }

  throw lastError;
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
    3. type: loại thông tin thời tiết cần lấy (current, forecast, history, future, marine, astronomy, timezone, alerts)
    4. details: các chi tiết bổ sung (nhiệt độ, mưa, gió, etc.)

    Câu hỏi: "${question}"

    Trả về JSON theo format:
    {
      "location": "string hoặc null",
      "time": {
        "type": "current/specific/range/hourly/history",
        "value": "giá trị cụ thể",
        "period": "morning/afternoon/evening/night hoặc null",
        "isHistory": true/false
      },
      "type": "current/forecast/history/future/marine/astronomy/timezone/alerts",
      "details": ["temperature", "rain", "wind", etc.]
    }`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const jsonMatch = response.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const analysis = JSON.parse(jsonMatch[0]);

    // Đảm bảo type là một trong các giá trị cho phép
    const validTypes = [
      "current",
      "forecast",
      "history",
      "future",
      "marine",
      "astronomy",
      "timezone",
      "alerts",
    ];

    if (!validTypes.includes(analysis.type)) {
      // Nếu type không hợp lệ, chuyển đổi dựa trên context
      if (analysis.time?.isHistory) {
        analysis.type = "history";
      } else if (
        analysis.time?.type === "range" ||
        analysis.time?.type === "future"
      ) {
        analysis.type = "forecast";
      } else {
        analysis.type = "current";
      }
    }

    return analysis;
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
      isHistory: false,
    },
    type: "current",
    details: [],
  };

  // Kiểm tra câu hỏi về lịch sử
  const historyPatterns = [
    /thời tiết\s+(\d+)\s+ngày\s+trước/i,
    /thời tiết\s+hôm\s+qua/i,
    /thời tiết\s+(\d+)\s+ngày\s+qua/i,
    /thời tiết\s+ngày\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
  ];

  for (const pattern of historyPatterns) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      analysis.time.type = "history";
      analysis.type = "history";
      analysis.time.isHistory = true;

      if (match[1]) {
        const daysAgo = parseInt(match[1]);
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        analysis.time.value = date.toISOString().split("T")[0];
      } else if (match[0].includes("hôm qua")) {
        const date = new Date();
        date.setDate(date.getDate() - 1);
        analysis.time.value = date.toISOString().split("T")[0];
      } else if (match[1] && match[2] && match[3]) {
        analysis.time.value = `${match[3]}-${match[2].padStart(
          2,
          "0"
        )}-${match[1].padStart(2, "0")}`;
      }
      break;
    }
  }

  // Kiểm tra các loại câu hỏi khác
  if (
    normalizedQuestion.includes("dự báo") ||
    normalizedQuestion.includes("ngày mai") ||
    normalizedQuestion.includes("tuần tới")
  ) {
    analysis.type = "forecast";
  } else if (
    normalizedQuestion.includes("biển") ||
    normalizedQuestion.includes("sóng")
  ) {
    analysis.type = "marine";
  } else if (
    normalizedQuestion.includes("mặt trời") ||
    normalizedQuestion.includes("mặt trăng")
  ) {
    analysis.type = "astronomy";
  } else if (
    normalizedQuestion.includes("cảnh báo") ||
    normalizedQuestion.includes("bão")
  ) {
    analysis.type = "alerts";
  } else if (
    normalizedQuestion.includes("múi giờ") ||
    normalizedQuestion.includes("giờ địa phương")
  ) {
    analysis.type = "timezone";
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
  console.log("weatherData", weatherData);

  // Kiểm tra xem có dữ liệu thời tiết không
  const hasWeatherData =
    weatherData &&
    (weatherData.current?.current ||
      weatherData.forecast?.forecast?.forecastday ||
      weatherData.history?.forecast?.forecastday ||
      weatherData.history?.forecastday ||
      weatherData.future);

  if (!hasWeatherData) {
    return `Bạn là một trợ lý thời tiết. Hãy trả lời câu hỏi của người dùng một cách ngắn gọn và tự nhiên.

Câu hỏi của người dùng: ${question}

Vì hiện tại không có dữ liệu thời tiết, bạn cần thực hiện các bước sau để trả lời câu hỏi:

1. Truy cập và đọc thông tin từ các nguồn dự báo thời tiết uy tín:
   - Trung tâm Khí tượng Thủy văn Quốc gia (nchmf.gov.vn)
   - AccuWeather (accuweather.com)
   - Weather Underground (wunderground.com)
   - The Weather Channel (weather.com)
   - OpenWeatherMap (openweathermap.org)

2. Sau khi đọc thông tin từ các nguồn trên:
   - Tổng hợp thông tin từ các nguồn
   - So sánh và phân tích sự khác biệt nếu có
   - Đưa ra câu trả lời chính xác nhất

3. Trả lời theo format sau:
   - Thông tin chính: nhiệt độ và trạng thái thời tiết
   - Chi tiết bổ sung: gió, mưa, độ ẩm nếu cần
   - Lời khuyên: nếu có

Lưu ý: 
- KHÔNG sử dụng các ký tự đặc biệt như **, [], () trong câu trả lời
- KHÔNG trả lời "không có dữ liệu" hoặc "đang tìm kiếm thông tin"
- Trả lời một cách tự nhiên như đang nói chuyện với người dùng`;
  }

  let prompt = `Bạn là một trợ lý thời tiết. Hãy trả lời câu hỏi của người dùng một cách ngắn gọn và tự nhiên, dựa trên dữ liệu thời tiết sau:\n\n`;

  // Thông tin địa điểm
  if (weatherData.location) {
    prompt += `Địa điểm: ${
      weatherData.location.name || weatherData.location
    }\n\n`;
  }

  // Thông tin thời tiết hiện tại
  if (weatherData.current?.current) {
    const current = weatherData.current.current;
    prompt += `Thời tiết hiện tại (${current.last_updated}):\n`;
    prompt += `- Nhiệt độ: ${current.temp_c || "N/A"}°C (cảm giác như ${
      current.feelslike_c || "N/A"
    }°C)\n`;
    prompt += `- Trạng thái: ${current.condition?.text || "N/A"}\n`;
    prompt += `- Gió: ${current.wind_kph || "N/A"} km/h (${
      current.wind_dir || "N/A"
    })\n`;
    prompt += `- Độ ẩm: ${current.humidity || "N/A"}%\n`;
    prompt += `- Lượng mưa: ${current.precip_mm || "N/A"} mm\n`;
    prompt += `- Tầm nhìn: ${current.vis_km || "N/A"} km\n`;
    if (current.air_quality) {
      prompt += `- Chất lượng không khí: ${
        current.air_quality["us-epa-index"] || "N/A"
      }/6\n`;
    }
    prompt += "\n";
  }

  // Thông tin dự báo
  if (weatherData.forecast?.forecast?.forecastday) {
    const forecastDays = weatherData.forecast.forecast.forecastday;
    prompt += `Dự báo thời tiết:\n`;

    forecastDays.forEach((day) => {
      prompt += `Ngày ${day.date}:\n`;
      prompt += `- Nhiệt độ: ${day.day.avgtemp_c || "N/A"}°C (cao nhất: ${
        day.day.maxtemp_c || "N/A"
      }°C, thấp nhất: ${day.day.mintemp_c || "N/A"}°C)\n`;
      prompt += `- Trạng thái: ${day.day.condition?.text || "N/A"}\n`;
      prompt += `- Lượng mưa: ${day.day.totalprecip_mm || "N/A"} mm\n`;
      prompt += `- Độ ẩm: ${day.day.avghumidity || "N/A"}%\n`;
      prompt += `- Gió: ${day.day.maxwind_kph || "N/A"} km/h\n\n`;
    });
  }

  // Thông tin lịch sử thời tiết
  if (weatherData.history) {
    const historyData =
      weatherData.history.forecast?.forecastday ||
      weatherData.history.forecastday;
    if (historyData && historyData.length > 0) {
      const historyDay = historyData[0];
      prompt += `Thời tiết ngày ${historyDay.date}:\n`;
      prompt += `- Nhiệt độ trung bình: ${
        historyDay.day?.avgtemp_c || historyDay.avgtemp_c || "N/A"
      }°C\n`;
      prompt += `- Nhiệt độ cao nhất: ${
        historyDay.day?.maxtemp_c || historyDay.maxtemp_c || "N/A"
      }°C\n`;
      prompt += `- Nhiệt độ thấp nhất: ${
        historyDay.day?.mintemp_c || historyDay.mintemp_c || "N/A"
      }°C\n`;
      prompt += `- Trạng thái: ${
        historyDay.day?.condition?.text || historyDay.condition?.text || "N/A"
      }\n`;
      prompt += `- Lượng mưa: ${
        historyDay.day?.totalprecip_mm || historyDay.totalprecip_mm || "N/A"
      } mm\n`;
      prompt += `- Độ ẩm: ${
        historyDay.day?.avghumidity || historyDay.avghumidity || "N/A"
      }%\n`;
      prompt += `- Gió: ${
        historyDay.day?.maxwind_kph || historyDay.maxwind_kph || "N/A"
      } km/h\n\n`;
    }
  }

  // Thông tin thiên văn
  if (weatherData.astronomy?.astronomy?.astro) {
    const astro = weatherData.astronomy.astronomy.astro;
    prompt += `Thông tin thiên văn:\n`;
    prompt += `- Mặt trời mọc: ${astro.sunrise || "N/A"}\n`;
    prompt += `- Mặt trời lặn: ${astro.sunset || "N/A"}\n`;
    prompt += `- Mặt trăng mọc: ${astro.moonrise || "N/A"}\n`;
    prompt += `- Mặt trăng lặn: ${astro.moonset || "N/A"}\n`;
    prompt += `- Pha mặt trăng: ${astro.moon_phase || "N/A"}\n\n`;
  }

  // Thông tin cảnh báo
  if (weatherData.alerts?.alerts?.alert?.length > 0) {
    prompt += `Cảnh báo thời tiết:\n`;
    weatherData.alerts.alerts.alert.forEach((alert) => {
      prompt += `- ${alert.headline || "N/A"}\n`;
      prompt += `  ${alert.msgtype || "N/A"}: ${alert.severity || "N/A"}\n`;
      prompt += `  ${alert.desc || "N/A"}\n\n`;
    });
  }

  prompt += `Câu hỏi của người dùng: ${question}\n\n`;
  prompt += `Hãy trả lời ngắn gọn và tự nhiên, không sử dụng các ký tự đặc biệt như **, [], (). Chỉ tập trung vào thông tin cần thiết để trả lời câu hỏi.`;

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
 * @param {string} sessionId - ID phiên chat
 * @returns {Promise<Object>} - Câu trả lời và dữ liệu thời tiết
 */
const processWeatherQuestion = async (question, city, sessionId) => {
  console.log("Processing question:", question, "for city:", city);

  try {
    // Phân tích câu hỏi
    const analysis = await analyzeQuestion(question);
    console.log("Question analysis:", analysis);

    // Xác định địa điểm - ưu tiên location từ analysis trước
    let location = null;
    if (analysis.location) {
      const results = await searchLocation(analysis.location);
      if (results.length > 0) {
        location = results[0];
        city = location.name;
      }
    } else if (city) {
      // Nếu không có location trong analysis thì mới dùng city
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

    // Lấy dữ liệu thời tiết
    let weatherData = {
      location: location || { name: city },
      current: null,
      forecast: null,
      history: null,
      astronomy: null,
      future: null,
      marine: null,
      timezone: null,
      alerts: null,
      analysis,
      targetDate: analysis.time.value || new Date().toISOString().split("T")[0],
    };

    // Xử lý lịch sử thời tiết
    if (analysis.time.isHistory) {
      try {
        // Chuyển đổi ngày tương đối thành ngày thực tế
        let targetDate = analysis.time.value;
        if (targetDate === "hôm qua") {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          targetDate = yesterday.toISOString().split("T")[0];
        } else if (targetDate === "hôm kia") {
          const dayBeforeYesterday = new Date();
          dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
          targetDate = dayBeforeYesterday.toISOString().split("T")[0];
        } else if (
          typeof targetDate === "string" &&
          targetDate.includes("ngày")
        ) {
          const days = parseInt(targetDate.match(/\d+/)[0]);
          const pastDate = new Date();
          pastDate.setDate(pastDate.getDate() - days);
          targetDate = pastDate.toISOString().split("T")[0];
        }

        console.log("Fetching weather history for date:", targetDate);
        const response = await axios.get(API_ENDPOINTS.history, {
          params: {
            key: API_KEY,
            q: location ? `${location.lat},${location.lon}` : city,
            dt: targetDate,
            lang: "vi",
            aqi: "yes",
          },
        });
        weatherData.history = response.data;
        weatherData.targetDate = targetDate; // Cập nhật targetDate với ngày thực tế
      } catch (error) {
        console.error("Error fetching weather history:", error.message);
        if (error.response) {
          console.error("API Error Response:", error.response.data);
        }
      }
    }

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
      weatherData.current = response.data;
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
      weatherData.forecast = response.data;
    } catch (error) {
      console.error("Error fetching forecast:", error.message);
    }

    // Lấy thông tin thiên văn
    try {
      const response = await axios.get(API_ENDPOINTS.astronomy, {
        params: {
          key: API_KEY,
          q: location ? `${location.lat},${location.lon}` : city,
          dt: weatherData.targetDate,
          lang: "vi",
        },
      });
      weatherData.astronomy = response.data;
    } catch (error) {
      console.error("Error fetching astronomy data:", error.message);
    }

    // Lấy thông tin thời tiết tương lai nếu ngày yêu cầu > 14 ngày
    const daysDiff = Math.ceil(
      (weatherData.targetDate - new Date()) / (1000 * 60 * 60 * 24)
    );
    if (daysDiff > 14 && daysDiff <= 300) {
      try {
        const response = await axios.get(API_ENDPOINTS.future, {
          params: {
            key: API_KEY,
            q: location ? `${location.lat},${location.lon}` : city,
            dt: weatherData.targetDate,
            lang: "vi",
          },
        });
        weatherData.future = response.data;
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
      weatherData.marine = response.data;
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
      weatherData.timezone = response.data;
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
      weatherData.alerts = response.data;
    } catch (error) {
      console.error("Error fetching weather alerts:", error.message);
    }

    // Kiểm tra xem có đủ dữ liệu để trả lời không
    if (!weatherData.current && !weatherData.forecast && !weatherData.future) {
      return {
        answer:
          "Xin lỗi, hiện tại không thể lấy được thông tin thời tiết. Vui lòng thử lại sau.",
        weatherData: null,
      };
    }

    // Tạo prompt cho Gemini với thông tin lịch sử
    let answer;
    try {
      const prompt = createPrompt(question, weatherData);
      console.log("Generated prompt for Gemini");

      answer = await generateWithRetry(prompt);
      console.log("Received answer from Gemini");
    } catch (error) {
      console.error("Error generating answer with Gemini:", error);
      // Provide a more helpful error message
      if (error.message.includes("GoogleGenerativeAI Error")) {
        answer =
          "Xin lỗi, hiện tại có vấn đề với kết nối đến dịch vụ dự báo thời tiết. Vui lòng thử lại sau vài phút.";
      } else {
        answer = generateFallbackAnswer(question, weatherData);
      }
    }

    // Chuẩn bị dữ liệu analysis
    const analysisData = weatherData?.analysis
      ? {
          location: weatherData.analysis.location || null,
          time: {
            type: weatherData.analysis.time?.type || "current",
            value: weatherData.analysis.time?.value || null,
            period: weatherData.analysis.time?.period || null,
            isHistory: weatherData.analysis.time?.isHistory || false,
          },
          type:
            weatherData.analysis.type === "daily"
              ? "current"
              : weatherData.analysis.type || "current",
          details: weatherData.analysis.details || [],
        }
      : null;

    // Lưu vào database
    const chat = await Chat.create({
      question,
      answer,
      weatherData,
      sessionId: sessionId || Date.now().toString(),
      location: weatherData?.location?.name || city || null,
      date: weatherData?.targetDate || null,
      type:
        weatherData?.analysis?.type === "daily"
          ? "current"
          : weatherData?.analysis?.type || "current",
      analysis: analysisData,
    });

    return { answer, weatherData, chat };
  } catch (error) {
    console.error("Chat Error:", error);
    throw error;
  }
};

// Hàm tạo câu trả lời đơn giản khi Gemini không hoạt động
const generateFallbackAnswer = (question, weatherData) => {
  if (!weatherData) {
    return "Xin lỗi, không thể lấy được thông tin thời tiết vào lúc này. Vui lòng thử lại sau.";
  }

  const { current, forecast, analysis } = weatherData;
  let answer = "";

  if (current) {
    answer += `Thời tiết hiện tại tại ${
      weatherData.location?.name || "địa điểm này"
    }: `;
    answer += `${current.temp_c || "N/A"}°C, ${
      current.condition?.text || "N/A"
    }. `;
  }

  if (forecast?.forecastday?.[0]) {
    const today = forecast.forecastday[0];
    answer += `Dự báo ngày mai: ${today.day.avgtemp_c || "N/A"}°C, ${
      today.day.condition?.text || "N/A"
    }. `;
  }

  if (analysis?.time?.type === "hourly" && forecast?.forecastday) {
    const targetDay = forecast.forecastday.find(
      (day) => day.date === weatherData.targetDate
    );
    if (targetDay?.hour) {
      const hourData = targetDay.hour[analysis.time.value];
      if (hourData) {
        answer += `Thời tiết lúc ${analysis.time.value} giờ: ${
          hourData.temp_c || "N/A"
        }°C, ${hourData.condition?.text || "N/A"}. `;
      }
    }
  }

  return answer || "Xin lỗi, không thể tạo câu trả lời phù hợp vào lúc này.";
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
    const { answer, weatherData, chat } = await processWeatherQuestion(
      question,
      city || null,
      sessionId
    );

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
