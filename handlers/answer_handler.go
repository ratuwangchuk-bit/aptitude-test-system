package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gorilla/mux"
	"github.com/xuri/excelize/v2"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

// GetAnswers returns every answer row joined with its question text and section.
// The results are ordered by question_id so they align with the question list.
func GetAnswers(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT a.id, a.question_id, q.question_text, q.section, a.correct_option
		FROM answers a JOIN questions q ON a.question_id=q.id
		ORDER BY a.question_id ASC`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load answers")
		return
	}
	defer rows.Close()

	answers := []models.Answer{}
	for rows.Next() {
		var a models.Answer
		if err := rows.Scan(&a.ID, &a.QuestionID, &a.QuestionText, &a.Section, &a.CorrectOption); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read answers")
			return
		}
		answers = append(answers, a)
	}
	utils.JSON(w, http.StatusOK, answers)
}

// AddAnswer creates a new answer or updates an existing one for the same question.
// The ON CONFLICT upsert means this endpoint is idempotent — calling it twice
// with the same question_id simply updates the correct option rather than creating
// a duplicate row.
func AddAnswer(w http.ResponseWriter, r *http.Request) {
	var a models.Answer
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	a.CorrectOption = strings.ToUpper(a.CorrectOption)
	if a.CorrectOption != "A" && a.CorrectOption != "B" && a.CorrectOption != "C" && a.CorrectOption != "D" {
		utils.Error(w, http.StatusBadRequest, "Correct option must be A, B, C, or D")
		return
	}

	err := config.DB.QueryRow(`
		INSERT INTO answers (question_id, correct_option) VALUES ($1, $2)
		ON CONFLICT (question_id) DO UPDATE SET correct_option=EXCLUDED.correct_option
		RETURNING id`,
		a.QuestionID, a.CorrectOption,
	).Scan(&a.ID)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save answer")
		return
	}
	utils.JSON(w, http.StatusCreated, a)
}

// UpdateAnswer modifies the question_id and correct_option for an existing answer row.
// The correct_option is validated to be A, B, C, or D before the update.
func UpdateAnswer(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	var a models.Answer
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	a.CorrectOption = strings.ToUpper(a.CorrectOption)
	if a.CorrectOption != "A" && a.CorrectOption != "B" && a.CorrectOption != "C" && a.CorrectOption != "D" {
		utils.Error(w, http.StatusBadRequest, "Correct option must be A, B, C, or D")
		return
	}

	res, err := config.DB.Exec(
		"UPDATE answers SET question_id=$1, correct_option=$2 WHERE id=$3",
		a.QuestionID, a.CorrectOption, id,
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not update answer")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Answer not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Answer updated"})
}

// DeleteAnswer removes a single answer row by its ID.
func DeleteAnswer(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	res, err := config.DB.Exec("DELETE FROM answers WHERE id=$1", id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete answer")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Answer not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Answer deleted"})
}

// UploadAnswers bulk-imports correct answers from an Excel file.
// The file should have columns: question_id, correct_option (A/B/C/D).
// A backward-compatible fallback reads the first two columns by position if
// no recognised headers are found, so older template files still work.
// Rows with invalid question IDs or unrecognised options are silently skipped;
// the response returns the count of successfully processed rows.
func UploadAnswers(w http.ResponseWriter, r *http.Request) {
	file, _, err := r.FormFile("file")
	if err != nil {
		utils.Error(w, http.StatusBadRequest, "Excel file is required")
		return
	}
	defer file.Close()

	f, err := excelize.OpenReader(file)
	if err != nil {
		utils.Error(w, http.StatusBadRequest, "Could not read Excel file")
		return
	}
	defer f.Close()

	count := 0
	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil || len(rows) < 2 {
			continue
		}
		headerMap := excelHeaderMap(rows[0])
		for i, row := range rows {
			if i == 0 || isEmptyExcelRow(row) {
				continue
			}

			// Try named headers first, then fall back to positional columns.
			questionIDText := firstNonEmpty(
				valueByHeader(row, headerMap, "question_id"),
				valueByHeader(row, headerMap, "question id"),
				valueByHeader(row, headerMap, "id"),
			)
			correct := strings.ToUpper(firstNonEmpty(
				valueByHeader(row, headerMap, "correct_option"),
				valueByHeader(row, headerMap, "correct option"),
				valueByHeader(row, headerMap, "correct_answer"),
				valueByHeader(row, headerMap, "correct answer"),
				valueByHeader(row, headerMap, "answer"),
			))

			// Backward-compatible fallback: old files only have question_id in col 0
			// and correct_option in col 1 with no header row or positional parsing.
			if questionIDText == "" && len(row) >= 2 {
				questionIDText = row[0]
				correct = strings.ToUpper(row[1])
			}

			qid, err := strconv.Atoi(strings.TrimSpace(questionIDText))
			if err != nil {
				continue // Not a valid integer — skip row.
			}
			if correct != "A" && correct != "B" && correct != "C" && correct != "D" {
				continue
			}

			// Upsert so re-uploading an answer file updates existing rows rather
			// than failing with a unique-constraint error.
			_, err = config.DB.Exec(`
				INSERT INTO answers (question_id, correct_option) VALUES ($1, $2)
				ON CONFLICT (question_id) DO UPDATE SET correct_option=EXCLUDED.correct_option`,
				qid, correct,
			)
			if err == nil {
				count++
			}
		}
	}
	utils.JSON(w, http.StatusOK, map[string]interface{}{"message": "Answers uploaded", "count": count})
}
