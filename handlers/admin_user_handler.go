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

type adminUserResponse struct {
	ID        int    `json:"id"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	IsActive  bool   `json:"is_active"`
	CreatedAt string `json:"created_at"`
}

type adminCreateRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

type adminPasswordRequest struct {
	Password string `json:"password"`
}

func ListAdmins(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`SELECT id, username, COALESCE(role,'general_admin'), COALESCE(is_active,true), to_char(created_at, 'YYYY-MM-DD HH24:MI')
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

func CreateAdminUser(w http.ResponseWriter, r *http.Request) {
	var req adminCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.Role = strings.TrimSpace(req.Role)
	if req.Role == "" {
		req.Role = "general_admin"
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
	err = config.DB.QueryRow(`INSERT INTO admins (username, password_hash, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
		req.Username, hash, req.Role).Scan(&id)
	if err != nil {
		utils.Error(w, http.StatusBadRequest, "Could not create admin. Username may already exist.")
		return
	}
	utils.JSON(w, http.StatusCreated, map[string]interface{}{"message": "Admin user created", "id": id})
}

func DeleteAdminUser(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	if id <= 0 {
		utils.Error(w, http.StatusBadRequest, "Invalid admin id")
		return
	}
	// admin_sessions CASCADE deletes on admins(id), so sessions are cleaned up automatically.
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
	if !payload.IsActive {
		config.DB.Exec("DELETE FROM admin_sessions WHERE admin_id=$1", id)
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Admin access updated"})
}

func ChangeAdminPassword(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
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
	config.DB.Exec("DELETE FROM admin_sessions WHERE admin_id=$1", id)
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Password changed successfully"})
}
