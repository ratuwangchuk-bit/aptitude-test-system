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

// SubmitTest processes a participant's completed test atomically.
// Section scores are stored in submission_section_scores using the active
// test_sections configuration so they remain correct even if sections change later.
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

	// Load active sections before opening the transaction (read-only, no race risk).
	sections, err := loadActiveSections()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load test sections")
		return
	}
	sectionSet := make(map[string]bool, len(sections))
	for _, s := range sections {
		sectionSet[s.Name] = true
	}

	tx, err := config.DB.Begin()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not start submission")
		return
	}
	defer tx.Rollback()

	total := len(req.Answers)
	var submissionID int

	// Guard against duplicate submissions. The SELECT inside the same transaction
	// is sufficient for the common case. The pq unique-violation handler below
	// covers the rare concurrent race (works both with and without a UNIQUE
	// constraint on participant_id, so this is safe on older DB schemas too).
	var alreadySubmitted bool
	if scanErr := tx.QueryRow(
		"SELECT EXISTS(SELECT 1 FROM submissions WHERE participant_id=$1)",
		req.ParticipantID,
	).Scan(&alreadySubmitted); scanErr != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not check submission status")
		return
	}
	if alreadySubmitted {
		utils.Error(w, http.StatusConflict, "You have already submitted this test")
		return
	}

	err = tx.QueryRow(
		"INSERT INTO submissions (participant_id, total_questions) VALUES ($1, $2) RETURNING id",
		req.ParticipantID, total,
	).Scan(&submissionID)
	if err != nil {
		// 23505 = unique_violation — concurrent duplicate submission
		if pqErr, ok := err.(*pq.Error); ok && pqErr.Code == "23505" {
			utils.Error(w, http.StatusConflict, "You have already submitted this test")
			return
		}
		utils.Error(w, http.StatusInternalServerError, "Could not create submission")
		return
	}

	type answerKey struct {
		correct string
		section string
		qtype   string
	}
	answerMap := make(map[int]answerKey, len(req.Answers))
	qIDs := make([]int, 0, len(req.Answers))
	for _, ans := range req.Answers {
		qIDs = append(qIDs, ans.QuestionID)
	}

	if len(qIDs) > 0 {
		rows, err := tx.Query(`
			SELECT a.question_id, a.correct_option, q.section, COALESCE(q.question_type,'mcq')
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
			var correct, section, qtype string
			if rows.Scan(&qid, &correct, &section, &qtype) == nil {
				answerMap[qid] = answerKey{correct, section, qtype}
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read answer key")
			return
		}
	}

	score := 0
	// Track per-section correct counts dynamically.
	sectionScores := make(map[string]int)
	sectionCounts := make(map[string]int) // total questions per section in this submission

	type scoredAnswer struct {
		questionID int
		selected   any
		isCorrect  bool
	}
	allAnswers := make([]scoredAnswer, 0, len(req.Answers))

	for _, ans := range req.Answers {
		selected := strings.TrimSpace(ans.SelectedOption)
		key := answerMap[ans.QuestionID]
		isCorrect := false
		var selVal any

		// Primary: use the question_type field.
		// Fallback heuristic (legacy Excel uploads): if correct_option is non-empty and
		// is not a single A/B/C/D letter, treat as fill_blank.
		// The empty-string guard is critical: without it, questions with NO answer row
		// (correct_option='') would be misclassified as fill_blank and never scored.
		correctTrimmed := strings.TrimSpace(key.correct)
		isFillBlank := key.qtype == "fill_blank" ||
			(key.correct != "" && (len(correctTrimmed) != 1 || (correctTrimmed != "A" && correctTrimmed != "B" && correctTrimmed != "C" && correctTrimmed != "D" && correctTrimmed != "E")))

		if isFillBlank && key.correct != "" {
			// Match against any comma-separated keyword (case-insensitive, trimmed).
			if selected != "" {
				selVal = selected
				for _, kw := range strings.Split(key.correct, ",") {
					if strings.EqualFold(selected, strings.TrimSpace(kw)) {
						isCorrect = true
						break
					}
				}
				if isCorrect {
					score++
					sectionScores[key.section]++
				}
			}
		} else if !isFillBlank {
			// MCQ: expect A/B/C/D/E.
			upper := strings.ToUpper(selected)
			if upper == "A" || upper == "B" || upper == "C" || upper == "D" || upper == "E" {
				selVal = upper
				isCorrect = key.correct != "" && key.correct == upper
				if isCorrect {
					score++
					sectionScores[key.section]++
				}
			}
		}
		if key.section != "" {
			sectionCounts[key.section]++
		}
		allAnswers = append(allAnswers, scoredAnswer{ans.QuestionID, selVal, isCorrect})
	}

	// Bulk-insert all participant_answers.
	if len(allAnswers) > 0 {
		placeholders := make([]string, len(allAnswers))
		args := make([]any, 0, len(allAnswers)*4)
		for i, a := range allAnswers {
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

	// Insert one row per section into submission_section_scores.
	for _, sec := range sections {
		_, err = tx.Exec(
			`INSERT INTO submission_section_scores (submission_id, section_name, score, questions_count)
			 VALUES ($1, $2, $3, $4)`,
			submissionID, sec.Name, sectionScores[sec.Name], sectionCounts[sec.Name],
		)
		if err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not save section scores")
			return
		}
	}

	percentage := 0.0
	if total > 0 {
		percentage = (float64(score) / float64(total)) * 100
	}

	// Keep legacy columns populated for backward compatibility with old queries.
	_, err = tx.Exec(`
		UPDATE submissions
		SET score=$1, percentage=$2,
		    analytical_score=$3, verbal_score=$4, quantitative_score=$5
		WHERE id=$6`,
		score, percentage,
		sectionScores["Analytical Ability"],
		sectionScores["Verbal Ability"],
		sectionScores["Quantitative Skills"],
		submissionID,
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

// loadSectionScores fetches submission_section_scores rows for one submission.
func loadSectionScores(submissionID int) []models.SectionScore {
	rows, err := config.DB.Query(
		"SELECT section_name, score, questions_count FROM submission_section_scores WHERE submission_id=$1 ORDER BY section_name",
		submissionID,
	)
	if err != nil {
		return []models.SectionScore{}
	}
	defer rows.Close()
	out := []models.SectionScore{}
	for rows.Next() {
		var s models.SectionScore
		if rows.Scan(&s.SectionName, &s.Score, &s.QuestionsCount) == nil {
			out = append(out, s)
		}
	}
	return out
}

// GetSubmissionDetail returns a full per-question breakdown for a single submission.
func GetSubmissionDetail(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]

	var detail models.SubmissionDetail
	err := config.DB.QueryRow(`
		SELECT id, pid, full_name, cid_number, company_name, contact_number,
		       score, total_questions, analytical_score, verbal_score, quantitative_score,
		       percentage, rank, submitted_at
		FROM (
			SELECT s.id, p.id AS pid, p.full_name, p.cid_number, p.company_name, p.contact_number,
			       s.score, s.total_questions,
			       COALESCE(s.analytical_score,0) AS analytical_score,
			       COALESCE(s.verbal_score,0)     AS verbal_score,
			       COALESCE(s.quantitative_score,0) AS quantitative_score,
			       s.percentage,
			       DENSE_RANK() OVER (ORDER BY s.score DESC) AS rank,
			       to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at
			FROM submissions s JOIN participants p ON s.participant_id=p.id
		) ranked
		WHERE id=$1`,
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

	detail.SectionScores = loadSectionScores(detail.SubmissionID)

	rows, err := config.DB.Query(`
		SELECT q.id, q.section, q.question_text, COALESCE(q.image_url,''),
		       q.option_a, q.option_b, q.option_c, q.option_d, COALESCE(q.option_e,''),
		       COALESCE(pa.selected_option, '') AS selected_option,
		       COALESCE(a.correct_option, '')   AS correct_option, pa.is_correct
		FROM participant_answers pa
		JOIN questions q ON pa.question_id = q.id
		LEFT JOIN answers a ON a.question_id = q.id
		LEFT JOIN test_sections ts ON ts.name = q.section
		WHERE pa.submission_id = $1
		ORDER BY COALESCE(ts.sort_order, 9999), ts.id, q.id`,
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
			&ans.QuestionID, &ans.Section, &ans.QuestionText, &ans.ImageURL,
			&ans.OptionA, &ans.OptionB, &ans.OptionC, &ans.OptionD, &ans.OptionE,
			&ans.SelectedOption, &ans.CorrectOption, &ans.IsCorrect,
		); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read answers")
			return
		}
		detail.Answers = append(detail.Answers, ans)
	}

	utils.JSON(w, http.StatusOK, detail)
}

// CheckSubmission reports whether a participant has already submitted.
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
func GetParticipantResult(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["participantId"]
	var res models.Result
	err := config.DB.QueryRow(`
		SELECT id, pid, full_name, cid_number, company_name, contact_number,
		       score, total_questions, analytical_score, verbal_score, quantitative_score,
		       percentage, rank, submitted_at
		FROM (
			SELECT s.id, p.id AS pid, p.full_name, p.cid_number, p.company_name, p.contact_number,
			       s.score, s.total_questions,
			       COALESCE(s.analytical_score,0)    AS analytical_score,
			       COALESCE(s.verbal_score,0)         AS verbal_score,
			       COALESCE(s.quantitative_score,0)   AS quantitative_score,
			       s.percentage,
			       DENSE_RANK() OVER (ORDER BY s.score DESC) AS rank,
			       to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at
			FROM submissions s JOIN participants p ON s.participant_id=p.id
		) ranked
		WHERE pid=$1
		ORDER BY submitted_at DESC LIMIT 1`,
		id,
	).Scan(
		&res.SubmissionID, &res.ParticipantID, &res.FullName, &res.CIDNumber,
		&res.CompanyName, &res.ContactNumber, &res.Score, &res.TotalQuestions,
		&res.AnalyticalScore, &res.VerbalScore, &res.QuantitativeScore,
		&res.Percentage, &res.Rank, &res.SubmittedAt,
	)
	if err != nil {
		utils.Error(w, http.StatusNotFound, "Result not found")
		return
	}
	res.SectionScores = loadSectionScores(res.SubmissionID)
	utils.JSON(w, http.StatusOK, res)
}
