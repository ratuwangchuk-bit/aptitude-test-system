package models

// Admin represents an administrator account stored in the admins table.
// PasswordHash is excluded from JSON responses (json:"-") so it is never
// sent to the browser, even accidentally.
type Admin struct {
	ID           int    `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
	Role         string `json:"role"`      // "super_admin" or "general_admin"
	IsActive     bool   `json:"is_active"` // false = account revoked, cannot log in
}

// TestConfig holds the singleton runtime configuration row from test_config.
// All time values are in minutes. The row is read on every relevant request so
// changes made in the admin UI take effect immediately without a restart.
type TestConfig struct {
	TestDurationMinutes      int `json:"test_duration_minutes"`
	PasscodeValidityMinutes  int `json:"passcode_validity_minutes"`
}

// TestSection represents one configurable section of the aptitude test.
// QuestionsPerTest controls how many random questions are drawn per participant.
type TestSection struct {
	ID               int    `json:"id"`
	Name             string `json:"name"`               // stored in questions.section
	Label            string `json:"label"`              // display label, e.g. "Section A"
	QuestionsPerTest int    `json:"questions_per_test"` // how many to show per participant
	SortOrder        int    `json:"sort_order"`
	IsActive         bool   `json:"is_active"`
	BankCount        int    `json:"bank_count,omitempty"` // computed: total questions in DB for this section
}

// SectionScore is one row from submission_section_scores — the score a
// participant achieved in a single section of their test.
type SectionScore struct {
	SectionName    string `json:"section_name"`
	Score          int    `json:"score"`
	QuestionsCount int    `json:"questions_count"`
}

// Passcode is a single-use entry token generated for each participant batch.
// It expires after the configured passcode_validity_minutes. Status is computed
// by the database ("Active" / "Expired") and is read-only.
type Passcode struct {
	ID        int    `json:"id"`
	Code      string `json:"code"`       // e.g. "DAES-A1B2C3D4"
	CreatedAt string `json:"created_at"` // formatted by the DB as "YYYY-MM-DD HH24:MI"
	ExpiresAt string `json:"expires_at"`
	Status    string `json:"status"` // "Active" or "Expired" — derived, not stored
}

// Participant holds the pre-registered details of a test taker.
// HasSubmitted is computed at query time (not a stored column).
type Participant struct {
	ID            int    `json:"id"`
	FullName      string `json:"full_name"`
	CIDNumber     string `json:"cid_number"`
	CompanyName   string `json:"company_name"`
	ContactNumber string `json:"contact_number"`
	CreatedAt     string `json:"created_at"`
	HasSubmitted  bool   `json:"has_submitted"`
}

// Question is one multiple-choice question shown during the test.
// ImageURL is optional; when set it points to a static image served alongside
// the question text.
type Question struct {
	ID           int    `json:"id"`
	Section      string `json:"section"`
	QuestionText string `json:"question_text"`
	QuestionType string `json:"question_type"` // "mcq" | "fill_blank"
	OptionA      string `json:"option_a"`
	OptionB      string `json:"option_b"`
	OptionC      string `json:"option_c"`
	OptionD      string `json:"option_d"`
	OptionE      string `json:"option_e"`
	ImageURL     string `json:"image_url,omitempty"` // path served by the static file server
}

// Answer holds the correct option for one question.
type Answer struct {
	ID            int    `json:"id"`
	QuestionID    int    `json:"question_id"`
	QuestionText  string `json:"question_text,omitempty"`
	Section       string `json:"section,omitempty"`
	CorrectOption string `json:"correct_option"` // MCQ: "A"–"D"; fill_blank: comma-separated accepted keywords
}

// SelectedAnswer is one participant's answer to a single question.
type SelectedAnswer struct {
	QuestionID     int    `json:"question_id"`
	SelectedOption string `json:"selected_option"` // MCQ: "A"–"D"; fill_blank: free text; "" if skipped
}

// SubmitTestRequest is the JSON body sent by the test page on submission.
type SubmitTestRequest struct {
	ParticipantID int              `json:"participant_id"`
	Answers       []SelectedAnswer `json:"answers"`
}

// Result is the summary row returned by the results API.
// SectionScores holds the per-section breakdown from submission_section_scores;
// the three legacy fields (AnalyticalScore etc.) are kept for backward
// compatibility with submissions created before this feature was added.
type Result struct {
	SubmissionID      int            `json:"submission_id"`
	ParticipantID     int            `json:"participant_id"`
	FullName          string         `json:"full_name"`
	CIDNumber         string         `json:"cid_number"`
	CompanyName       string         `json:"company_name"`
	ContactNumber     string         `json:"contact_number"`
	Score             int            `json:"score"`
	TotalQuestions    int            `json:"total_questions"`
	AnalyticalScore   int            `json:"analytical_score"`
	VerbalScore       int            `json:"verbal_score"`
	QuantitativeScore int            `json:"quantitative_score"`
	Percentage        float64        `json:"percentage"`
	Rank              int            `json:"rank"`
	SubmittedAt       string         `json:"submitted_at"`
	SectionScores     []SectionScore `json:"section_scores"`
}

// ParticipantAnswerDetail is one row in the per-question breakdown.
type ParticipantAnswerDetail struct {
	QuestionID     int    `json:"question_id"`
	Section        string `json:"section"`
	QuestionText   string `json:"question_text"`
	ImageURL       string `json:"image_url,omitempty"`
	OptionA        string `json:"option_a"`
	OptionB        string `json:"option_b"`
	OptionC        string `json:"option_c"`
	OptionD        string `json:"option_d"`
	OptionE        string `json:"option_e"`
	SelectedOption string `json:"selected_option"`
	CorrectOption  string `json:"correct_option"`
	IsCorrect      bool   `json:"is_correct"`
}

// SubmissionDetail extends Result with a full per-question answer breakdown.
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
	SectionScores     []SectionScore            `json:"section_scores"`
	Answers           []ParticipantAnswerDetail `json:"answers"`
}
