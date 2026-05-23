package utils

import (
	"crypto/rand"
	"encoding/hex"
	"os"
)

func GenerateToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func SessionSecure() bool {
	return os.Getenv("SESSION_SECURE") == "true"
}
