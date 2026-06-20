package middleware

import "net/http"

// EnforceHTTPS redirects requests that reached the app over plain HTTP to
// HTTPS, and tells browsers to prefer HTTPS on future visits via HSTS.
//
// This app never terminates TLS itself — on Render the edge proxy does, then
// forwards plain HTTP to the container — so the original scheme is read from
// X-Forwarded-Proto, which Render sets on every request it forwards. A
// missing header (local dev, direct container access) is treated as already
// secure rather than redirected, since there's no edge proxy to set it.
//
// /api/health is exempt: Render's liveness probe expects a 200, not a redirect.
func EnforceHTTPS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" && r.Header.Get("X-Forwarded-Proto") == "http" {
			target := "https://" + r.Host + r.URL.RequestURI()
			http.Redirect(w, r, target, http.StatusPermanentRedirect)
			return
		}
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		next.ServeHTTP(w, r)
	})
}
