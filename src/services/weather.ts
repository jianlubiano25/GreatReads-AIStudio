import { notifyNookPrefs } from './nookPrefs';

export type WeatherCondition = 'clear' | 'clouds' | 'rain' | 'snow';
export type TimePeriod = 'morning' | 'day' | 'sunset' | 'night';
export const TIME_PERIODS: TimePeriod[] = ['morning', 'day', 'sunset', 'night'];
export const WEATHER_MODES: WeatherCondition[] = ['clear', 'clouds', 'rain', 'snow'];


export interface WeatherData {
  condition: WeatherCondition;
  period: TimePeriod;
  isNight: boolean;
  temperature?: number;
  description: string;
  source: 'location' | 'time' | 'manual';
  sun?: SunTimes;
}

export interface SunTimes {
  rise: number;
  set: number;
  offset: number;
}

const CACHE_KEY = 'greatreads_weather_v2';
const OVERRIDE_KEY = 'greatreads_weather_override';
const SUN_KEY = 'greatreads_sun_v1';
const GEO_FAIL_KEY = 'greatreads_geo_failed';
const GEO_OPT_KEY = 'greatreads_weather_location'; // '1' only if you switched on "Match weather to my location"
const GEO_RETRY_MS = 60 * 60 * 1000; // after a refusal/timeout, don't ask the device for its location again for an hour
const POS_KEY = 'greatreads_geo_pos_v1';
const POS_FRESH_MS = 6 * 60 * 60 * 1000; // a position this recent is used as it is: the device is not asked again
const POS_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // an older one is still used (instead of asking again) unless the browser has the permission saved

/*
 * Why the app used to ask for location again and again: the position, the weather and "the device said no" were all kept in
 * sessionStorage, which phones and installed apps empty every time the app is opened, so each launch looked like a first visit.
 * Now they live in localStorage, and the device is only asked when there is no usable position and asking can work:
 *   - permission already granted     -> ask freely (the browser answers silently, no question is shown)
 *   - permission denied              -> never ask (a saved position, if any, is still used)
 *   - permission not remembered      -> ask only when no position has ever been saved (the first time), not on every launch
 * Turning "Match weather to my location" off and on again forgets the saved position and asks once more (use it after travelling).
 */
export type GeoPermission = 'granted' | 'prompt' | 'denied' | 'unknown';
export interface SavedPos { lat: number; lon: number; at: number }

export function locationPlan(o: { permission: GeoPermission; saved: SavedPos | null; failedAt: number; now: number }): 'use-saved' | 'ask-device' | 'none' {
  const { permission, saved, failedAt, now } = o;
  const age = saved ? now - saved.at : Infinity;
  const keep = saved && age < POS_KEEP_MS ? 'use-saved' : 'none';
  if (permission === 'denied') return keep;
  if (now - failedAt < GEO_RETRY_MS) return keep; // asked a moment ago and it did not work
  if (saved && age < POS_FRESH_MS) return 'use-saved';
  if (permission === 'granted') return 'ask-device'; // silent
  if (saved && age < POS_KEEP_MS) return 'use-saved'; // not remembered by the browser: do not make the reader answer again
  return 'ask-device';
}

const readStored = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStored = (key: string, value: string | null) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };

function readSavedPos(): SavedPos | null {
  try {
    const v = JSON.parse(readStored(POS_KEY) || 'null');
    return v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Number.isFinite(v.at) ? { lat: v.lat, lon: v.lon, at: v.at } : null;
  } catch {
    return null;
  }
}
/** Rounded to about a kilometre: enough for the weather, nothing more precise is ever kept. */
const savePos = (lat: number, lon: number) => writeStored(POS_KEY, JSON.stringify({ lat: Number(lat.toFixed(2)), lon: Number(lon.toFixed(2)), at: Date.now() }));

async function geoPermission(): Promise<GeoPermission> {
  try {
    const p = await (navigator as any).permissions?.query({ name: 'geolocation' });
    return p?.state === 'granted' || p?.state === 'prompt' || p?.state === 'denied' ? p.state : 'unknown';
  } catch {
    return 'unknown'; // older Safari has no Permissions API for geolocation
  }
}

// With "Match weather to my location" on, a window tap is only a temporary peek: opening / refreshing the app goes
// back to the real local weather. (With it off, your chosen ambiance is remembered, as before.)
try {
  if (localStorage.getItem(GEO_OPT_KEY) === '1') localStorage.removeItem(OVERRIDE_KEY);
} catch {}

/** What the window says for a weather + time of day (the moon phase is added by the scene). */
export function describeWeather(cond: WeatherCondition, period: TimePeriod): string {
  if (cond === 'rain') return 'Cozy Rain';
  if (cond === 'clouds') return 'Drifting Clouds';
  if (cond === 'snow') return 'Gentle Snowfall';
  if (period === 'night') return 'Starlit Night';
  if (period === 'sunset') return 'Golden Twilight';
  if (period === 'morning') return 'Quiet Morning';
  return 'Sunny Reading Day';
}

export const PERIOD_LABEL: Record<TimePeriod, string> = { morning: 'Morning', day: 'Daytime', sunset: 'Sunset', night: 'Night' };

function manualWeather(): WeatherData | null {
  try {
    const override = localStorage.getItem(OVERRIDE_KEY);
    if (override && override !== 'auto') {
      const { period, isNight } = getTimePeriod(new Date(), knownSun());
      const cond = override as WeatherCondition;
      return { condition: cond, period, isNight, description: describeWeather(cond, period), source: 'manual' };
    }
  } catch {}
  return null;
}

export function periodFromSun(minutes: number, rise: number, set: number): TimePeriod {
  if (minutes < rise - 30 || minutes >= set + 30) return 'night';
  if (minutes < rise + 90) return 'morning';
  if (minutes >= set - 30) return 'sunset';
  return 'day';
}

function minutesAt(now: Date, offset?: number): number {
  if (typeof offset === 'number') {
    const local = new Date(now.getTime() + offset * 1000);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
  }
  return now.getHours() * 60 + now.getMinutes();
}

function clockMinutes(value: unknown): number | null {
  const match = /T(\d{2}):(\d{2})/.exec(String(value ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function getTimePeriod(now: Date = new Date(), sun?: SunTimes | null): { period: TimePeriod; isNight: boolean } {
  const minutes = minutesAt(now, sun?.offset);
  let period: TimePeriod;
  if (sun) period = periodFromSun(minutes, sun.rise, sun.set);
  else if (minutes >= 300 && minutes < 510) period = 'morning';
  else if (minutes >= 510 && minutes < 1050) period = 'day';
  else if (minutes >= 1050 && minutes < 1125) period = 'sunset';
  else period = 'night';
  return { period, isNight: period === 'night' };
}

function rememberSun(sun: SunTimes) {
  try { localStorage.setItem(SUN_KEY, JSON.stringify({ ...sun, day: new Date().toDateString() })); } catch {}
}

function knownSun(): SunTimes | null {
  try {
    if (!isLocationWeatherEnabled()) return null;
    const value = JSON.parse(localStorage.getItem(SUN_KEY) || 'null');
    if (!value || typeof value.rise !== 'number' || typeof value.set !== 'number' || typeof value.offset !== 'number') return null;
    return { rise: value.rise, set: value.set, offset: value.offset };
  } catch {
    return null;
  }
}

function withLivePeriod(weather: WeatherData, now: Date = new Date()): WeatherData {
  const { period, isNight } = getTimePeriod(now, weather.sun ?? null);
  if (period === weather.period && isNight === weather.isNight) return weather;
  const description = weather.source === 'location' && weather.condition === 'clear'
    ? describeWeather('clear', period)
    : weather.description;
  return { ...weather, period, isNight, description };
}

export function parseWmoCode(code: number): { condition: WeatherCondition; label: string } {
  // WMO Weather interpretation codes (WW)
  if (code === 0) return { condition: 'clear', label: 'Clear Sky' };
  if (code === 1 || code === 2) return { condition: 'clouds', label: 'Partly Cloudy' };
  if (code === 3) return { condition: 'clouds', label: 'Overcast' };
  if ([51, 53, 55, 56, 57].includes(code)) return { condition: 'rain', label: 'Gentle Drizzle' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { condition: 'rain', label: 'Rain' };
  if ([95, 96, 99].includes(code)) return { condition: 'rain', label: 'Thunderstorm' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { condition: 'snow', label: 'Snow' };
  return { condition: 'clear', label: 'Fair' };
}

export async function fetchLocalWeather(): Promise<WeatherData | null> {
  if (typeof window === 'undefined') return null;

  // Check manual override first (if user tapped window to choose a specific ambiance)
  const manual = manualWeather();
  if (manual) return manual;

  // Check cache (10 minutes)
  try {
    const cached = readStored(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.timestamp < 10 * 60 * 1000) {
        return withLivePeriod(parsed.data);
      }
    }
  } catch {}

  // Location is OFF unless you turn it on in Settings, so the app never asks for it by itself (see the note on locationPlan).
  if ('geolocation' in navigator && isLocationWeatherEnabled()) {
    const plan = locationPlan({ permission: await geoPermission(), saved: readSavedPos(), failedAt: Number(readStored(GEO_FAIL_KEY) || 0), now: Date.now() });
    let pos: { coords: { latitude: number; longitude: number } } | null = null;
    if (plan === 'use-saved') {
      const sp = readSavedPos();
      if (sp) pos = { coords: { latitude: sp.lat, longitude: sp.lon } };
    } else if (plan === 'ask-device') {
      // 1) ask the device where it is. Only a refusal/timeout here blocks asking again for an hour.
      try {
        const got = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            timeout: 8000,
            maximumAge: 15 * 60 * 1000,
          });
        });
        pos = got;
        savePos(got.coords.latitude, got.coords.longitude);
        writeStored(GEO_FAIL_KEY, null);
      } catch {
        writeStored(GEO_FAIL_KEY, String(Date.now()));
      }
    }

    // 2) ask the weather service. A network hiccup here must NOT count as "location refused", and it must not hang.
    if (pos) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        const { latitude, longitude } = pos.coords;
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}&current=weather_code,precipitation,temperature_2m&daily=sunrise,sunset&timezone=auto&forecast_days=1`,
          { headers: { Accept: 'application/json' }, signal: controller.signal },
        );

        // The device/network can take seconds. If you tapped the window meanwhile, your choice must win.
        const tappedMeanwhile = manualWeather();
        if (tappedMeanwhile) return tappedMeanwhile;

        if (res.ok) {
          const json = await res.json();
          const current = json.current;
          const rise = clockMinutes(json.daily?.sunrise?.[0]);
          const set = clockMinutes(json.daily?.sunset?.[0]);
          const offset = Number(json.utc_offset_seconds);
          const sun: SunTimes | undefined = rise != null && set != null && Number.isFinite(offset) ? { rise, set, offset } : undefined;
          if (sun) rememberSun(sun);
          const { period, isNight } = getTimePeriod(new Date(), sun ?? null);
          const { condition, label } = parseWmoCode(current.weather_code || 0);

          const data: WeatherData = {
            condition: condition === 'snow' ? 'snow' : current.precipitation > 0.2 ? 'rain' : condition,
            period,
            isNight,
            temperature: Number.isFinite(Number(current.temperature_2m)) ? Math.round(current.temperature_2m) : undefined,
            description: isNight && condition === 'clear' ? 'Starlit Night' : label,
            source: 'location',
            sun,
          };

          writeStored(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data }));

          return data;
        }
      } catch {
        // offline / slow / bad answer: use the time-of-day window for now and try again on the next refresh
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  // Fallback based on local system time
  const timeData = getTimePeriod(new Date(), knownSun());
  return {
    condition: 'clear',
    period: timeData.period,
    isNight: timeData.isNight,
    description: describeWeather('clear', timeData.period),
    source: 'time',
  };
}

export function setWeatherOverride(override: 'auto' | WeatherCondition) {
  try {
    if (override === 'auto') {
      localStorage.removeItem(OVERRIDE_KEY);
    } else {
      localStorage.setItem(OVERRIDE_KEY, override);
    }
    // Bust cache on override
    writeStored(CACHE_KEY, null);
  } catch {}
}

export function getWeatherOverride(): string {
  try {
    return localStorage.getItem(OVERRIDE_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

/** Location-based weather is optional and off by default (the scene already follows the time of day). */
export function isLocationWeatherEnabled(): boolean {
  try {
    return localStorage.getItem(GEO_OPT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setLocationWeatherEnabled(on: boolean) {
  try {
    if (on) {
      localStorage.setItem(GEO_OPT_KEY, '1');
      localStorage.removeItem(OVERRIDE_KEY); // show the real local weather now, not an old tap
    } else localStorage.removeItem(GEO_OPT_KEY);
    // Turning it on (or off) forgets the saved position and any earlier refusal: the next look asks the device afresh, once.
    writeStored(CACHE_KEY, null);
    writeStored(GEO_FAIL_KEY, null);
    writeStored(POS_KEY, null);
    try { sessionStorage.removeItem(CACHE_KEY); sessionStorage.removeItem(GEO_FAIL_KEY); } catch {} // keys older versions used
  } catch {}
  notifyNookPrefs(); // the window re-reads the weather right away
}
