package utils

import (
	"crypto/rand"
	"crypto/sha256"
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

// HashToken returns the hex SHA-256 of a token. Participant session tokens are
// stored only in hashed form, so a database leak does not expose usable tokens.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// SessionSecure reports whether the admin_session cookie should be marked Secure.
// Set SESSION_SECURE=true in production (HTTPS) so the cookie is never sent over
// plain HTTP. Leave it unset in development so local HTTP servers work without TLS.
func SessionSecure() bool {
	return os.Getenv("SESSION_SECURE") == "true"
}
