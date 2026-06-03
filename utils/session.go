package utils

import (
	"crypto/rand"
	"encoding/hex"
	"os"
)

// GenerateToken creates a cryptographically secure random token.
// 32 bytes gives 256 bits of entropy — well beyond brute-force range.
// The token is hex-encoded to produce a 64-character printable string
// that is safe to store in a database column or a cookie value.
func GenerateToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

// SessionSecure reports whether the admin_session cookie should be marked Secure.
// Set SESSION_SECURE=true in production (HTTPS) so the cookie is never sent over
// plain HTTP. Leave it unset in development so local HTTP servers work without TLS.
func SessionSecure() bool {
	return os.Getenv("SESSION_SECURE") == "true"
}
