package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/utils"
)

// adminUserResponse is the JSON shape returned by the admin user list endpoint.
// It is a subset of the admins table — PasswordHash is deliberately excluded.
type adminUserResponse struct {
	ID        int    `json:"id"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	IsActive  bool   `json:"is_active"`
	CreatedAt string `json:"created_at"`
}

// adminCreateRequest is the JSON body for creating a new admin account.
type adminCreateRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"` // "super_admin" or "general_admin"
}

// adminPasswordRequest is the JSON body for changing an admin's password.
type adminPasswordRequest struct {
	Password string `json:"password"`
}

// ListAdmins returns all admin accounts ordered by creation date.
// Only super admins can call this endpoint (enforced by the SuperAdminOnly middleware).
func ListAdmins(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT id, username, COALESCE(role,'general_admin'), COALESCE(is_active,true),
		       to_char(created_at, 'YYYY-MM-DD HH24:MI')
		FROM admins ORDER BY id ASC`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load admin users")
		return
	}
	defer rows.Close()

	admins := []adminUserResponse{}
	for rows.Next() {
		var a adminUserResponse
		if err := rows.Scan(&a.ID, &a.Username, &a.Role, &a.IsActive, &a.CreatedAt); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read admin users")
			return
		}
		admins = append(admins, a)
	}
	utils.JSON(w, http.StatusOK, admins)
}

// CreateAdminUser creates a new admin account with a bcrypt-hashed password.
// The role must be either "super_admin" or "general_admin"; passwords shorter
// than 6 characters are rejected. A unique constraint on admins.username means
// the DB will reject duplicate usernames.
func CreateAdminUser(w http.ResponseWriter, r *http.Request) {
	var req adminCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.Role = strings.TrimSpace(req.Role)
	if req.Role == "" {
		req.Role = "general_admin" // Default role for new admins.
	}
	if req.Role != "general_admin" && req.Role != "super_admin" {
		utils.Error(w, http.StatusBadRequest, "Role must be super_admin or general_admin")
		return
	}
	if req.Username == "" || len(req.Password) < 6 {
		utils.Error(w, http.StatusBadRequest, "Username is required and password must be at least 6 characters")
		return
	}

	hash, err := utils.HashPassword(req.Password)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not secure password")
		return
	}

	var id int
	err = config.DB.QueryRow(
		`INSERT INTO admins (username, password_hash, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
		req.Username, hash, req.Role,
	).Scan(&id)
	if err != nil {
		// The most common error here is a unique-constraint violation on username.
		utils.Error(w, http.StatusBadRequest, "Could not create admin. Username may already exist.")
		return
	}
	utils.JSON(w, http.StatusCreated, map[string]interface{}{"message": "Admin user created", "id": id})
}

// DeleteAdminUser permanently removes an admin account and all their sessions.
// The ON DELETE CASCADE on admin_sessions.admin_id handles session cleanup automatically.
func DeleteAdminUser(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	if id <= 0 {
		utils.Error(w, http.StatusBadRequest, "Invalid admin id")
		return
	}
	res, err := config.DB.Exec("DELETE FROM admins WHERE id=$1", id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete admin")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Admin user not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Admin user deleted"})
}

// SetAdminActive enables or disables an admin account.
// When an account is deactivated (is_active=false), all of that admin's active
// sessions are immediately deleted so they cannot continue working even if they
// already have a valid cookie. Re-activation does not create a new session —
// the admin must log in again.
func SetAdminActive(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	if id <= 0 {
		utils.Error(w, http.StatusBadRequest, "Invalid admin id")
		return
	}
	var payload struct {
		IsActive bool `json:"is_active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Verify the admin exists before updating.
	var role string
	err := config.DB.QueryRow("SELECT COALESCE(role,'general_admin') FROM admins WHERE id=$1", id).Scan(&role)
	if err == sql.ErrNoRows {
		utils.Error(w, http.StatusNotFound, "Admin user not found")
		return
	}

	_, err = config.DB.Exec("UPDATE admins SET is_active=$1 WHERE id=$2", payload.IsActive, id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not update admin access")
		return
	}

	// Invalidate existing sessions immediately when revoking access so the admin
	// cannot keep using a cookie they already have.
	if !payload.IsActive {
		config.DB.Exec("DELETE FROM admin_sessions WHERE admin_id=$1", id)
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Admin access updated"})
}

// ChangeAdminRole updates the role of an admin account.
// A super admin cannot demote themselves — the frontend hides the button for
// the logged-in user's own row, and this handler enforces it server-side too.
func ChangeAdminRole(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	if id <= 0 {
		utils.Error(w, http.StatusBadRequest, "Invalid admin id")
		return
	}

	var payload struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	payload.Role = strings.TrimSpace(payload.Role)
	if payload.Role != "general_admin" && payload.Role != "super_admin" {
		utils.Error(w, http.StatusBadRequest, "Role must be super_admin or general_admin")
		return
	}

	// Prevent a super admin from changing their own role via a direct API call.
	// currentAdminFromRequest returns the caller's own ID from the session so no
	// extra DB round-trip is needed.
	callerID, _, _, _ := currentAdminFromRequest(r)
	if callerID != 0 && callerID == id {
		utils.Error(w, http.StatusForbidden, "You cannot change your own role")
		return
	}

	res, err := config.DB.Exec("UPDATE admins SET role=$1 WHERE id=$2", payload.Role, id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not update role")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Admin user not found")
		return
	}

	// Invalidate all sessions for the affected admin so the new role takes
	// effect on their next login rather than mid-session.
	config.DB.Exec("DELETE FROM admin_sessions WHERE admin_id=$1", id)
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Role updated successfully"})
}

// ChangeAdminPassword replaces an admin's password hash and immediately invalidates
// all their existing sessions, forcing a re-login with the new credentials.
// The minimum password length (6 characters) is enforced here to match the
// creation constraint.
func ChangeAdminPassword(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	if id <= 0 {
		utils.Error(w, http.StatusBadRequest, "Invalid admin id")
		return
	}

	var req adminPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if len(strings.TrimSpace(req.Password)) < 6 {
		utils.Error(w, http.StatusBadRequest, "Password must be at least 6 characters")
		return
	}

	hash, err := utils.HashPassword(req.Password)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not secure password")
		return
	}

	res, err := config.DB.Exec("UPDATE admins SET password_hash=$1 WHERE id=$2", hash, id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not change password")
		return
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		utils.Error(w, http.StatusNotFound, "Admin user not found")
		return
	}

	// Log the admin out of all current sessions so the new password takes effect immediately.
	config.DB.Exec("DELETE FROM admin_sessions WHERE admin_id=$1", id)
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Password changed successfully"})
}
