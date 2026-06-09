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

// loginRequest is the expected JSON body for the admin login endpoint.
type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// AdminLogin authenticates an admin by username and password.
// On success it creates a session row in admin_sessions (1 hour for super_admin,
// 30 minutes for general_admin) and sets an HttpOnly cookie containing the token.
// HttpOnly prevents JavaScript from reading the cookie, which mitigates XSS-based
// session hijacking.
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
	var passwordHash, role string
	var isActive bool
	err := config.DB.QueryRow(
		"SELECT id, password_hash, COALESCE(role,'general_admin'), COALESCE(is_active,true) FROM admins WHERE username=$1",
		req.Username,
	).Scan(&adminID, &passwordHash, &role, &isActive)

	// Handle both "user not found" and a real DB error separately.
	if err != nil && err != sql.ErrNoRows {
		utils.Error(w, http.StatusInternalServerError, "Login failed")
		return
	}
	// Use the same error message for "user not found" and "wrong password" to
	// prevent username enumeration attacks.
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

	// Super admins get a 1-hour session; general admins get 30 minutes.
	sessionDuration := 30 * time.Minute
	if role == "super_admin" {
		sessionDuration = 1 * time.Hour
	}
	expiresAt := time.Now().Add(sessionDuration)
	_, err = config.DB.Exec(
		"INSERT INTO admin_sessions (admin_id, session_token, expires_at) VALUES ($1, $2, $3)",
		adminID, token, expiresAt,
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save session")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,                // Not readable by JavaScript.
		Secure:   utils.SessionSecure(), // True in production (HTTPS only).
		SameSite: http.SameSiteLaxMode,  // Protects against cross-site request forgery.
		Expires:  expiresAt,
	})

	utils.JSON(w, http.StatusOK, map[string]interface{}{"message": "Login successful", "role": role})
}

// AdminLogout deletes the session token from the database and immediately expires
// the cookie on the client. The response is always 200 so the frontend can
// redirect reliably even if the cookie was already gone.
func AdminLogout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("admin_session")
	if err == nil {
		config.DB.Exec("DELETE FROM admin_sessions WHERE session_token=$1", cookie.Value)
	}

	// MaxAge: -1 tells the browser to delete the cookie immediately.
	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Logout successful"})
}

// CheckAdminSession returns the currently logged-in admin's username, role, and
// active status. It is called by the frontend on every page load to populate the
// UI and decide which elements to show or hide based on role.
// Note: this performs a second DB query after the AdminAuth middleware already
// validated the session — the tradeoff is simplicity over an extra round-trip.
func CheckAdminSession(w http.ResponseWriter, r *http.Request) {
	id, username, role, isActive := currentAdminFromRequest(r)
	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"message":   "Session active",
		"id":        id,
		"username":  username,
		"role":      role,
		"is_active": isActive,
	})
}

// currentAdminFromRequest looks up the admin linked to the current session cookie
// and returns their id, username, role, and active status. Returns (0, "", "", false)
// on any error (missing cookie, expired session, DB failure).
// This is a thin helper used by CheckAdminSession; the middleware layer handles
// request gating and does not need to pass admin data through the context.
func currentAdminFromRequest(r *http.Request) (int, string, string, bool) {
	cookie, err := r.Cookie("admin_session")
	if err != nil || cookie.Value == "" {
		return 0, "", "", false
	}
	var id int
	var username, role string
	var isActive bool
	err = config.DB.QueryRow(`
		SELECT a.id, a.username, COALESCE(a.role,'general_admin'), COALESCE(a.is_active,true)
		FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
		WHERE s.session_token=$1 AND s.expires_at > NOW()`,
		cookie.Value,
	).Scan(&id, &username, &role, &isActive)
	if err != nil {
		return 0, "", "", false
	}
	return id, username, role, isActive
}
