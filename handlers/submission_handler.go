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

	var alreadySubmitted bool
	if err := config.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM submissions WHERE participant_id=$1)", req.ParticipantID).Scan(&alreadySubmitted); err != nil {
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
	defer tx.Rollback()

	total := len(req.Answers)
	var submissionID int
	err = tx.QueryRow(`INSERT INTO submissions (participant_id, total_questions) VALUES ($1, $2) RETURNING id`, req.ParticipantID, total).Scan(&submissionID)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not create submission")
		return
	}

	// Collect all question IDs from this submission, then fetch correct answers
	// in one query instead of one per answer (avoids N+1 under concurrent load).
	type answerKey struct {
		correct string
		section string
	}
	answerMap := make(map[int]answerKey, len(req.Answers))
	qIDs := make([]int, 0, len(req.Answers))
	for _, ans := range req.Answers {
		qIDs = append(qIDs, ans.QuestionID)
	}

	// pq.Array is not available here; build the IN list manually using a
	// temporary VALUES table which is safe and avoids a driver dependency.
	if len(qIDs) > 0 {
		rows, err := tx.Query(`SELECT a.question_id, a.correct_option, q.section
			FROM answers a JOIN questions q ON a.question_id=q.id
			WHERE a.question_id = ANY($1)`, pq.Array(qIDs))
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

	score := 0
	analyticalScore := 0
	verbalScore := 0
	quantitativeScore := 0

	type scoredAnswer struct {
		questionID int
		selected   string
		isCorrect  bool
	}
	validAnswers := make([]scoredAnswer, 0, len(req.Answers))

	for _, ans := range req.Answers {
		selected := strings.ToUpper(strings.TrimSpace(ans.SelectedOption))
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

	// Bulk-insert all participant answers in one statement instead of 45 individual
	// round-trips, keeping the transaction as short as possible under concurrent load.
	if len(validAnswers) > 0 {
		placeholders := make([]string, len(validAnswers))
		args := make([]any, 0, len(validAnswers)*4)
		for i, a := range validAnswers {
			base := i * 4
			placeholders[i] = fmt.Sprintf("($%d,$%d,$%d,$%d)", base+1, base+2, base+3, base+4)
			args = append(args, submissionID, a.questionID, a.selected, a.isCorrect)
		}
		_, err = tx.Exec(`INSERT INTO participant_answers (submission_id, question_id, selected_option, is_correct) VALUES `+
			strings.Join(placeholders, ","), args...)
		if err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not save participant answers")
			return
		}
	}

	percentage := 0.0
	if total > 0 {
		percentage = (float64(score) / float64(total)) * 100
	}

	_, err = tx.Exec(`UPDATE submissions SET score=$1, percentage=$2, analytical_score=$3, verbal_score=$4, quantitative_score=$5 WHERE id=$6`, score, percentage, analyticalScore, verbalScore, quantitativeScore, submissionID)
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

func GetSubmissionDetail(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]

	var detail models.SubmissionDetail
	err := config.DB.QueryRow(`
		SELECT s.id, p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
		       s.score, s.total_questions, COALESCE(s.analytical_score,0), COALESCE(s.verbal_score,0), COALESCE(s.quantitative_score,0), s.percentage,
		       DENSE_RANK() OVER (ORDER BY s.score DESC) AS rank,
		       to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at
		FROM submissions s JOIN participants p ON s.participant_id=p.id
		WHERE s.id=$1`, id).Scan(
		&detail.SubmissionID, &detail.ParticipantID, &detail.FullName, &detail.CIDNumber,
		&detail.CompanyName, &detail.ContactNumber, &detail.Score, &detail.TotalQuestions,
		&detail.AnalyticalScore, &detail.VerbalScore, &detail.QuantitativeScore, &detail.Percentage,
		&detail.Rank, &detail.SubmittedAt,
	)
	if err != nil {
		utils.Error(w, http.StatusNotFound, "Result not found")
		return
	}

	rows, err := config.DB.Query(`
		SELECT q.id, q.section, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
		       pa.selected_option, COALESCE(a.correct_option, '') AS correct_option, pa.is_correct
		FROM participant_answers pa
		JOIN questions q ON pa.question_id = q.id
		LEFT JOIN answers a ON a.question_id = q.id
		WHERE pa.submission_id = $1
		ORDER BY q.section, q.id`, id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load answers")
		return
	}
	defer rows.Close()

	detail.Answers = []models.ParticipantAnswerDetail{}
	for rows.Next() {
		var ans models.ParticipantAnswerDetail
		if err := rows.Scan(&ans.QuestionID, &ans.Section, &ans.QuestionText,
			&ans.OptionA, &ans.OptionB, &ans.OptionC, &ans.OptionD,
			&ans.SelectedOption, &ans.CorrectOption, &ans.IsCorrect); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read answers")
			return
		}
		detail.Answers = append(detail.Answers, ans)
	}

	utils.JSON(w, http.StatusOK, detail)
}

func CheckSubmission(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["participantId"]
	var submitted bool
	if err := config.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM submissions WHERE participant_id=$1)", id).Scan(&submitted); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not check submission status")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]bool{"submitted": submitted})
}

func GetParticipantResult(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["participantId"]
	var res models.Result
	err := config.DB.QueryRow(`SELECT s.id, p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
        s.score, s.total_questions, COALESCE(s.analytical_score,0), COALESCE(s.verbal_score,0), COALESCE(s.quantitative_score,0), s.percentage, to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI')
        FROM submissions s JOIN participants p ON s.participant_id=p.id
        WHERE p.id=$1 ORDER BY s.submitted_at DESC LIMIT 1`, id).Scan(&res.SubmissionID, &res.ParticipantID, &res.FullName, &res.CIDNumber, &res.CompanyName, &res.ContactNumber, &res.Score, &res.TotalQuestions, &res.AnalyticalScore, &res.VerbalScore, &res.QuantitativeScore, &res.Percentage, &res.SubmittedAt)
	if err != nil {
		utils.Error(w, http.StatusNotFound, "Result not found")
		return
	}
	utils.JSON(w, http.StatusOK, res)
}
