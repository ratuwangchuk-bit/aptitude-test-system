package utils

import "golang.org/x/crypto/bcrypt"

// HashPassword hashes a plaintext password using bcrypt at the default cost
// (currently 10 rounds). The resulting string is safe to store in the database.
func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(bytes), err
}

// CheckPassword reports whether plaintext matches the bcrypt hash.
// bcrypt.CompareHashAndPassword runs in constant time to prevent timing attacks.
func CheckPassword(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
