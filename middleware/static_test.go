package middleware

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStaticServer(t *testing.T) http.Handler {
	t.Helper()
	dir := t.TempDir()
	html := "<!doctype html><title>x</title>" + strings.Repeat("<p>hello</p>", 200)
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "logo.png"), []byte("\x89PNG\r\n\x1a\nfake"), 0o644); err != nil {
		t.Fatal(err)
	}
	return StaticAssets(http.FileServer(http.Dir(dir)))
}

func TestStaticAssetsCompressesHTML(t *testing.T) {
	h := newStaticServer(t)
	req := httptest.NewRequest("GET", "/index.html", nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	// FileServer redirects /index.html to /; follow that the way a browser would.
	if rec.Code == http.StatusMovedPermanently {
		req = httptest.NewRequest("GET", "/", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, req)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", got)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(zr)
	if !strings.Contains(string(body), "<p>hello</p>") {
		t.Fatalf("decompressed body missing content")
	}
}

func TestStaticAssetsRespectsNoGzipAndRange(t *testing.T) {
	h := newStaticServer(t)
	for name, hdr := range map[string]map[string]string{
		"no accept-encoding": {},
		"gzip refused":       {"Accept-Encoding": "gzip;q=0"},
		"range request":      {"Accept-Encoding": "gzip", "Range": "bytes=0-9"},
	} {
		req := httptest.NewRequest("GET", "/", nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("%s: Content-Encoding = %q, want none", name, got)
		}
	}
}

func TestStaticAssetsNotModifiedPassesThrough(t *testing.T) {
	h := newStaticServer(t)
	first := httptest.NewRecorder()
	h.ServeHTTP(first, httptest.NewRequest("GET", "/", nil))
	lm := first.Header().Get("Last-Modified")
	if lm == "" {
		t.Fatal("no Last-Modified header")
	}
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("If-Modified-Since", lm)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
	if rec.Header().Get("Content-Encoding") != "" || rec.Body.Len() != 0 {
		t.Fatalf("304 must have no encoding/body; got %q / %d bytes", rec.Header().Get("Content-Encoding"), rec.Body.Len())
	}
}

func TestStaticAssetsImagesCachedNotCompressed(t *testing.T) {
	h := newStaticServer(t)
	req := httptest.NewRequest("GET", "/logo.png", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=86400" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatal("PNG must not be gzip-compressed")
	}
}
