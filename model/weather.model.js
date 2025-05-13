const mongoose = require("mongoose");

// Current Weather Schema (existing)
const weatherSchema = new mongoose.Schema({
  city: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  temperature: { type: Number },
  feelsLike: { type: Number },
  description: { type: String },
  humidity: { type: Number },
  windSpeed: { type: Number },
  windDir: { type: String },
  uvIndex: { type: Number },
  rain_mm: { type: Number },
  pressure_mb: { type: Number },
  visibility_km: { type: Number },
  time: { type: Date, required: true },
  source: { type: String, required: true }, // current, hourly, daily, weekly
});

// Astronomy Schema
const astronomySchema = new mongoose.Schema({
  city: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  date: { type: Date, required: true },
  sunrise: { type: String, required: true },
  sunset: { type: String, required: true },
  moonrise: { type: String, required: true },
  moonset: { type: String, required: true },
  moon_phase: { type: String, required: true },
  moon_illumination: { type: Number, required: true },
  is_moon_up: { type: Number, required: true },
  is_sun_up: { type: Number, required: true },
});

// Marine Weather Schema
const marineSchema = new mongoose.Schema({
  city: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  time: { type: Date, required: true },
  wave_height_m: { type: Number, required: true },
  wave_period_sec: { type: Number, required: true },
  wave_direction: { type: String, required: true },
  water_temp_c: { type: Number, required: true },
  wind_speed_kph: { type: Number, required: true },
  wind_direction: { type: String, required: true },
  visibility_km: { type: Number, required: true },
});

// Air Quality Schema
const airQualitySchema = new mongoose.Schema({
  city: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  time: { type: Date, required: true },
  co: { type: Number, required: true },
  no2: { type: Number, required: true },
  o3: { type: Number, required: true },
  so2: { type: Number, required: true },
  pm2_5: { type: Number, required: true },
  pm10: { type: Number, required: true },
  us_epa_index: { type: Number, required: true },
  gb_defra_index: { type: Number, required: true },
});

/**
 * Schema cho dữ liệu thời tiết trong quá khứ
 * @typedef {Object} History
 * @property {string} city - Tên thành phố
 * @property {number} latitude - Vĩ độ
 * @property {number} longitude - Kinh độ
 * @property {Date} date - Ngày
 * @property {number} maxtemp_c - Nhiệt độ cao nhất (°C)
 * @property {number} mintemp_c - Nhiệt độ thấp nhất (°C)
 * @property {number} avgtemp_c - Nhiệt độ trung bình (°C)
 * @property {number} maxwind_kph - Tốc độ gió tối đa (km/h)
 * @property {number} totalprecip_mm - Tổng lượng mưa (mm)
 * @property {number} totalsnow_cm - Tổng lượng tuyết (cm)
 * @property {number} avgvis_km - Tầm nhìn trung bình (km)
 * @property {number} avghumidity - Độ ẩm trung bình (%)
 * @property {string} condition_text - Mô tả điều kiện thời tiết
 * @property {string} condition_icon - Icon điều kiện thời tiết
 * @property {number} condition_code - Mã điều kiện thời tiết
 * @property {number} uv - Chỉ số UV
 * @property {number} daily_will_it_rain - Có mưa không (1: có, 0: không)
 * @property {number} daily_will_it_snow - Có tuyết không (1: có, 0: không)
 * @property {number} daily_chance_of_rain - Xác suất mưa (%)
 * @property {number} daily_chance_of_snow - Xác suất tuyết (%)
 * @property {Object} astro - Thông tin thiên văn
 * @property {string} astro.sunrise - Thời gian mặt trời mọc
 * @property {string} astro.sunset - Thời gian mặt trời lặn
 * @property {string} astro.moonrise - Thời gian mặt trăng mọc
 * @property {string} astro.moonset - Thời gian mặt trăng lặn
 * @property {string} astro.moon_phase - Pha mặt trăng
 * @property {number} astro.moon_illumination - Độ sáng mặt trăng (%)
 * @property {number} astro.is_moon_up - Mặt trăng có đang mọc không (1: có, 0: không)
 * @property {number} astro.is_sun_up - Mặt trời có đang mọc không (1: có, 0: không)
 */
const historySchema = new mongoose.Schema({
  city: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  date: { type: Date, required: true },
  maxtemp_c: { type: Number, required: true },
  mintemp_c: { type: Number, required: true },
  avgtemp_c: { type: Number, required: true },
  maxwind_kph: { type: Number, required: true },
  totalprecip_mm: { type: Number, required: true },
  totalsnow_cm: { type: Number },
  avgvis_km: { type: Number },
  avghumidity: { type: Number, required: true },
  condition_text: { type: String, required: true },
  condition_icon: { type: String, required: true },
  condition_code: { type: Number, required: true },
  uv: { type: Number, required: true },
  daily_will_it_rain: { type: Number },
  daily_will_it_snow: { type: Number },
  daily_chance_of_rain: { type: Number },
  daily_chance_of_snow: { type: Number },
  astro: {
    sunrise: { type: String },
    sunset: { type: String },
    moonrise: { type: String },
    moonset: { type: String },
    moon_phase: { type: String },
    moon_illumination: { type: Number },
    is_moon_up: { type: Number, default: 0 },
    is_sun_up: { type: Number, default: 0 },
  },
});

const Weather = mongoose.model("Weather", weatherSchema);
const Astronomy = mongoose.model("Astronomy", astronomySchema);
const Marine = mongoose.model("Marine", marineSchema);
const AirQuality = mongoose.model("AirQuality", airQualitySchema);
const History = mongoose.model("History", historySchema);

module.exports = {
  Weather,
  Astronomy,
  Marine,
  AirQuality,
  History,
};
