package middleware

import (
	"net/http"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/utils"
)

// adminSessionInfo holds the fields we care about from a validated admin session.
// It is used internally by both middleware functions to avoid repeating the same query.
type adminSessionInfo struct {
	AdminID  int
	Role     string
	IsActive bool
}

// getSessionInfo reads the "admin_session" cookie and validates it against the
// database. It joins admin_sessions with admins so that a single query returns
// both the session state and the account's current role and active flag.
// Expired sessions are rejected at the SQL level (expires_at > NOW()), so
// there is no need for application-level timestamp comparison.
func getSessionInfo(r *http.Request) (adminSessionInfo, error) {
	cookie, err := r.Cookie("admin_session")
	if err != nil || cookie.Value == "" {
		return adminSessionInfo{}, err
	}
	var info adminSessionInfo
	err = config.DB.QueryRow(`
		SELECT s.admin_id, COALESCE(a.role,'general_admin'), COALESCE(a.is_active,true)
		FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
		WHERE s.session_token=$1 AND s.expires_at > NOW()`,
		cookie.Value).Scan(&info.AdminID, &info.Role, &info.IsActive)
	return info, err
}

// AdminAuth is a middleware that protects routes requiring any valid admin session.
// It rejects requests whose session cookie is missing, expired, or belongs to a
// deactivated account. The handler is only called when all checks pass.
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

// SuperAdminOnly is a middleware that wraps AdminAuth with an additional role check.
// It is used on destructive or privileged routes (delete results, manage passcodes,
// manage admin users, etc.) that should never be accessible to general admins.
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
