package routes

import (
	"net/http"
	"time"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/handlers"
	"digital-aptitude-evaluation-system/middleware"
)

// RegisterRoutes attaches all HTTP handlers to the router.
func RegisterRoutes(r *mux.Router) {
	// Throttles brute-force/enumeration attempts against the public passcode
	// and CID gates (e.g. sweeping CID numbers to see which are registered).
	// Set to 120/min so up to ~60 participants sharing the same office network IP
	// can all log in simultaneously (2 requests each) without being blocked.
	// Automated scanners that fire hundreds of requests are still stopped.
	gateLimit := middleware.RateLimit(120, time.Minute)

	// Throttles password guessing on admin login. Only a handful of admins exist,
	// so 20 attempts per 15 minutes per IP leaves room for typos and several
	// admins on one office network, while capping a brute-force run at ~1,900
	// guesses a day instead of thousands per minute.
	adminLoginLimit := middleware.RateLimit(20, 15*time.Minute)

	// Test endpoints require the session token issued by /api/validate-cid.
	participantAuth := middleware.ParticipantAuth

	// ── Participant-facing public routes ──────────────────────────────────────
	r.HandleFunc("/api/test-info", handlers.GetPublicTestInfo).Methods("GET")
	r.HandleFunc("/api/image-proxy", handlers.ImageProxy).Methods("GET")
	r.HandleFunc("/api/validate-passcode", gateLimit(handlers.ValidatePasscode)).Methods("POST")
	r.HandleFunc("/api/passcode-status/{id}", handlers.CheckPasscodeStatus).Methods("GET")
	r.HandleFunc("/api/validate-cid", gateLimit(handlers.ValidateCID)).Methods("POST")
	r.HandleFunc("/api/start-test", participantAuth(handlers.StartTest)).Methods("POST")
	r.HandleFunc("/api/progress", participantAuth(handlers.UpdateProgress)).Methods("POST")
	r.HandleFunc("/api/save-answers", participantAuth(handlers.SaveAnswers)).Methods("POST")
	r.HandleFunc("/api/cancel-submission", participantAuth(handlers.CancelRecentSubmission)).Methods("DELETE")
	r.HandleFunc("/api/questions", participantAuth(handlers.GetQuestions)).Methods("GET")
	r.HandleFunc("/api/test-availability", participantAuth(handlers.CheckTestAvailability)).Methods("GET")
	r.HandleFunc("/api/submit-test", participantAuth(handlers.SubmitTest)).Methods("POST")
	r.HandleFunc("/api/submission-status/{participantId}", participantAuth(handlers.CheckSubmission)).Methods("GET")
	// Requires admin auth: returns full PII (name, CID, scores) for any participant.
	r.HandleFunc("/api/result/{participantId}", middleware.AdminAuth(handlers.GetParticipantResult)).Methods("GET")

	// ── Admin auth ────────────────────────────────────────────────────────────
	r.HandleFunc("/api/admin/login", adminLoginLimit(handlers.AdminLogin)).Methods("POST")
	r.HandleFunc("/api/admin/logout", handlers.AdminLogout).Methods("POST")
	r.HandleFunc("/api/admin/me", middleware.AdminAuth(handlers.CheckAdminSession)).Methods("GET")

	// ── Read-only (both super admin and general admin) ────────────────────────
	r.HandleFunc("/api/admin/dashboard", middleware.AdminAuth(handlers.DashboardSummary)).Methods("GET")
	r.HandleFunc("/api/admin/live-progress", middleware.AdminAuth(handlers.GetLiveProgress)).Methods("GET")
	r.HandleFunc("/api/admin/results/export", middleware.AdminAuth(handlers.ExportResults)).Methods("GET")
	r.HandleFunc("/api/admin/results", middleware.AdminAuth(handlers.GetResults)).Methods("GET")
	r.HandleFunc("/api/admin/results/{id}/detail", middleware.AdminAuth(handlers.GetSubmissionDetail)).Methods("GET")
	r.HandleFunc("/api/admin/questions", middleware.AdminAuth(handlers.GetAllQuestions)).Methods("GET")
	r.HandleFunc("/api/admin/answers", middleware.AdminAuth(handlers.GetAnswers)).Methods("GET")
	r.HandleFunc("/api/admin/participants", middleware.AdminAuth(handlers.GetAdminParticipants)).Methods("GET")
	r.HandleFunc("/api/admin/settings/config", middleware.AdminAuth(handlers.GetTestConfig)).Methods("GET")
	r.HandleFunc("/api/admin/settings/sections", middleware.AdminAuth(handlers.GetSections)).Methods("GET")

	// ── Write / delete (super admin only) ────────────────────────────────────
	r.HandleFunc("/api/admin/results/{id}", middleware.SuperAdminOnly(handlers.DeleteResult)).Methods("DELETE")

	r.HandleFunc("/api/admin/participants/{id}/suspend", middleware.SuperAdminOnly(handlers.SuspendParticipant)).Methods("PUT")
	r.HandleFunc("/api/admin/participants/{id}/allow-resume", middleware.SuperAdminOnly(handlers.AllowResume)).Methods("POST")

	r.HandleFunc("/api/admin/participants", middleware.SuperAdminOnly(handlers.AddAdminParticipant)).Methods("POST")
	r.HandleFunc("/api/admin/participants/template", middleware.SuperAdminOnly(handlers.ParticipantsTemplate)).Methods("GET")
	r.HandleFunc("/api/admin/participants/upload", middleware.SuperAdminOnly(handlers.UploadParticipants)).Methods("POST")
	r.HandleFunc("/api/admin/participants/{id}", middleware.SuperAdminOnly(handlers.DeleteAdminParticipant)).Methods("DELETE")

	r.HandleFunc("/api/admin/passcodes", middleware.SuperAdminOnly(handlers.GetPasscodes)).Methods("GET")
	r.HandleFunc("/api/admin/passcodes/generate", middleware.SuperAdminOnly(handlers.GeneratePasscode)).Methods("POST")
	r.HandleFunc("/api/admin/passcodes/{id}", middleware.SuperAdminOnly(handlers.DeletePasscode)).Methods("DELETE")

	// /upload and collection POST must come before /{id} so gorilla/mux matches them first.
	r.HandleFunc("/api/admin/questions/template", middleware.AdminAuth(handlers.QuestionsTemplate)).Methods("GET")
	r.HandleFunc("/api/admin/questions/upload", middleware.SuperAdminOnly(handlers.UploadQuestions)).Methods("POST")
	r.HandleFunc("/api/admin/questions", middleware.SuperAdminOnly(handlers.AddQuestion)).Methods("POST")
	r.HandleFunc("/api/admin/questions/{id}/image", middleware.SuperAdminOnly(handlers.UploadQuestionImage)).Methods("POST")
	r.HandleFunc("/api/admin/questions/{id}/image", middleware.SuperAdminOnly(handlers.RemoveQuestionImage)).Methods("DELETE")
	r.HandleFunc("/api/admin/questions/{id}", middleware.SuperAdminOnly(handlers.UpdateQuestion)).Methods("PUT")
	r.HandleFunc("/api/admin/questions/{id}", middleware.SuperAdminOnly(handlers.DeleteQuestion)).Methods("DELETE")

	r.HandleFunc("/api/admin/answers", middleware.SuperAdminOnly(handlers.AddAnswer)).Methods("POST")
	r.HandleFunc("/api/admin/answers/{id}", middleware.SuperAdminOnly(handlers.UpdateAnswer)).Methods("PUT")
	r.HandleFunc("/api/admin/answers/{id}", middleware.SuperAdminOnly(handlers.DeleteAnswer)).Methods("DELETE")

	r.HandleFunc("/api/admin/users", middleware.SuperAdminOnly(handlers.ListAdmins)).Methods("GET")
	r.HandleFunc("/api/admin/users", middleware.SuperAdminOnly(handlers.CreateAdminUser)).Methods("POST")
	r.HandleFunc("/api/admin/users/{id}", middleware.SuperAdminOnly(handlers.DeleteAdminUser)).Methods("DELETE")
	r.HandleFunc("/api/admin/users/{id}/access", middleware.SuperAdminOnly(handlers.SetAdminActive)).Methods("PUT")
	r.HandleFunc("/api/admin/users/{id}/role", middleware.SuperAdminOnly(handlers.ChangeAdminRole)).Methods("PUT")
	r.HandleFunc("/api/admin/users/{id}/password", middleware.SuperAdminOnly(handlers.ChangeAdminPassword)).Methods("PUT")

	// Settings (super admin only for writes)
	r.HandleFunc("/api/admin/settings/config", middleware.SuperAdminOnly(handlers.UpdateTestConfig)).Methods("PUT")
	r.HandleFunc("/api/admin/settings/sections", middleware.SuperAdminOnly(handlers.AddSection)).Methods("POST")
	r.HandleFunc("/api/admin/settings/sections/{id}", middleware.SuperAdminOnly(handlers.UpdateSection)).Methods("PUT")
	r.HandleFunc("/api/admin/settings/sections/{id}", middleware.SuperAdminOnly(handlers.DeleteSection)).Methods("DELETE")

	// ── Static frontend files ─────────────────────────────────────────────────
	fs := http.FileServer(http.Dir("./frontend"))
	r.PathPrefix("/").Handler(fs)
}
