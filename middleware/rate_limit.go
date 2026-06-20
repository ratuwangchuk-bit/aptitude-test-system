package middleware

import (
	"net"
	"net/http"
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

// clientIP returns the remote TCP connection's IP, stripped of its port.
// It deliberately ignores X-Forwarded-For: this app is not known to run
// behind a trusted reverse proxy, and trusting a client-supplied header would
// let an attacker spoof a fresh IP on every request to defeat the limiter.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
