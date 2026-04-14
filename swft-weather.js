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
    // Try browser geolocation first
    const browserLoc = await new Promise((resolve) => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
          () => resolve(null),
          { timeout: 5000 }
        );
      } else {
        resolve(null);
      }
    });
    if (browserLoc) return browserLoc;

    // Fallback: IP-based geolocation (no permission needed)
    // ipwho.is is free + CORS-friendly; ipapi.co blocks direct browser use.
    try {
      const res = await fetch("https://ipwho.is/");
      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.latitude && data.longitude) {
          return { lat: data.latitude, lon: data.longitude };
        }
      }
    } catch (e) { /* swallow — fall through to default location */ }

    // Last resort: Austin TX
    return { lat: 30.27, lon: -97.74 };
  }

  function isCanada(lat, lon) {
    // Canada is roughly above 49°N (except some southern Ontario/Quebec dips)
    // Also check longitude is in North America range (-50 to -141)
    return lat >= 48.5 && lon >= -141 && lon <= -50;
  }

  let _unit = "°F";

  async function fetchWeather() {
    try {
      const loc = await getLocation();
      const useCelsius = isCanada(loc.lat, loc.lon);
      _unit = useCelsius ? "°C" : "°F";
      const tempUnit = useCelsius ? "celsius" : "fahrenheit";
      const url = `/api/weather?lat=${loc.lat}&lon=${loc.lon}&units=${tempUnit}`;
      // Include auth token (weather is Pro+ only)
      const headers = {};
      // Try modular SDK user first (set by auth guard), then compat SDK
      const user = window.__swftUser || (typeof firebase !== "undefined" && firebase.auth && firebase.auth().currentUser);
      if (user) {
        const token = await user.getIdToken();
        headers["Authorization"] = "Bearer " + token;
      }
      const res = await fetch(url, { headers });
      if (res.status === 403 || res.status === 401) return null;
      const data = await res.json();
      window._swftWeatherData = data;
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
      '<span class="weather-text"><strong>' + temp + _unit + '</strong> &nbsp;' + desc + ' — ' + cond.text + '</span>' +
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
        '<div class="wx-temp">' + high + _unit + '</div>' +
        '</div>';
    }
    strip.innerHTML = html;
  }

  // Wait for Firebase auth to resolve (max 5s)
  async function waitForAuth() {
    if (window.__swftUser) return;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (window.__swftUser) return;
    }
  }

  // Run on page load
  async function init() {
    await waitForAuth();
    const data = await fetchWeather();
    if (!data) return;

    const strip = document.querySelector(".weather-strip");
    if (!strip) return;

    // Schedule page — detected via data-type attribute
    if (strip.dataset.type === "schedule") {
      updateScheduleWeather(data);
      return;
    }

    // Dashboard page — single weather strip line
    updateDashboardWeather(data);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
