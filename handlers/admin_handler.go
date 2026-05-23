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

func DashboardSummary(w http.ResponseWriter, r *http.Request) {
	var totalParticipants int
	var appearedParticipants int
	var highestScore int
	var averageScore float64
	var lowestScore int

	config.DB.QueryRow("SELECT COUNT(*) FROM participants").Scan(&totalParticipants)
	config.DB.QueryRow("SELECT COUNT(DISTINCT participant_id) FROM submissions").Scan(&appearedParticipants)
	config.DB.QueryRow("SELECT COALESCE(MAX(score),0) FROM submissions").Scan(&highestScore)
	config.DB.QueryRow("SELECT COALESCE(AVG(score),0) FROM submissions").Scan(&averageScore)
	config.DB.QueryRow("SELECT COALESCE(MIN(score),0) FROM submissions").Scan(&lowestScore)

	summary := map[string]interface{}{
		"total_participants":    totalParticipants,
		"appeared_participants": appearedParticipants,
		"highest_score":         highestScore,
		"average_score":         averageScore,
		"lowest_score":          lowestScore,
	}
	utils.JSON(w, http.StatusOK, summary)
}

func ExportResults(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT p.full_name, p.cid_number, p.company_name, p.contact_number,
		       s.score, s.total_questions,
		       COALESCE(s.analytical_score,0), COALESCE(s.verbal_score,0), COALESCE(s.quantitative_score,0),
		       s.percentage,
		       DENSE_RANK() OVER (ORDER BY s.score DESC) AS rank,
		       to_char(s.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at
		FROM submissions s
		JOIN participants p ON s.participant_id = p.id
		ORDER BY rank ASC`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load results")
		return
	}
	defer rows.Close()

	f := excelize.NewFile()
	defer f.Close()

	sheet := "Results"
	f.SetSheetName("Sheet1", sheet)

	headers := []string{
		"Rank", "Full Name", "CID Number", "Company", "Contact Number",
		"Total Score (/45)", "Analytical (/15)", "Verbal (/15)", "Quantitative (/15)",
		"Percentage (%)", "Submitted At (BST)",
	}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(sheet, cell, h)
	}

	bst := time.FixedZone("BST", 6*60*60)
	rowNum := 2
	for rows.Next() {
		var (
			fullName, cidNumber, companyName, contactNumber string
			score, totalQuestions                           int
			analyticalScore, verbalScore, quantitativeScore int
			percentage                                      float64
			rank                                            int
			submittedAt                                     string
		)
		if err := rows.Scan(
			&fullName, &cidNumber, &companyName, &contactNumber,
			&score, &totalQuestions, &analyticalScore, &verbalScore, &quantitativeScore,
			&percentage, &rank, &submittedAt,
		); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read results")
			return
		}

		submittedAtBST := "-"
		if t, parseErr := time.Parse("2006-01-02 15:04", submittedAt); parseErr == nil {
			submittedAtBST = t.In(bst).Format("Jan 2, 2006, 3:04 PM")
		}

		values := []interface{}{
			rank, fullName, cidNumber, companyName, contactNumber,
			fmt.Sprintf("%d/%d", score, totalQuestions),
			analyticalScore, verbalScore, quantitativeScore,
			fmt.Sprintf("%.1f%%", percentage),
			submittedAtBST,
		}
		for i, v := range values {
			cell, _ := excelize.CoordinatesToCellName(i+1, rowNum)
			f.SetCellValue(sheet, cell, v)
		}
		rowNum++
	}

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="DAES_Results.xlsx"`)
	f.Write(w) //nolint:errcheck
}

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

func GetResults(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`SELECT s.id, p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
        s.score, s.total_questions, COALESCE(s.analytical_score,0), COALESCE(s.verbal_score,0), COALESCE(s.quantitative_score,0), s.percentage,
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
		if err := rows.Scan(&res.SubmissionID, &res.ParticipantID, &res.FullName, &res.CIDNumber, &res.CompanyName, &res.ContactNumber, &res.Score, &res.TotalQuestions, &res.AnalyticalScore, &res.VerbalScore, &res.QuantitativeScore, &res.Percentage, &res.Rank, &res.SubmittedAt); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read results")
			return
		}
		results = append(results, res)
	}
	utils.JSON(w, http.StatusOK, results)
}
