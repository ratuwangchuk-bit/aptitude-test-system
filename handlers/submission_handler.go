package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gorilla/mux"

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

	score := 0
	analyticalScore := 0
	verbalScore := 0
	quantitativeScore := 0

	for _, ans := range req.Answers {
		selected := strings.ToUpper(strings.TrimSpace(ans.SelectedOption))
		if selected != "A" && selected != "B" && selected != "C" && selected != "D" {
			continue
		}

		var correctOption string
		var section string
		err := tx.QueryRow(`SELECT a.correct_option, q.section FROM answers a JOIN questions q ON a.question_id=q.id WHERE a.question_id=$1`, ans.QuestionID).Scan(&correctOption, &section)
		isCorrect := false
		if err == nil && correctOption == selected {
			isCorrect = true
			score++
			switch section {
			case "Analytical Ability":
				analyticalScore++
			case "Verbal Ability":
				verbalScore++
			case "Quantitative Skills":
				quantitativeScore++
			}
		}
		_, err = tx.Exec(`INSERT INTO participant_answers (submission_id, question_id, selected_option, is_correct)
            VALUES ($1, $2, $3, $4)`, submissionID, ans.QuestionID, selected, isCorrect)
		if err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not save participant answer")
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

	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"message":       "Thank you for participating. Please wait for good news.",
		"submission_id": submissionID,
	})
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
