// ════════════════════════════════════════════════
// SWFT Weather Integration
// Uses Open-Meteo API (free, no key needed)
// Include via: <script src="swft-weather.js"></script>
// ════════════════════════════════════════════════

(function () {
  const WMO_ICONS = {
    0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
    45: "🌫️", 48: "🌫️",
    51: "🌦️", 53: "🌦️", 55: "🌧️",
    61: "🌧️", 63: "🌧️", 65: "🌧️",
    71: "🌨️", 73: "🌨️", 75: "🌨️",
    80: "🌦️", 81: "🌧️", 82: "🌧️",
    95: "⛈️", 96: "⛈️", 99: "⛈️",
  };

  const WMO_DESC = {
    0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow",
    80: "Light showers", 81: "Showers", 82: "Heavy showers",
    95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Severe thunderstorm",
  };

  function getIcon(code) {
    return WMO_ICONS[code] || "☁️";
  }

  function getDesc(code) {
    return WMO_DESC[code] || "Cloudy";
  }

  function getWorkCondition(code, temp) {
    if (code >= 95) return { text: "⚠ Storm", badge: "Unsafe", warn: true };
    if (code >= 61) return { text: "Rain expected", badge: "Rain", warn: true };
    if (temp < 35) return { text: "Freezing temps", badge: "Cold", warn: true };
    if (temp > 100) return { text: "Extreme heat", badge: "Heat", warn: true };
    return { text: "good work conditions", badge: "✓ Clear", warn: false };
  }

  async function getLocation() {
    return new Promise((resolve) => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
          () => resolve({ lat: 30.27, lon: -97.74 }) // Default: Austin TX
        );
      } else {
        resolve({ lat: 30.27, lon: -97.74 });
      }
    });
  }

  async function fetchWeather() {
    try {
      const loc = await getLocation();
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&current_weather=true&temperature_unit=fahrenheit&timezone=auto&forecast_days=16`;
      const res = await fetch(url);
      const data = await res.json();
      return data;
    } catch (e) {
      console.warn("Weather fetch failed:", e);
      return null;
    }
  }

  function updateDashboardWeather(data) {
    const strip = document.querySelector(".weather-strip");
    if (!strip || !data || !data.current_weather) return;

    const cw = data.current_weather;
    const temp = Math.round(cw.temperature);
    const code = cw.weathercode;
    const desc = getDesc(code);
    const icon = getIcon(code);
    const cond = getWorkCondition(code, temp);

    strip.innerHTML =
      '<span class="weather-icon">' + icon + '</span>' +
      '<span class="weather-text"><strong>' + temp + '°F</strong> &nbsp;' + desc + ' — ' + cond.text + '</span>' +
      '<span class="weather-badge" style="' + (cond.warn ? 'color:#f5a623;background:rgba(245,166,35,0.1);' : '') + '">' + cond.badge + '</span>';
  }

  function updateScheduleWeather(data) {
    const strip = document.querySelector(".weather-strip");
    if (!strip || !data || !data.daily) return;

    // Check if this is the schedule page (7-column grid)
    const style = window.getComputedStyle(strip);
    if (!style.gridTemplateColumns || !style.gridTemplateColumns.includes("1fr")) return;

    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const today = new Date();
    const todayDay = today.getDate();

    let html = "";
    const dayCount = Math.min(16, data.daily.time.length);
    for (let i = 0; i < dayCount; i++) {
      const date = new Date(data.daily.time[i] + "T12:00:00");
      const dayName = days[date.getDay()];
      const dayNum = date.getDate();
      const code = data.daily.weathercode[i];
      const high = Math.round(data.daily.temperature_2m_max[i]);
      const isToday = dayNum === todayDay;
      const isWarn = code >= 61;

      let cls = "weather-day";
      if (isToday) cls += " today";
      else if (isWarn) cls += " warn";

      html += '<div class="' + cls + '">' +
        '<div class="wx-label">' + dayName + '</div>' +
        '<div class="wx-day-num">' + dayNum + '</div>' +
        '<div class="wx-icon">' + getIcon(code) + '</div>' +
        '<div class="wx-temp">' + high + '°</div>' +
        '</div>';
    }
    strip.innerHTML = html;
  }

  // Run on page load
  async function init() {
    const data = await fetchWeather();
    if (!data) return;

    // Dashboard page — single weather strip line
    const dashStrip = document.querySelector(".weather-strip .weather-icon");
    if (dashStrip) {
      updateDashboardWeather(data);
      return;
    }

    // Schedule page — 7-day grid
    const schedStrip = document.querySelector(".weather-strip .weather-day");
    if (schedStrip) {
      updateScheduleWeather(data);
      return;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
