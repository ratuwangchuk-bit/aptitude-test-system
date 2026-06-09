package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

// GeneratePasscode creates a new single-use entry passcode that expires after
// 90 minutes. The code is formatted as "DAES-XXXXXXXX" (8 random hex characters)
// and is guaranteed to be unique in the passcodes table by the uniquePasscode helper.
func GeneratePasscode(w http.ResponseWriter, r *http.Request) {
	code, err := uniquePasscode()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not generate passcode")
		return
	}

	cfg := loadTestConfig()
	validityMinutes := cfg.PasscodeValidityMinutes

	var id int
	err = config.DB.QueryRow(
		fmt.Sprintf("INSERT INTO passcodes (code, expires_at) VALUES ($1, NOW() + INTERVAL '%d minutes') RETURNING id", validityMinutes),
		code,
	).Scan(&id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save passcode")
		return
	}

	utils.JSON(w, http.StatusCreated, map[string]interface{}{
		"message": fmt.Sprintf("Passcode generated. It will expire in %d minutes.", validityMinutes),
		"id":      id,
		"code":    code,
	})
}

// GetPasscodes returns the most recent 100 passcodes with their computed status.
// The Active/Expired status is calculated by the database (expires_at > NOW())
// so it reflects the true server-side time rather than the client's clock.
func GetPasscodes(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT id, code,
		       to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
		       to_char(expires_at, 'YYYY-MM-DD HH24:MI') AS expires_at,
		       CASE WHEN expires_at > NOW() THEN 'Active' ELSE 'Expired' END AS status
		FROM passcodes ORDER BY id DESC LIMIT 100`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load passcodes")
		return
	}
	defer rows.Close()

	passcodes := []models.Passcode{}
	for rows.Next() {
		var p models.Passcode
		if err := rows.Scan(&p.ID, &p.Code, &p.CreatedAt, &p.ExpiresAt, &p.Status); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read passcodes")
			return
		}
		passcodes = append(passcodes, p)
	}
	utils.JSON(w, http.StatusOK, passcodes)
}

// CheckPasscodeStatus returns whether a passcode is still valid (exists and not expired).
// This is a public endpoint polled by the test page every 30 seconds so the server
// can revoke a session mid-test by deleting or letting the passcode expire.
func CheckPasscodeStatus(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	if id <= 0 {
		utils.JSON(w, http.StatusOK, map[string]bool{"valid": false})
		return
	}
	var valid bool
	config.DB.QueryRow(
		"SELECT EXISTS(SELECT 1 FROM passcodes WHERE id=$1 AND expires_at > NOW())",
		id,
	).Scan(&valid)
	utils.JSON(w, http.StatusOK, map[string]bool{"valid": valid})
}

// DeletePasscode removes a passcode by its ID, whether or not it has expired.
func DeletePasscode(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	res, err := config.DB.Exec("DELETE FROM passcodes WHERE id=$1", id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete passcode")
		return
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		utils.Error(w, http.StatusNotFound, "Passcode not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Passcode deleted successfully"})
}

// uniquePasscode generates a random "DAES-XXXXXXXX" code and retries up to 10
// times if the code happens to already exist in the table. In practice a collision
// is astronomically unlikely (4 random bytes = ~4 billion possibilities), but the
// retry loop is a safety net to guarantee uniqueness under any circumstances.
func uniquePasscode() (string, error) {
	for i := 0; i < 10; i++ {
		raw := make([]byte, 4)
		if _, err := rand.Read(raw); err != nil {
			return "", err
		}
		code := "DAES-" + strings.ToUpper(hex.EncodeToString(raw))

		// Check whether this code already exists. ErrNoRows means it is free to use.
		var exists int
		err := config.DB.QueryRow("SELECT 1 FROM passcodes WHERE code=$1", code).Scan(&exists)
		if err == sql.ErrNoRows {
			return code, nil
		}
		if err != nil {
			return "", err
		}
		// Code exists — loop and generate a new one.
	}
	return "", errors.New("could not generate a unique passcode after 10 attempts")
}
