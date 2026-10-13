package middleware

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"digital-aptitude-evaluation-system/utils"
)

// RateLimit throttles repeated requests from the same client IP on public,
// unauthenticated endpoints (CID/passcode validation) so they cannot be swept
// to enumerate valid CID numbers or guess passcodes. It is a simple in-memory
// fixed-window counter per remote IP — adequate for a single-process internal
// tool, not a substitute for a distributed rate limiter.
func RateLimit(maxRequests int, window time.Duration) func(http.HandlerFunc) http.HandlerFunc {
	type bucket struct {
		count       int
		windowStart time.Time
	}
	var mu sync.Mutex
	buckets := make(map[string]*bucket)

	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			now := time.Now()

			mu.Lock()
			b, ok := buckets[ip]
			if !ok || now.Sub(b.windowStart) > window {
				b = &bucket{windowStart: now}
				buckets[ip] = b
			}
			b.count++
			blocked := b.count > maxRequests
			mu.Unlock()

			if blocked {
				utils.Error(w, http.StatusTooManyRequests, "Too many attempts. Please wait a moment and try again.")
				return
			}
			next.ServeHTTP(w, r)
		}
	}
}

// clientIP returns the client's real IP for rate-limit bucketing.
// When RemoteAddr is a loopback or RFC-1918 address (i.e. we are behind a
// reverse proxy such as Render's routing layer), we trust the first value of
// X-Forwarded-For, which the proxy sets to the real client IP. We only trust
// XFF in that case — if the connection arrives directly (public RemoteAddr),
// we use RemoteAddr to prevent a caller from spoofing a fresh IP each request.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if idx := strings.IndexByte(xff, ','); idx != -1 {
				xff = xff[:idx]
			}
			if xff = strings.TrimSpace(xff); xff != "" {
				return xff
			}
		}
	}
	return host
}
