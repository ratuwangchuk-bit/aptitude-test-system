package utils

import (
	"encoding/json"
	"net/http"
)

// JSON writes a JSON response with the given HTTP status code.
// The Content-Type header is set before WriteHeader because headers cannot
// be modified after the first call to WriteHeader.
func JSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// Error writes a JSON error response in the standard shape: {"error": "message"}.
// Callers should return immediately after calling this.
func Error(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]string{"error": message})
}
