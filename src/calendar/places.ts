/**
 * Place suggestions for event locations, from Google Maps (Places API), with the user's own key.
 * The Maps script is loaded only when a key is set and the location field is used.
 */

interface Prediction {
  text?: { text?: string }
  mainText?: { text?: string }
  secondaryText?: { text?: string }
}
interface PlacesLib {
  AutocompleteSessionToken: new () => object
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions(req: { input: string; sessionToken?: object; language?: string }): Promise<{ suggestions: { placePrediction?: Prediction | null }[] }>
  }
}
type MapsWindow = Window & {
  google?: { maps?: { importLibrary?: (name: string) => Promise<unknown> } }
  gm_authFailure?: () => void
  __mailVibesMaps?: () => void
}

export interface PlaceSuggestion {
  /** What goes into the location field: "Name, address" */
  text: string
  main: string
  secondary: string
}

let loading: { key: string; lib: Promise<PlacesLib> } | undefined
let authFailed = false

function loadPlaces(key: string): Promise<PlacesLib> {
  if (loading?.key === key) return loading.lib
  const w = window as MapsWindow
  const lib = new Promise<PlacesLib>((resolve, reject) => {
    const ready = () => {
      const importLibrary = w.google?.maps?.importLibrary
      if (!importLibrary) return reject(new Error('Google Maps did not load'))
      importLibrary('places').then((l) => resolve(l as PlacesLib), reject)
    }
    if (w.google?.maps?.importLibrary) return ready()
    w.__mailVibesMaps = ready
    // Called by Maps when the key is refused (wrong key, site not allowed, API not enabled).
    w.gm_authFailure = () => {
      authFailed = true
    }
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&v=weekly&callback=__mailVibesMaps`
    s.async = true
    s.onerror = () => reject(new Error('Google Maps did not load'))
    document.head.appendChild(s)
  })
  loading = { key, lib }
  lib.catch(() => {
    if (loading?.lib === lib) loading = undefined
  })
  return lib
}

/** A session groups the keystrokes of one search (Google bills a session, not each key). */
export async function newPlacesSession(key: string) {
  const lib = await loadPlaces(key)
  return new lib.AutocompleteSessionToken()
}

export async function suggestPlaces(key: string, input: string, session: object | undefined, language: string): Promise<PlaceSuggestion[]> {
  if (authFailed) throw new Error('Google Maps refused the key')
  const lib = await loadPlaces(key)
  const r = await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({ input, sessionToken: session, language })
  return r.suggestions
    .map((x) => x.placePrediction)
    .filter((p): p is Prediction => !!p?.text?.text)
    .map((p) => ({ text: p.text!.text!, main: p.mainText?.text ?? p.text!.text!, secondary: p.secondaryText?.text ?? '' }))
}

/** A Google Maps link for a place (search by its text). */
export const mapsUrl = (place: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`
