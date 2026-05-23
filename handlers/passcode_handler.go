package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

func GeneratePasscode(w http.ResponseWriter, r *http.Request) {
	code, err := uniquePasscode()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not generate passcode")
		return
	}

	var id int
	err = config.DB.QueryRow("INSERT INTO passcodes (code, expires_at) VALUES ($1, NOW() + INTERVAL '90 minutes') RETURNING id", code).Scan(&id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save passcode")
		return
	}

	utils.JSON(w, http.StatusCreated, map[string]interface{}{
		"message": "Participant passcode generated successfully. It will expire after 1 hour 30 minutes.",
		"id":      id,
		"code":    code,
	})
}

func GetPasscodes(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`SELECT id, code,
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

func uniquePasscode() (string, error) {
	for i := 0; i < 10; i++ {
		raw := make([]byte, 4)
		if _, err := rand.Read(raw); err != nil {
			return "", err
		}
		code := "DAES-" + strings.ToUpper(hex.EncodeToString(raw))
		var exists int
		err := config.DB.QueryRow("SELECT 1 FROM passcodes WHERE code=$1", code).Scan(&exists)
		if err == sql.ErrNoRows {
			return code, nil
		}
		if err != nil {
			return "", err
		}
	}
	return "", errors.New("could not generate a unique passcode after 10 attempts")
}
