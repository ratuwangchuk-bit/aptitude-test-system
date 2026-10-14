package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/xuri/excelize/v2"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

// DashboardSummary returns aggregate statistics used by the admin dashboard cards.
// All five values are read in a single query so they are consistent with each other
// even if submissions arrive during the request.
func DashboardSummary(w http.ResponseWriter, r *http.Request) {
	var totalParticipants, appearedParticipants, highestScore, lowestScore int
	var averageScore float64

	err := config.DB.QueryRow(`
		SELECT
		    (SELECT COUNT(*) FROM participants)                  AS total_participants,
		    (SELECT COUNT(DISTINCT participant_id) FROM submissions) AS appeared,
		    COALESCE((SELECT MAX(score) FROM submissions), 0)    AS highest_score,
		    COALESCE((SELECT AVG(score) FROM submissions), 0)    AS average_score,
		    COALESCE((SELECT MIN(score) FROM submissions), 0)    AS lowest_score
	`).Scan(&totalParticipants, &appearedParticipants, &highestScore, &averageScore, &lowestScore)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load dashboard statistics")
		return
	}

	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"total_participants":    totalParticipants,
		"appeared_participants": appearedParticipants,
		"highest_score":         highestScore,
		"average_score":         averageScore,
		"lowest_score":          lowestScore,
	})
}

// ExportResults generates and streams an Excel file with all results.
// Section columns are built dynamically from the active test_sections configuration.
func ExportResults(w http.ResponseWriter, r *http.Request) {
	sections, _ := loadActiveSections()

	rows, err := config.DB.Query(`
		SELECT p.full_name, p.cid_number, p.company_name, p.contact_number,
		       s.score, s.total_questions, s.percentage,
		       DENSE_RANK() OVER (ORDER BY s.percentage DESC) AS rank,
		       to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at,
		       s.id AS submission_id
		FROM submissions s
		JOIN participants p ON s.participant_id = p.id
		ORDER BY rank ASC`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load results")
		return
	}
	defer rows.Close()

	// Collect all submissions first so we can look up section scores.
	type row struct {
		fullName, cidNumber, companyName, contactNumber string
		score, totalQuestions                           int
		percentage                                      float64
		rank                                            int
		submittedAt                                     string
		submissionID                                    int
	}
	var allRows []row
	var exportIDs []int
	for rows.Next() {
		var r row
		if err := rows.Scan(
			&r.fullName, &r.cidNumber, &r.companyName, &r.contactNumber,
			&r.score, &r.totalQuestions, &r.percentage, &r.rank, &r.submittedAt, &r.submissionID,
		); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read results")
			return
		}
		exportIDs = append(exportIDs, r.submissionID)
		allRows = append(allRows, r)
	}

	// Load all section scores in one query instead of once per row.
	exportSectionMap := loadSectionScoresBatch(exportIDs)

	f := excelize.NewFile()
	defer f.Close()
	sheet := "Results"
	f.SetSheetName("Sheet1", sheet)

	// Build dynamic headers.
	headers := []string{"Rank", "Full Name", "CID Number", "Company", "Contact Number",
		fmt.Sprintf("Total Score (/%d)", totalQuestionsFromSections(sections))}
	for _, sec := range sections {
		headers = append(headers, fmt.Sprintf("%s (/%d)", sec.Label, sec.QuestionsPerTest))
	}
	headers = append(headers, "Percentage (%)", "Submitted At (BST)")

	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(sheet, cell, h)
	}

	bst := time.FixedZone("BST", 6*60*60)
	for rowNum, r := range allRows {
		scoreBySection := make(map[string]int)
		for _, ss := range exportSectionMap[r.submissionID] {
			scoreBySection[ss.SectionName] = ss.Score
		}

		submittedAtBST := "-"
		if t, parseErr := time.Parse("2006-01-02 15:04", r.submittedAt); parseErr == nil {
			submittedAtBST = t.In(bst).Format("Jan 2, 2006, 3:04 PM")
		}

		values := []interface{}{
			r.rank, r.fullName, r.cidNumber, r.companyName, r.contactNumber,
			fmt.Sprintf("%d/%d", r.score, r.totalQuestions),
		}
		for _, sec := range sections {
			values = append(values, scoreBySection[sec.Name])
		}
		values = append(values, fmt.Sprintf("%.1f%%", r.percentage), submittedAtBST)

		for i, v := range values {
			cell, _ := excelize.CoordinatesToCellName(i+1, rowNum+2)
			f.SetCellValue(sheet, cell, v)
		}
	}

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="DAES_Results.xlsx"`)
	f.Write(w) //nolint:errcheck
}

func totalQuestionsFromSections(sections []models.TestSection) int {
	total := 0
	for _, s := range sections {
		total += s.QuestionsPerTest
	}
	return total
}

// DeleteResult removes a single submission by its ID and resets the participant
// so they can retake the test with a clean slate: fresh question draw and a
// reset timer. participant_answers and submission_section_scores are removed
// automatically via ON DELETE CASCADE on the submissions foreign key.
func DeleteResult(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]

	tx, err := config.DB.Begin()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not start transaction")
		return
	}
	defer tx.Rollback()

	// Find the participant_id before deleting so we can reset their state.
	var participantID int
	if err := tx.QueryRow(
		"SELECT participant_id FROM submissions WHERE id=$1", id,
	).Scan(&participantID); err != nil {
		utils.Error(w, http.StatusNotFound, "Result not found")
		return
	}

	if _, err := tx.Exec("DELETE FROM submissions WHERE id=$1", id); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete result")
		return
	}

	// Reset the participant so their next attempt is fully fresh:
	// - assigned_question_ids cleared → a new random question set will be drawn
	// - started_at cleared            → the countdown timer resets to full duration
	// - passcode_id cleared           → forces re-entry through the passcode gate
	// - is_suspended cleared          → removes any lingering suspension flag
	if _, err := tx.Exec(
		"UPDATE participants SET assigned_question_ids = NULL, started_at = NULL, passcode_id = NULL, is_suspended = FALSE WHERE id=$1",
		participantID,
	); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not reset participant state")
		return
	}

	if err := tx.Commit(); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not complete deletion")
		return
	}

	utils.JSON(w, http.StatusOK, map[string]string{"message": "Result deleted. The participant may now retake the test."})
}

// LiveProgressRow is the per-participant summary returned by GetLiveProgress.
type LiveProgressRow struct {
	ID               int    `json:"id"`
	FullName         string `json:"full_name"`
	CIDNumber        string `json:"cid_number"`
	CompanyName      string `json:"company_name"`
	ContactNumber    string `json:"contact_number"`
	Status           string `json:"status"`           // not_started | in_progress | suspended | timed_out | submitted
	StartedAt        string `json:"started_at"`        // "" if not started
	SubmittedAt      string `json:"submitted_at"`      // "" unless submitted; frozen end-time
	ElapsedSeconds   int    `json:"elapsed_seconds"`   // frozen at submission for submitted; live otherwise
	RemainingSeconds int    `json:"remaining_seconds"` // 0 when timed out or submitted
	TotalQuestions   int    `json:"total_questions"`   // size of assigned set; 0 before questions loaded
	Answered         int    `json:"answered"`          // live heartbeat count
	HasSubmitted     bool   `json:"has_submitted"`
	IsSuspended      bool   `json:"is_suspended"`
}

// GetLiveProgress returns every registered participant's live test status so the
// admin can watch the exam in real time. It reads the progress_answered heartbeat
// written by the test page and computes status + remaining time server-side.
func GetLiveProgress(w http.ResponseWriter, r *http.Request) {
	cfg := loadTestConfig()
	duration := cfg.TestDurationMinutes * 60

	rows, err := config.DB.Query(`
		SELECT p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
		       p.started_at,
		       COALESCE(array_length(p.assigned_question_ids, 1), 0) AS total_questions,
		       p.progress_answered,
		       EXISTS(SELECT 1 FROM submissions s WHERE s.participant_id = p.id) AS has_submitted,
		       COALESCE(p.is_suspended, FALSE) AS is_suspended,
		       (SELECT s.submitted_at FROM submissions s WHERE s.participant_id = p.id LIMIT 1) AS submitted_at
		FROM participants p
		ORDER BY
		  CASE
		    WHEN EXISTS(SELECT 1 FROM submissions s WHERE s.participant_id=p.id) THEN 4
		    WHEN COALESCE(p.is_suspended, FALSE) THEN 3
		    WHEN p.started_at IS NOT NULL THEN 1
		    ELSE 2
		  END,
		  p.started_at ASC NULLS LAST,
		  p.created_at DESC`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load live progress")
		return
	}
	defer rows.Close()

	result := []LiveProgressRow{}
	for rows.Next() {
		var row LiveProgressRow
		var startedAt, submittedAt sql.NullTime
		if err := rows.Scan(
			&row.ID, &row.FullName, &row.CIDNumber, &row.CompanyName, &row.ContactNumber,
			&startedAt, &row.TotalQuestions, &row.Answered, &row.HasSubmitted, &row.IsSuspended,
			&submittedAt,
		); err != nil {
			continue
		}

		if row.HasSubmitted {
			row.Status = "submitted"
			if startedAt.Valid {
				row.StartedAt = startedAt.Time.UTC().Format("2006-01-02 15:04")
			}
			if submittedAt.Valid {
				row.SubmittedAt = submittedAt.Time.UTC().Format("2006-01-02 15:04")
				// Freeze elapsed at the actual duration the participant used, not time.Since.
				if startedAt.Valid {
					elapsed := int(submittedAt.Time.Sub(startedAt.Time).Seconds())
					if elapsed < 0 {
						elapsed = 0
					}
					row.ElapsedSeconds = elapsed
				}
			}
		} else if startedAt.Valid {
			elapsed := int(time.Since(startedAt.Time).Seconds())
			if elapsed < 0 {
				elapsed = 0
			}
			row.StartedAt = startedAt.Time.UTC().Format("2006-01-02 15:04")
			row.ElapsedSeconds = elapsed
			remaining := duration - elapsed
			if remaining < 0 {
				remaining = 0
			}
			row.RemainingSeconds = remaining
			if row.IsSuspended {
				row.Status = "suspended"
			} else if elapsed > duration+120 {
				row.Status = "timed_out"
			} else {
				row.Status = "in_progress"
			}
		} else {
			if row.IsSuspended {
				row.Status = "suspended"
			} else {
				row.Status = "not_started"
			}
		}

		result = append(result, row)
	}
	utils.JSON(w, http.StatusOK, result)
}

// SuspendParticipant toggles the is_suspended flag on a participant. When suspended,
// the test-availability check returns false, triggering auto-submission on the
// participant's browser within the next 30-second poll window.
func SuspendParticipant(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	var req struct {
		Suspend bool `json:"suspend"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	result, err := config.DB.Exec(
		"UPDATE participants SET is_suspended=$1 WHERE id=$2", req.Suspend, id,
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not update participant")
		return
	}
	if n, _ := result.RowsAffected(); n == 0 {
		utils.Error(w, http.StatusNotFound, "Participant not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// AllowResume saves a participant's submitted answers back to the participants
// row, deletes the submission (while keeping started_at and assigned_question_ids
// intact), and clears any suspension flag. The next time the participant opens
// the test page, StartTest returns saved_answers so their previous selections are
// pre-populated. The timer continues from started_at (or resets if already expired,
// via StartTest's own auto-reset logic).
func AllowResume(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]

	tx, err := config.DB.Begin()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not start transaction")
		return
	}
	defer tx.Rollback()

	var submissionID int
	if err := tx.QueryRow(
		"SELECT id FROM submissions WHERE participant_id=$1", id,
	).Scan(&submissionID); err != nil {
		utils.Error(w, http.StatusNotFound, "No submission found for this participant")
		return
	}

	answerRows, err := tx.Query(
		"SELECT question_id, selected_option FROM participant_answers WHERE submission_id=$1 AND selected_option != ''",
		submissionID,
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load answers")
		return
	}
	defer answerRows.Close()
	answers := make(map[string]string)
	for answerRows.Next() {
		var qid int
		var opt string
		if answerRows.Scan(&qid, &opt) == nil && opt != "" {
			answers[fmt.Sprintf("%d", qid)] = opt
		}
	}
	answerRows.Close()

	answersJSON, err := json.Marshal(answers)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not serialize answers")
		return
	}

	if _, err := tx.Exec("DELETE FROM submissions WHERE id=$1", submissionID); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete submission")
		return
	}

	// Preserve started_at, assigned_question_ids, and passcode_id so the timer and
	// question set remain the same. Only save answers and clear the suspension flag.
	if _, err := tx.Exec(
		"UPDATE participants SET saved_answers=$1, is_suspended=FALSE WHERE id=$2",
		string(answersJSON), id,
	); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save resume state")
		return
	}

	if err := tx.Commit(); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not complete restore")
		return
	}

	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"ok":           true,
		"answers_saved": len(answers),
	})
}

// loadSectionScoresBatch fetches section scores for all given submission IDs in a
// single query, returning a map[submissionID][]SectionScore. This avoids the N+1
// pattern where loadSectionScores was called once per result row.
func loadSectionScoresBatch(ids []int) map[int][]models.SectionScore {
	out := make(map[int][]models.SectionScore, len(ids))
	if len(ids) == 0 {
		return out
	}
	idArg := make([]int64, len(ids))
	for i, id := range ids {
		idArg[i] = int64(id)
	}
	rows, err := config.DB.Query(
		`SELECT sss.submission_id, sss.section_name, sss.score, sss.questions_count
		 FROM submission_section_scores sss
		 LEFT JOIN test_sections ts ON ts.name = sss.section_name
		 WHERE sss.submission_id = ANY($1)
		 ORDER BY sss.submission_id, COALESCE(ts.sort_order, 9999), ts.id, sss.section_name`,
		idArg,
	)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var submID int
		var s models.SectionScore
		if rows.Scan(&submID, &s.SectionName, &s.Score, &s.QuestionsCount) == nil {
			out[submID] = append(out[submID], s)
		}
	}
	return out
}

// GetResults returns all submissions with computed rank and per-section scores.
// Section scores are loaded in a single batch query to avoid N+1 DB round-trips.
func GetResults(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT s.id, p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
		       s.score, s.total_questions, s.percentage,
		       DENSE_RANK() OVER (ORDER BY s.percentage DESC) AS rank,
		       to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at
		FROM submissions s
		JOIN participants p ON s.participant_id=p.id
		ORDER BY rank ASC`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load results")
		return
	}
	defer rows.Close()

	results := []models.Result{}
	var ids []int
	for rows.Next() {
		var res models.Result
		if err := rows.Scan(
			&res.SubmissionID, &res.ParticipantID, &res.FullName, &res.CIDNumber,
			&res.CompanyName, &res.ContactNumber, &res.Score, &res.TotalQuestions,
			&res.Percentage, &res.Rank, &res.SubmittedAt,
		); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read results")
			return
		}
		ids = append(ids, res.SubmissionID)
		results = append(results, res)
	}

	// Single batch query replaces N individual loadSectionScores calls.
	sectionMap := loadSectionScoresBatch(ids)
	for i := range results {
		results[i].SectionScores = sectionMap[results[i].SubmissionID]
		if results[i].SectionScores == nil {
			results[i].SectionScores = []models.SectionScore{}
		}
	}
	utils.JSON(w, http.StatusOK, results)
}
