package models

// Admin represents an administrator account stored in the admins table.
// PasswordHash is excluded from JSON responses (json:"-") so it is never
// sent to the browser, even accidentally.
type Admin struct {
	ID           int    `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
	Role         string `json:"role"`     // "super_admin" or "general_admin"
	IsActive     bool   `json:"is_active"` // false = account revoked, cannot log in
}

// Passcode is a single-use entry token generated for each participant batch.
// It expires 90 minutes after creation. Status is computed by the database
// ("Active" / "Expired") and is read-only — it is never written by the app.
type Passcode struct {
	ID        int    `json:"id"`
	Code      string `json:"code"`       // e.g. "DAES-A1B2C3D4"
	CreatedAt string `json:"created_at"` // formatted by the DB as "YYYY-MM-DD HH24:MI"
	ExpiresAt string `json:"expires_at"`
	Status    string `json:"status"` // "Active" or "Expired" — derived, not stored
}

// Participant holds the pre-registered details of a test taker.
// HasSubmitted is computed at query time (not a stored column) and indicates
// whether a matching row exists in the submissions table.
type Participant struct {
	ID            int    `json:"id"`
	FullName      string `json:"full_name"`
	CIDNumber     string `json:"cid_number"`
	CompanyName   string `json:"company_name"`
	ContactNumber string `json:"contact_number"`
	CreatedAt     string `json:"created_at"`
	HasSubmitted  bool   `json:"has_submitted"` // true if a submission row exists for this participant
}

// Question is one multiple-choice question shown during the test.
// The four options are always labelled A–D.
type Question struct {
	ID           int    `json:"id"`
	Section      string `json:"section"` // "Analytical Ability", "Verbal Ability", or "Quantitative Skills"
	QuestionText string `json:"question_text"`
	OptionA      string `json:"option_a"`
	OptionB      string `json:"option_b"`
	OptionC      string `json:"option_c"`
	OptionD      string `json:"option_d"`
}

// Answer holds the correct option for one question.
// QuestionText and Section are populated only in list responses (admin view);
// they are omitempty so they are absent when the struct is used elsewhere.
type Answer struct {
	ID            int    `json:"id"`
	QuestionID    int    `json:"question_id"`
	QuestionText  string `json:"question_text,omitempty"`
	Section       string `json:"section,omitempty"`
	CorrectOption string `json:"correct_option"` // "A", "B", "C", or "D"
}

// SelectedAnswer is one participant's answer to a single question.
// It is used as the element type in the test submission request body.
type SelectedAnswer struct {
	QuestionID     int    `json:"question_id"`
	SelectedOption string `json:"selected_option"` // "A"–"D", or "" if skipped
}

// SubmitTestRequest is the JSON body sent by the test page when a participant
// submits. ParticipantID identifies who is submitting; Answers contains one
// entry per question that was presented (45 total).
type SubmitTestRequest struct {
	ParticipantID int              `json:"participant_id"`
	Answers       []SelectedAnswer `json:"answers"`
}

// Result is the summary row returned by the results API.
// Rank is computed with DENSE_RANK() so tied participants share the same rank
// and no ranks are skipped.
type Result struct {
	SubmissionID      int     `json:"submission_id"`
	ParticipantID     int     `json:"participant_id"`
	FullName          string  `json:"full_name"`
	CIDNumber         string  `json:"cid_number"`
	CompanyName       string  `json:"company_name"`
	ContactNumber     string  `json:"contact_number"`
	Score             int     `json:"score"`
	TotalQuestions    int     `json:"total_questions"`
	AnalyticalScore   int     `json:"analytical_score"`
	VerbalScore       int     `json:"verbal_score"`
	QuantitativeScore int     `json:"quantitative_score"`
	Percentage        float64 `json:"percentage"`
	Rank              int     `json:"rank"`
	SubmittedAt       string  `json:"submitted_at"` // formatted by the DB as "YYYY-MM-DD HH24:MI"
}

// ParticipantAnswerDetail is one row in the per-question breakdown returned
// by the submission detail endpoint. It carries everything needed to render
// an answer sheet: the question, all options, what the participant chose,
// what was correct, and whether it was marked right.
type ParticipantAnswerDetail struct {
	QuestionID     int    `json:"question_id"`
	Section        string `json:"section"`
	QuestionText   string `json:"question_text"`
	OptionA        string `json:"option_a"`
	OptionB        string `json:"option_b"`
	OptionC        string `json:"option_c"`
	OptionD        string `json:"option_d"`
	SelectedOption string `json:"selected_option"`
	CorrectOption  string `json:"correct_option"`
	IsCorrect      bool   `json:"is_correct"`
}

// SubmissionDetail extends Result with a full per-question answer breakdown.
// The top-level fields are intentionally kept flat (not embedded) so the JSON
// shape remains the same as a Result object with an added "answers" array —
// this avoids a nested wrapper key that would require client-side changes.
type SubmissionDetail struct {
	SubmissionID      int                       `json:"submission_id"`
	ParticipantID     int                       `json:"participant_id"`
	FullName          string                    `json:"full_name"`
	CIDNumber         string                    `json:"cid_number"`
	CompanyName       string                    `json:"company_name"`
	ContactNumber     string                    `json:"contact_number"`
	Score             int                       `json:"score"`
	TotalQuestions    int                       `json:"total_questions"`
	AnalyticalScore   int                       `json:"analytical_score"`
	VerbalScore       int                       `json:"verbal_score"`
	QuantitativeScore int                       `json:"quantitative_score"`
	Percentage        float64                   `json:"percentage"`
	Rank              int                       `json:"rank"`
	SubmittedAt       string                    `json:"submitted_at"`
	Answers           []ParticipantAnswerDetail `json:"answers"`
}
