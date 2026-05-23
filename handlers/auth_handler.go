package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/utils"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func AdminLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || strings.TrimSpace(req.Password) == "" {
		utils.Error(w, http.StatusBadRequest, "Username and password are required")
		return
	}

	var adminID int
	var passwordHash string
	var role string
	var isActive bool
	err := config.DB.QueryRow("SELECT id, password_hash, COALESCE(role,'general_admin'), COALESCE(is_active,true) FROM admins WHERE username=$1", req.Username).Scan(&adminID, &passwordHash, &role, &isActive)
	if err != nil && err != sql.ErrNoRows {
		utils.Error(w, http.StatusInternalServerError, "Login failed")
		return
	}
	if err == sql.ErrNoRows || !utils.CheckPassword(req.Password, passwordHash) {
		utils.Error(w, http.StatusUnauthorized, "Invalid username or password")
		return
	}
	if !isActive {
		utils.Error(w, http.StatusForbidden, "This admin account has been revoked. Please contact the super admin.")
		return
	}

	token, err := utils.GenerateToken()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not create session")
		return
	}

	expiresAt := time.Now().Add(1 * time.Hour)
	_, err = config.DB.Exec("INSERT INTO admin_sessions (admin_id, session_token, expires_at) VALUES ($1, $2, $3)", adminID, token, expiresAt)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save session")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   utils.SessionSecure(),
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
	})

	utils.JSON(w, http.StatusOK, map[string]interface{}{"message": "Login successful", "role": role})
}

func AdminLogout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("admin_session")
	if err == nil {
		config.DB.Exec("DELETE FROM admin_sessions WHERE session_token=$1", cookie.Value)
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Logout successful"})
}

func CheckAdminSession(w http.ResponseWriter, r *http.Request) {
	username, role, isActive := currentAdminFromRequest(r)
	utils.JSON(w, http.StatusOK, map[string]interface{}{"message": "Session active", "username": username, "role": role, "is_active": isActive})
}

func currentAdminFromRequest(r *http.Request) (string, string, bool) {
	cookie, err := r.Cookie("admin_session")
	if err != nil || cookie.Value == "" {
		return "", "", false
	}
	var username, role string
	var isActive bool
	err = config.DB.QueryRow(`SELECT a.username, COALESCE(a.role,'general_admin'), COALESCE(a.is_active,true)
		FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
		WHERE s.session_token=$1 AND s.expires_at > NOW()`, cookie.Value).Scan(&username, &role, &isActive)
	if err != nil {
		return "", "", false
	}
	return username, role, isActive
}
