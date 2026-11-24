package middleware

import (
	"compress/gzip"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// StaticAssets adds caching and compression to the static frontend handler.
//
// Caching: HTML, CSS and JS are served with "Cache-Control: no-cache", so the
// browser keeps a copy but revalidates it on every use (http.FileServer
// answers with 304 Not Modified when unchanged). File names are not
// versioned, so this is what makes a deploy visible immediately instead of
// browsers guessing a freshness period and running stale code. Images and
// fonts change rarely and are cached for a day.
//
// Compression: text responses are gzip-compressed when the client accepts it,
// typically shrinking HTML/CSS/JS by 70–80%.
func StaticAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ext := strings.ToLower(path.Ext(r.URL.Path))
		isDir := strings.HasSuffix(r.URL.Path, "/")

		switch {
		case isDir || ext == ".html" || ext == ".css" || ext == ".js":
			w.Header().Set("Cache-Control", "no-cache")
		case ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".svg" ||
			ext == ".ico" || ext == ".webp" || ext == ".woff2":
			w.Header().Set("Cache-Control", "public, max-age=86400")
		}

		compressible := isDir || ext == ".html" || ext == ".css" || ext == ".js" ||
			ext == ".svg" || ext == ".json" || ext == ".txt"
		if !compressible {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Accept-Encoding")
		// Range requests address byte offsets of the uncompressed file, so they
		// must not be compressed.
		if r.Header.Get("Range") != "" || !acceptsGzip(r) {
			next.ServeHTTP(w, r)
			return
		}

		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		fields := strings.Split(part, ";")
		if strings.TrimSpace(fields[0]) != "gzip" {
			continue
		}
		// "gzip;q=0" means the client refuses gzip.
		for _, p := range fields[1:] {
			if v, ok := strings.CutPrefix(strings.TrimSpace(p), "q="); ok {
				if q, err := strconv.ParseFloat(v, 64); err == nil && q == 0 {
					return false
				}
			}
		}
		return true
	}
	return false
}

var gzipPool = sync.Pool{New: func() any {
	gz, _ := gzip.NewWriterLevel(nil, gzip.DefaultCompression)
	return gz
}}

// gzipResponseWriter compresses the body only for 200 responses; redirects,
// 304s and errors pass through untouched.
type gzipResponseWriter struct {
	http.ResponseWriter
	gz      *gzip.Writer
	decided bool
}

func (w *gzipResponseWriter) WriteHeader(code int) {
	if !w.decided {
		w.decided = true
		h := w.Header()
		if code == http.StatusOK && h.Get("Content-Encoding") == "" {
			h.Del("Content-Length") // the compressed length differs
			h.Set("Content-Encoding", "gzip")
			w.gz = gzipPool.Get().(*gzip.Writer)
			w.gz.Reset(w.ResponseWriter)
		}
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	if !w.decided {
		w.WriteHeader(http.StatusOK)
	}
	if w.gz != nil {
		return w.gz.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

func (w *gzipResponseWriter) close() {
	if w.gz != nil {
		w.gz.Close()
		gzipPool.Put(w.gz)
		w.gz = nil
	}
}
