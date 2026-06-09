package handlers

import (
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
func DashboardSummary(w http.ResponseWriter, r *http.Request) {
	var totalParticipants, appearedParticipants, highestScore, lowestScore int
	var averageScore float64

	config.DB.QueryRow("SELECT COUNT(*) FROM participants").Scan(&totalParticipants)
	config.DB.QueryRow("SELECT COUNT(DISTINCT participant_id) FROM submissions").Scan(&appearedParticipants)
	config.DB.QueryRow("SELECT COALESCE(MAX(score),0) FROM submissions").Scan(&highestScore)
	config.DB.QueryRow("SELECT COALESCE(AVG(score),0) FROM submissions").Scan(&averageScore)
	config.DB.QueryRow("SELECT COALESCE(MIN(score),0) FROM submissions").Scan(&lowestScore)

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
		       DENSE_RANK() OVER (ORDER BY s.score DESC) AS rank,
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
	for rows.Next() {
		var r row
		if err := rows.Scan(
			&r.fullName, &r.cidNumber, &r.companyName, &r.contactNumber,
			&r.score, &r.totalQuestions, &r.percentage, &r.rank, &r.submittedAt, &r.submissionID,
		); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read results")
			return
		}
		allRows = append(allRows, r)
	}

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
		sectionScores := loadSectionScores(r.submissionID)
		scoreBySection := make(map[string]int)
		for _, ss := range sectionScores {
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

// DeleteResult removes a single submission by its ID.
func DeleteResult(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	res, err := config.DB.Exec("DELETE FROM submissions WHERE id=$1", id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete result")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Result not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Result deleted successfully"})
}

// GetResults returns all submissions with computed rank and per-section scores.
func GetResults(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT s.id, p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
		       s.score, s.total_questions,
		       COALESCE(s.analytical_score,0), COALESCE(s.verbal_score,0), COALESCE(s.quantitative_score,0),
		       s.percentage,
		       DENSE_RANK() OVER (ORDER BY s.score DESC) AS rank,
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
	for rows.Next() {
		var res models.Result
		if err := rows.Scan(
			&res.SubmissionID, &res.ParticipantID, &res.FullName, &res.CIDNumber,
			&res.CompanyName, &res.ContactNumber, &res.Score, &res.TotalQuestions,
			&res.AnalyticalScore, &res.VerbalScore, &res.QuantitativeScore,
			&res.Percentage, &res.Rank, &res.SubmittedAt,
		); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read results")
			return
		}
		res.SectionScores = loadSectionScores(res.SubmissionID)
		results = append(results, res)
	}
	utils.JSON(w, http.StatusOK, results)
}
