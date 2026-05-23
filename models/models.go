package models

type Admin struct {
	ID           int    `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
	Role         string `json:"role"`
	IsActive     bool   `json:"is_active"`
}

type Passcode struct {
	ID        int    `json:"id"`
	Code      string `json:"code"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
	Status    string `json:"status"`
}

type Participant struct {
	ID            int    `json:"id"`
	FullName      string `json:"full_name"`
	CIDNumber     string `json:"cid_number"`
	CompanyName   string `json:"company_name"`
	ContactNumber string `json:"contact_number"`
	CreatedAt     string `json:"created_at"`
	HasSubmitted  bool   `json:"has_submitted"`
}

type Question struct {
	ID           int    `json:"id"`
	Section      string `json:"section"`
	QuestionText string `json:"question_text"`
	OptionA      string `json:"option_a"`
	OptionB      string `json:"option_b"`
	OptionC      string `json:"option_c"`
	OptionD      string `json:"option_d"`
}

type Answer struct {
	ID            int    `json:"id"`
	QuestionID    int    `json:"question_id"`
	QuestionText  string `json:"question_text,omitempty"`
	Section       string `json:"section,omitempty"`
	CorrectOption string `json:"correct_option"`
}

type SelectedAnswer struct {
	QuestionID     int    `json:"question_id"`
	SelectedOption string `json:"selected_option"`
}

type SubmitTestRequest struct {
	ParticipantID int              `json:"participant_id"`
	Answers       []SelectedAnswer `json:"answers"`
}

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
	SubmittedAt       string  `json:"submitted_at"`
}

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
