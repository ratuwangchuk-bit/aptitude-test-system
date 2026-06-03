package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gorilla/mux"
	"github.com/lib/pq"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

// SubmitTest processes a participant's completed test.
// The handler runs inside a database transaction to ensure the submission row,
// all per-question answer rows, and the final score update are written atomically —
// either everything commits or nothing does.
//
// Scoring flow:
//  1. Check for a duplicate submission (idempotency guard).
//  2. Open a transaction and insert a placeholder submission row to get an ID.
//  3. Fetch the correct answers for all submitted question IDs in one query (avoids N+1).
//  4. Score each answer; accumulate per-section scores.
//  5. Bulk-insert all participant_answers rows in a single statement.
//  6. Update the submission row with the final scores.
//  7. Commit.
func SubmitTest(w http.ResponseWriter, r *http.Request) {
	var req models.SubmitTestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.ParticipantID == 0 {
		utils.Error(w, http.StatusBadRequest, "Participant ID is required")
		return
	}
	if len(req.Answers) == 0 {
		utils.Error(w, http.StatusBadRequest, "No test answers received")
		return
	}

	// Guard against duplicate submissions (e.g. double-click or network retry).
	var alreadySubmitted bool
	if err := config.DB.QueryRow(
		"SELECT EXISTS(SELECT 1 FROM submissions WHERE participant_id=$1)",
		req.ParticipantID,
	).Scan(&alreadySubmitted); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not verify submission status")
		return
	}
	if alreadySubmitted {
		utils.Error(w, http.StatusConflict, "You have already submitted this test")
		return
	}

	tx, err := config.DB.Begin()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not start submission")
		return
	}
	defer tx.Rollback() // No-op after a successful Commit().

	total := len(req.Answers)
	var submissionID int
	err = tx.QueryRow(
		`INSERT INTO submissions (participant_id, total_questions) VALUES ($1, $2) RETURNING id`,
		req.ParticipantID, total,
	).Scan(&submissionID)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not create submission")
		return
	}

	// answerKey holds the correct option and section for one question.
	type answerKey struct {
		correct string
		section string
	}

	// Fetch correct answers for all submitted question IDs in a single query
	// rather than one query per answer. Under 45 answers this avoids 44 extra
	// round-trips to the database — important for reliability under concurrent load.
	answerMap := make(map[int]answerKey, len(req.Answers))
	qIDs := make([]int, 0, len(req.Answers))
	for _, ans := range req.Answers {
		qIDs = append(qIDs, ans.QuestionID)
	}

	if len(qIDs) > 0 {
		rows, err := tx.Query(`
			SELECT a.question_id, a.correct_option, q.section
			FROM answers a JOIN questions q ON a.question_id=q.id
			WHERE a.question_id = ANY($1)`,
			pq.Array(qIDs),
		)
		if err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not load answer key")
			return
		}
		for rows.Next() {
			var qid int
			var correct, section string
			if rows.Scan(&qid, &correct, &section) == nil {
				answerMap[qid] = answerKey{correct, section}
			}
		}
		rows.Close()
	}

	// Score each submitted answer and collect them for the bulk insert below.
	score, analyticalScore, verbalScore, quantitativeScore := 0, 0, 0, 0

	type scoredAnswer struct {
		questionID int
		selected   string
		isCorrect  bool
	}
	validAnswers := make([]scoredAnswer, 0, len(req.Answers))

	for _, ans := range req.Answers {
		selected := strings.ToUpper(strings.TrimSpace(ans.SelectedOption))
		// Skip answers with invalid option values (e.g. empty string for unanswered).
		if selected != "A" && selected != "B" && selected != "C" && selected != "D" {
			continue
		}
		key := answerMap[ans.QuestionID]
		isCorrect := key.correct != "" && key.correct == selected
		if isCorrect {
			score++
			switch key.section {
			case "Analytical Ability":
				analyticalScore++
			case "Verbal Ability":
				verbalScore++
			case "Quantitative Skills":
				quantitativeScore++
			}
		}
		validAnswers = append(validAnswers, scoredAnswer{ans.QuestionID, selected, isCorrect})
	}

	// Build a single multi-row INSERT for all participant_answers rather than
	// executing 45 individual statements. This keeps the transaction open for
	// the shortest possible time, reducing contention under concurrent submissions.
	if len(validAnswers) > 0 {
		placeholders := make([]string, len(validAnswers))
		args := make([]any, 0, len(validAnswers)*4)
		for i, a := range validAnswers {
			base := i * 4
			placeholders[i] = fmt.Sprintf("($%d,$%d,$%d,$%d)", base+1, base+2, base+3, base+4)
			args = append(args, submissionID, a.questionID, a.selected, a.isCorrect)
		}
		_, err = tx.Exec(
			`INSERT INTO participant_answers (submission_id, question_id, selected_option, is_correct) VALUES `+
				strings.Join(placeholders, ","),
			args...,
		)
		if err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not save participant answers")
			return
		}
	}

	percentage := 0.0
	if total > 0 {
		percentage = (float64(score) / float64(total)) * 100
	}

	// Write the final scores back to the submission row created earlier.
	_, err = tx.Exec(`
		UPDATE submissions
		SET score=$1, percentage=$2, analytical_score=$3, verbal_score=$4, quantitative_score=$5
		WHERE id=$6`,
		score, percentage, analyticalScore, verbalScore, quantitativeScore, submissionID,
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save result")
		return
	}

	if err = tx.Commit(); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Submission failed")
		return
	}

	utils.JSON(w, http.StatusOK, map[string]any{
		"message":       "Thank you for participating. Please wait for good news.",
		"submission_id": submissionID,
	})
}

// GetSubmissionDetail returns a full per-question breakdown for a single submission.
// It is used by the admin "View answer sheet" panel to show what the participant
// chose for each question alongside the correct answer.
func GetSubmissionDetail(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]

	var detail models.SubmissionDetail
	err := config.DB.QueryRow(`
		SELECT s.id, p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
		       s.score, s.total_questions,
		       COALESCE(s.analytical_score,0), COALESCE(s.verbal_score,0), COALESCE(s.quantitative_score,0),
		       s.percentage,
		       DENSE_RANK() OVER (ORDER BY s.score DESC) AS rank,
		       to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at
		FROM submissions s JOIN participants p ON s.participant_id=p.id
		WHERE s.id=$1`,
		id,
	).Scan(
		&detail.SubmissionID, &detail.ParticipantID, &detail.FullName, &detail.CIDNumber,
		&detail.CompanyName, &detail.ContactNumber, &detail.Score, &detail.TotalQuestions,
		&detail.AnalyticalScore, &detail.VerbalScore, &detail.QuantitativeScore,
		&detail.Percentage, &detail.Rank, &detail.SubmittedAt,
	)
	if err != nil {
		utils.Error(w, http.StatusNotFound, "Result not found")
		return
	}

	// Fetch the per-question breakdown ordered by section then question ID so the
	// detail panel groups questions consistently regardless of submission order.
	rows, err := config.DB.Query(`
		SELECT q.id, q.section, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
		       pa.selected_option, COALESCE(a.correct_option, '') AS correct_option, pa.is_correct
		FROM participant_answers pa
		JOIN questions q ON pa.question_id = q.id
		LEFT JOIN answers a ON a.question_id = q.id
		WHERE pa.submission_id = $1
		ORDER BY q.section, q.id`,
		id,
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load answers")
		return
	}
	defer rows.Close()

	detail.Answers = []models.ParticipantAnswerDetail{}
	for rows.Next() {
		var ans models.ParticipantAnswerDetail
		if err := rows.Scan(
			&ans.QuestionID, &ans.Section, &ans.QuestionText,
			&ans.OptionA, &ans.OptionB, &ans.OptionC, &ans.OptionD,
			&ans.SelectedOption, &ans.CorrectOption, &ans.IsCorrect,
		); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read answers")
			return
		}
		detail.Answers = append(detail.Answers, ans)
	}

	utils.JSON(w, http.StatusOK, detail)
}

// CheckSubmission reports whether a participant has already submitted the test.
// The test page polls this on load so a participant who already submitted
// (e.g. via auto-submit on tab close) sees a "test already submitted" message
// instead of a blank test form.
func CheckSubmission(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["participantId"]
	var submitted bool
	if err := config.DB.QueryRow(
		"SELECT EXISTS(SELECT 1 FROM submissions WHERE participant_id=$1)", id,
	).Scan(&submitted); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not check submission status")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]bool{"submitted": submitted})
}

// GetParticipantResult returns the most recent submission summary for a participant.
// It is used by the result page to display a participant's own score after submission.
func GetParticipantResult(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["participantId"]
	var res models.Result
	err := config.DB.QueryRow(`
		SELECT s.id, p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
		       s.score, s.total_questions,
		       COALESCE(s.analytical_score,0), COALESCE(s.verbal_score,0), COALESCE(s.quantitative_score,0),
		       s.percentage,
		       to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI')
		FROM submissions s JOIN participants p ON s.participant_id=p.id
		WHERE p.id=$1
		ORDER BY s.submitted_at DESC LIMIT 1`,
		id,
	).Scan(
		&res.SubmissionID, &res.ParticipantID, &res.FullName, &res.CIDNumber,
		&res.CompanyName, &res.ContactNumber, &res.Score, &res.TotalQuestions,
		&res.AnalyticalScore, &res.VerbalScore, &res.QuantitativeScore,
		&res.Percentage, &res.SubmittedAt,
	)
	if err != nil {
		utils.Error(w, http.StatusNotFound, "Result not found")
		return
	}
	utils.JSON(w, http.StatusOK, res)
}
