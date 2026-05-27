package routes

import (
	"net/http"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/handlers"
	"digital-aptitude-evaluation-system/middleware"
)

func RegisterRoutes(r *mux.Router) {
	// ── Participant-facing public routes ──────────────────────────────────────
	r.HandleFunc("/api/validate-passcode", handlers.ValidatePasscode).Methods("POST")
	r.HandleFunc("/api/validate-cid", handlers.ValidateCID).Methods("POST")
	r.HandleFunc("/api/start-test", handlers.StartTest).Methods("POST")
	r.HandleFunc("/api/questions", handlers.GetQuestions).Methods("GET")
	r.HandleFunc("/api/submit-test", handlers.SubmitTest).Methods("POST")
	r.HandleFunc("/api/submission-status/{participantId}", handlers.CheckSubmission).Methods("GET")
	r.HandleFunc("/api/result/{participantId}", handlers.GetParticipantResult).Methods("GET")

	// ── Admin auth ────────────────────────────────────────────────────────────
	r.HandleFunc("/api/admin/login", handlers.AdminLogin).Methods("POST")
	r.HandleFunc("/api/admin/logout", handlers.AdminLogout).Methods("POST")
	r.HandleFunc("/api/admin/check-session", middleware.AdminAuth(handlers.CheckAdminSession)).Methods("GET")
	r.HandleFunc("/api/admin/me", middleware.AdminAuth(handlers.CheckAdminSession)).Methods("GET")

	// ── Read-only (both super admin and general admin) ────────────────────────
	r.HandleFunc("/api/admin/dashboard", middleware.AdminAuth(handlers.DashboardSummary)).Methods("GET")
	r.HandleFunc("/api/admin/results/export", middleware.AdminAuth(handlers.ExportResults)).Methods("GET")
	r.HandleFunc("/api/admin/results", middleware.AdminAuth(handlers.GetResults)).Methods("GET")
	r.HandleFunc("/api/admin/results/{id}/detail", middleware.AdminAuth(handlers.GetSubmissionDetail)).Methods("GET")
	r.HandleFunc("/api/admin/questions", middleware.AdminAuth(handlers.GetAllQuestions)).Methods("GET")
	r.HandleFunc("/api/admin/answers", middleware.AdminAuth(handlers.GetAnswers)).Methods("GET")
	r.HandleFunc("/api/admin/participants", middleware.AdminAuth(handlers.GetAdminParticipants)).Methods("GET")

	// ── Write / delete (super admin only) ────────────────────────────────────
	r.HandleFunc("/api/admin/results/{id}", middleware.SuperAdminOnly(handlers.DeleteResult)).Methods("DELETE")

	r.HandleFunc("/api/admin/participants", middleware.SuperAdminOnly(handlers.AddAdminParticipant)).Methods("POST")
	r.HandleFunc("/api/admin/participants/template", middleware.SuperAdminOnly(handlers.ParticipantsTemplate)).Methods("GET")
	r.HandleFunc("/api/admin/participants/upload", middleware.SuperAdminOnly(handlers.UploadParticipants)).Methods("POST")
	r.HandleFunc("/api/admin/participants/{id}", middleware.SuperAdminOnly(handlers.DeleteAdminParticipant)).Methods("DELETE")

	r.HandleFunc("/api/admin/passcodes", middleware.SuperAdminOnly(handlers.GetPasscodes)).Methods("GET")
	r.HandleFunc("/api/admin/passcodes/generate", middleware.SuperAdminOnly(handlers.GeneratePasscode)).Methods("POST")
	r.HandleFunc("/api/admin/passcodes/{id}", middleware.SuperAdminOnly(handlers.DeletePasscode)).Methods("DELETE")

	// Note: /upload routes are registered before /{id} so gorilla/mux matches them first.
	r.HandleFunc("/api/admin/questions/upload", middleware.SuperAdminOnly(handlers.UploadQuestions)).Methods("POST")
	r.HandleFunc("/api/admin/questions", middleware.SuperAdminOnly(handlers.AddQuestion)).Methods("POST")
	r.HandleFunc("/api/admin/questions/{id}", middleware.SuperAdminOnly(handlers.UpdateQuestion)).Methods("PUT")
	r.HandleFunc("/api/admin/questions/{id}", middleware.SuperAdminOnly(handlers.DeleteQuestion)).Methods("DELETE")

	r.HandleFunc("/api/admin/answers/upload", middleware.SuperAdminOnly(handlers.UploadAnswers)).Methods("POST")
	r.HandleFunc("/api/admin/answers", middleware.SuperAdminOnly(handlers.AddAnswer)).Methods("POST")
	r.HandleFunc("/api/admin/answers/{id}", middleware.SuperAdminOnly(handlers.UpdateAnswer)).Methods("PUT")
	r.HandleFunc("/api/admin/answers/{id}", middleware.SuperAdminOnly(handlers.DeleteAnswer)).Methods("DELETE")

	r.HandleFunc("/api/admin/users", middleware.SuperAdminOnly(handlers.ListAdmins)).Methods("GET")
	r.HandleFunc("/api/admin/users", middleware.SuperAdminOnly(handlers.CreateAdminUser)).Methods("POST")
	r.HandleFunc("/api/admin/users/{id}", middleware.SuperAdminOnly(handlers.DeleteAdminUser)).Methods("DELETE")
	r.HandleFunc("/api/admin/users/{id}/access", middleware.SuperAdminOnly(handlers.SetAdminActive)).Methods("PUT")
	r.HandleFunc("/api/admin/users/{id}/password", middleware.SuperAdminOnly(handlers.ChangeAdminPassword)).Methods("PUT")

	// ── Static frontend files ─────────────────────────────────────────────────
	fs := http.FileServer(http.Dir("./frontend"))
	r.PathPrefix("/").Handler(fs)
}
