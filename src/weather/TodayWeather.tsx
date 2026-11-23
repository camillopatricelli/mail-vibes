import { Fragment, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { hourLabel, timeOf } from '../calendar/format'
import { useSettings } from '../settings/store'
import { Button, Card, Icon } from '../ui/components'
import { Spinner } from '../ui/overlay'
import { fetchForecast, roundCoord, weatherIcon, weatherKind, type Forecast } from './weather'

const REFRESH = 30 * 60_000

type GeoPermission = PermissionState | 'unsupported' | 'unknown'

/** The browser's location permission for this app, kept up to date when the user changes it. */
function useGeoPermission(): GeoPermission {
  const [state, setState] = useState<GeoPermission>('unknown')
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setState('unsupported')
      return
    }
    let status: PermissionStatus | undefined
    let live = true
    const query = navigator.permissions?.query({ name: 'geolocation' })
    if (!query) {
      setState('prompt')
      return
    }
    query
      .then((s) => {
        if (!live) return
        status = s
        setState(s.state)
        s.onchange = () => setState(s.state)
      })
      .catch(() => live && setState('prompt'))
    return () => {
      live = false
      if (status) status.onchange = null
    }
  }, [])
  return state
}

class LocationError extends Error {
  constructor(
    message: string,
    readonly denied: boolean,
  ) {
    super(message)
  }
}

function getPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: roundCoord(p.coords.latitude), lon: roundCoord(p.coords.longitude) }),
      (e) => reject(new LocationError(e.message, e.code === e.PERMISSION_DENIED)),
      // A rough, recent position is enough for a forecast, and quicker to get.
      { enableHighAccuracy: false, maximumAge: REFRESH, timeout: 20_000 },
    ),
  )
}

const deg = (v: number) => `${Math.round(v)}°`

/** Weather card at the top of the Today page: now, and the next 24 hours where the device is. */
export function TodayWeather() {
  const { t } = useTranslation()
  const shown = useSettings((s) => s.weather)
  const update = useSettings((s) => s.update)
  const permission = useGeoPermission()
  const [asked, setAsked] = useState(false)

  const position = useQuery({
    queryKey: ['weather', 'position'],
    queryFn: getPosition,
    enabled: shown && (permission === 'granted' || asked),
    staleTime: REFRESH,
    refetchInterval: REFRESH,
    retry: false,
  })
  const coords = position.data
  const forecast = useQuery({
    queryKey: ['weather', 'forecast', coords?.lat, coords?.lon],
    queryFn: ({ signal }) => fetchForecast(coords!.lat, coords!.lon, signal),
    enabled: !!coords,
    staleTime: REFRESH,
    refetchInterval: REFRESH,
  })

  if (!shown || permission === 'unknown') return null
  const hide = (
    <Button variant="text" onClick={() => update({ weather: false })}>
      {t('weather.hide')}
    </Button>
  )
  const denied = permission === 'denied' || (position.error instanceof LocationError && position.error.denied)

  let body: React.ReactNode
  if (permission === 'unsupported') {
    body = <Message text={t('weather.unsupported')}>{hide}</Message>
  } else if (denied) {
    body = <Message text={t('weather.denied')}>{hide}</Message>
  } else if (permission === 'prompt' && !asked) {
    body = (
      <Message text={t('weather.intro')}>
        <Button variant="tonal" icon="my_location" onClick={() => setAsked(true)}>
          {t('weather.useLocation')}
        </Button>
        {hide}
      </Message>
    )
  } else if (forecast.data) {
    return <WeatherCard f={forecast.data} />
  } else if (position.error || forecast.error) {
    const error = position.error ?? forecast.error
    body = (
      <Message text={t(position.error ? 'weather.noLocation' : 'weather.loadFailed', { reason: error?.message })} alert>
        <Button variant="text" icon="refresh" onClick={() => void (position.error ? position.refetch() : forecast.refetch())}>
          {t('weather.retry')}
        </Button>
      </Message>
    )
  } else {
    body = <Spinner label={t('weather.loading')} />
  }
  return (
    <Card className="weather weather--message">
      <header className="today__panel-head">
        <Icon name="partly_cloudy_day" />
        <h2 className="title-medium">{t('weather.title')}</h2>
      </header>
      {body}
    </Card>
  )
}

function Message({ text, alert, children }: { text: string; alert?: boolean; children?: React.ReactNode }) {
  return (
    <div className="weather__message">
      <p className={alert ? 'body-medium field-error' : 'body-medium muted'} role={alert ? 'alert' : undefined}>
        {text}
      </p>
      <div className="row-wrap">{children}</div>
    </div>
  )
}

function WeatherCard({ f }: { f: Forecast }) {
  const { t } = useTranslation()
  const now = weatherIcon(f.now.code, f.now.day)
  const nowText = t(`weather.kind.${weatherKind(f.now.code)}`)
  return (
    <Card className="weather">
      <div className="weather__now">
        <Icon name={now.icon} filled size={64} className={`wx wx--${now.tone}`} />
        <div>
          <div className="weather__temp">{deg(f.now.temp)}</div>
          <div className="title-medium">{nowText}</div>
          <div className="body-small muted">
            {t('weather.feelsLike', { temp: deg(f.now.feels) })} · {t('weather.wind', { speed: Math.round(f.now.wind) })}
          </div>
          <div className="body-small muted">{t('weather.highLow', { high: deg(f.max), low: deg(f.min) })}</div>
        </div>
      </div>
      <ol className="weather__hours" aria-label={t('weather.next24')}>
        {f.hours.map((hour, i) => {
          // The first column matches the "now" block (current conditions are more precise).
          const h = i === 0 ? { ...hour, temp: f.now.temp, code: f.now.code, day: f.now.day } : hour
          const w = weatherIcon(h.code, h.day)
          const kind = t(`weather.kind.${weatherKind(h.code)}`)
          const sun = f.sun.filter((s) => s.time >= h.time && s.time < h.time + 3_600_000)
          return (
            <Fragment key={h.time}>
              <li className={i === 0 ? 'weather__hour is-now' : 'weather__hour'} title={kind}>
                <span className="label-medium">{i === 0 ? t('weather.now') : hourLabel(h.time)}</span>
                <Icon name={w.icon} filled size={28} className={`wx wx--${w.tone}`} label={kind} />
                <span className="title-small">{deg(h.temp)}</span>
                <span className="weather__rain label-small">{h.rain > 0 ? `${h.rain}%` : ' '}</span>
              </li>
              {sun.map((s) => (
                <li key={s.time} className="weather__hour weather__hour--sun">
                  <span className="label-medium">{timeOf(s.time)}</span>
                  <Icon name="wb_twilight" filled size={28} className="wx wx--sun" />
                  <span className="label-small">{t(`weather.${s.kind}`)}</span>
                  <span className="label-small">{' '}</span>
                </li>
              ))}
            </Fragment>
          )
        })}
      </ol>
      <a className="weather__credit label-small" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
        {t('weather.credit')}
      </a>
    </Card>
  )
}
