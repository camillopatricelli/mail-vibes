import { describe, expect, it } from 'vitest'
import { forecastUrl, parseForecast, roundCoord, weatherIcon, weatherKind } from './weather'

describe('weather', () => {
  it('sends the position rounded to about 1 km', () => {
    expect(roundCoord(41.902783)).toBe(41.9)
    expect(roundCoord(-12.49637)).toBe(-12.5)
    const url = new URL(forecastUrl(45.464211, 9.191383))
    expect(url.origin).toBe('https://api.open-meteo.com')
    expect(url.searchParams.get('latitude')).toBe('45.46')
    expect(url.searchParams.get('longitude')).toBe('9.19')
    expect(url.searchParams.get('forecast_hours')).toBe('24')
  })

  it('parses hours and keeps only the sunrises and sunsets within them', () => {
    const t0 = 1_795_446_000 // an hour start, in seconds
    const f = parseForecast({
      current: { temperature_2m: 15.7, apparent_temperature: 15.1, weather_code: 0, is_day: 1, wind_speed_10m: 4.6 },
      hourly: {
        time: [t0, t0 + 3600, t0 + 7200],
        temperature_2m: [15, 14, 12],
        weather_code: [0, 2, 61],
        precipitation_probability: [0, null, 40],
        is_day: [1, 1, 0],
      },
      daily: {
        temperature_2m_max: [17, 16],
        temperature_2m_min: [8, 6],
        sunrise: [t0 - 30000, t0 + 60000],
        sunset: [t0 + 5000, t0 + 90000],
      },
    })
    expect(f.now).toEqual({ temp: 15.7, feels: 15.1, code: 0, day: true, wind: 4.6 })
    expect([f.max, f.min]).toEqual([17, 8])
    expect(f.hours.map((h) => h.time)).toEqual([t0 * 1000, (t0 + 3600) * 1000, (t0 + 7200) * 1000])
    expect(f.hours.map((h) => h.rain)).toEqual([0, 0, 40])
    expect(f.hours[2].day).toBe(false)
    expect(f.sun).toEqual([{ time: (t0 + 5000) * 1000, kind: 'sunset' }])
  })

  it('maps WMO codes to kinds and day or night icons', () => {
    expect(weatherKind(0)).toBe('clear')
    expect(weatherKind(82)).toBe('heavyRain')
    expect(weatherKind(99)).toBe('hail')
    expect(weatherIcon(0, true)).toEqual({ icon: 'sunny', tone: 'sun' })
    expect(weatherIcon(1, false)).toEqual({ icon: 'bedtime', tone: 'moon' })
    expect(weatherIcon(2, false).icon).toBe('partly_cloudy_night')
    expect(weatherIcon(75, true)).toEqual({ icon: 'snowing_heavy', tone: 'snow' })
    expect(weatherIcon(95, true).tone).toBe('storm')
  })
})
