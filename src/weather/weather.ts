import type { IconName } from '../ui/components'

/**
 * Weather forecast from Open-Meteo (https://open-meteo.com): free for non-commercial use, no key,
 * data under CC BY 4.0. Only the device position, rounded to about 1 km, is sent.
 */

export interface WeatherHour {
  time: number
  temp: number
  code: number
  day: boolean
  /** Chance of precipitation, 0-100 */
  rain: number
}

export interface SunEvent {
  time: number
  kind: 'sunrise' | 'sunset'
}

export interface Forecast {
  now: { temp: number; feels: number; code: number; day: boolean; wind: number }
  /** Today's highest and lowest temperature */
  max: number
  min: number
  hours: WeatherHour[]
  /** Sunrises and sunsets within the hours shown */
  sun: SunEvent[]
}

/** Rounds a coordinate to 2 decimals (about 1 km), enough for a forecast. */
export const roundCoord = (v: number) => Math.round(v * 100) / 100

export function forecastUrl(lat: number, lon: number) {
  const q = new URLSearchParams({
    latitude: String(roundCoord(lat)),
    longitude: String(roundCoord(lon)),
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset',
    forecast_hours: '24',
    forecast_days: '2',
    timezone: 'auto',
    timeformat: 'unixtime',
  })
  return `https://api.open-meteo.com/v1/forecast?${q}`
}

interface ApiResponse {
  current: { temperature_2m: number; apparent_temperature: number; weather_code: number; is_day: number; wind_speed_10m: number }
  hourly: { time: number[]; temperature_2m: number[]; weather_code: number[]; precipitation_probability: (number | null)[]; is_day: number[] }
  daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; sunrise: number[]; sunset: number[] }
}

export function parseForecast(r: ApiResponse): Forecast {
  const h = r.hourly
  const hours = h.time.map((t, i) => ({
    time: t * 1000,
    temp: h.temperature_2m[i],
    code: h.weather_code[i],
    day: h.is_day[i] === 1,
    rain: h.precipitation_probability[i] ?? 0,
  }))
  const first = hours[0]?.time ?? 0
  const last = (hours[hours.length - 1]?.time ?? 0) + 3_600_000
  const sun: SunEvent[] = [
    ...r.daily.sunrise.map((t) => ({ time: t * 1000, kind: 'sunrise' as const })),
    ...r.daily.sunset.map((t) => ({ time: t * 1000, kind: 'sunset' as const })),
  ]
    .filter((e) => e.time >= first && e.time < last)
    .sort((a, b) => a.time - b.time)
  const c = r.current
  return {
    now: { temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, day: c.is_day === 1, wind: c.wind_speed_10m },
    max: r.daily.temperature_2m_max[0],
    min: r.daily.temperature_2m_min[0],
    hours,
    sun,
  }
}

export async function fetchForecast(lat: number, lon: number, signal?: AbortSignal): Promise<Forecast> {
  const res = await fetch(forecastUrl(lat, lon), { signal })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { reason?: string } | null
    throw new Error(body?.reason || `HTTP ${res.status}`)
  }
  return parseForecast((await res.json()) as ApiResponse)
}

/** Groups of WMO weather codes, each with its own description. */
export type WeatherKind =
  | 'clear'
  | 'mainlyClear'
  | 'partlyCloudy'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'freezingRain'
  | 'lightRain'
  | 'rain'
  | 'heavyRain'
  | 'lightSnow'
  | 'snow'
  | 'heavySnow'
  | 'thunderstorm'
  | 'hail'

/** Tints for the icons (see weather.css). */
export type WeatherTone = 'sun' | 'moon' | 'cloud' | 'rain' | 'snow' | 'storm'

export function weatherKind(code: number): WeatherKind {
  switch (code) {
    case 0:
      return 'clear'
    case 1:
      return 'mainlyClear'
    case 2:
      return 'partlyCloudy'
    case 3:
      return 'overcast'
    case 45:
    case 48:
      return 'fog'
    case 51:
    case 53:
    case 55:
      return 'drizzle'
    case 56:
    case 57:
    case 66:
    case 67:
      return 'freezingRain'
    case 61:
    case 80:
      return 'lightRain'
    case 63:
    case 81:
      return 'rain'
    case 65:
    case 82:
      return 'heavyRain'
    case 71:
    case 77:
    case 85:
      return 'lightSnow'
    case 73:
      return 'snow'
    case 75:
    case 86:
      return 'heavySnow'
    case 95:
    case 97:
      return 'thunderstorm'
    case 96:
    case 99:
      return 'hail'
    default:
      return code < 45 ? 'overcast' : 'rain'
  }
}

export function weatherIcon(code: number, day: boolean): { icon: IconName; tone: WeatherTone } {
  switch (weatherKind(code)) {
    case 'clear':
    case 'mainlyClear':
      return day ? { icon: 'sunny', tone: 'sun' } : { icon: 'bedtime', tone: 'moon' }
    case 'partlyCloudy':
      return day ? { icon: 'partly_cloudy_day', tone: 'sun' } : { icon: 'partly_cloudy_night', tone: 'moon' }
    case 'overcast':
      return { icon: 'cloud', tone: 'cloud' }
    case 'fog':
      return { icon: 'foggy', tone: 'cloud' }
    case 'drizzle':
    case 'lightRain':
      return { icon: 'rainy_light', tone: 'rain' }
    case 'rain':
      return { icon: 'rainy', tone: 'rain' }
    case 'heavyRain':
      return { icon: 'rainy_heavy', tone: 'rain' }
    case 'freezingRain':
      return { icon: 'weather_mix', tone: 'snow' }
    case 'lightSnow':
      return { icon: 'weather_snowy', tone: 'snow' }
    case 'snow':
      return { icon: 'snowing', tone: 'snow' }
    case 'heavySnow':
      return { icon: 'snowing_heavy', tone: 'snow' }
    case 'thunderstorm':
      return { icon: 'thunderstorm', tone: 'storm' }
    case 'hail':
      return { icon: 'weather_hail', tone: 'storm' }
  }
}
