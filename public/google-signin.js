// See google-signin.html. The code is useless without the app's PKCE verifier and the bridge.
;(() => {
  const q = new URLSearchParams(location.search)
  const state = q.get('state') || ''
  try {
    localStorage.setItem(
      'mail-vibes.google-signin.result',
      JSON.stringify({ state, code: q.get('code') || undefined, error: q.get('error') || undefined }),
    )
  } catch {
    /* storage blocked: the app times out and the user can try again */
  }
  if (state.startsWith('p.')) {
    // Opened as a popup by the app, which is waiting for the answer.
    history.replaceState(null, '', location.pathname)
    window.close()
    setTimeout(() => (document.getElementById('done').hidden = false), 500)
  } else {
    // The whole app went to Google (installed iOS apps): go back to it.
    location.replace(location.pathname.replace(/google-signin\.html$/, ''))
  }
})()
