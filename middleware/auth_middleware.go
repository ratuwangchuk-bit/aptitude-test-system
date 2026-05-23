package middleware

import (
	"net/http"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/utils"
)

type adminSessionInfo struct {
	AdminID  int
	Role     string
	IsActive bool
}

func getSessionInfo(r *http.Request) (adminSessionInfo, error) {
	cookie, err := r.Cookie("admin_session")
	if err != nil || cookie.Value == "" {
		return adminSessionInfo{}, err
	}
	var info adminSessionInfo
	err = config.DB.QueryRow(`SELECT s.admin_id, COALESCE(a.role,'general_admin'), COALESCE(a.is_active,true)
		FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
		WHERE s.session_token=$1 AND s.expires_at > NOW()`, cookie.Value).Scan(&info.AdminID, &info.Role, &info.IsActive)
	return info, err
}

func AdminAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info, err := getSessionInfo(r)
		if err != nil || !info.IsActive {
			utils.Error(w, http.StatusUnauthorized, "Session expired or unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	}
}

func SuperAdminOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info, err := getSessionInfo(r)
		if err != nil || !info.IsActive {
			utils.Error(w, http.StatusUnauthorized, "Session expired or unauthorized")
			return
		}
		if info.Role != "super_admin" {
			utils.Error(w, http.StatusForbidden, "Only super admin can perform this action")
			return
		}
		next.ServeHTTP(w, r)
	}
}
