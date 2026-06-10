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

// GetAnswers returns all questions with their correct answer (if one exists).
// A LEFT JOIN from questions ensures every question appears — those without an
// answer show id=0 and correct_option="" so the admin can see what still needs
// to be configured.
func GetAnswers(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT COALESCE(a.id, 0), q.id, q.question_text, q.section,
		       COALESCE(a.correct_option, '') AS correct_option
		FROM questions q
		LEFT JOIN answers a ON a.question_id = q.id
		ORDER BY q.id ASC`)
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

// normaliseCorrectOption looks up the question type for questionID and validates/normalises
// the raw correct_option value accordingly.
// Returns (normalisedValue, errorMessage). An empty errorMessage means the value is valid.
// This is extracted as a shared helper because AddAnswer and UpdateAnswer share identical logic.
func normaliseCorrectOption(questionID int, raw string) (string, string) {
	var qType string
	// If the question doesn't exist the Scan silently leaves qType as "", which
	// falls through to the MCQ branch — the INSERT will then fail on the FK constraint
	// and return a clear "Could not save answer" error.
	config.DB.QueryRow(
		"SELECT COALESCE(question_type,'mcq') FROM questions WHERE id=$1", questionID,
	).Scan(&qType)

	if qType == "fill_blank" {
		v := strings.TrimSpace(raw)
		if v == "" {
			return "", "Correct answer text is required for fill-in-the-blank questions"
		}
		return v, ""
	}
	v := strings.ToUpper(strings.TrimSpace(raw))
	if v != "A" && v != "B" && v != "C" && v != "D" {
		return "", "Correct option must be A, B, C, or D"
	}
	return v, ""
}

// AddAnswer creates a new answer or updates an existing one for the same question.
// The ON CONFLICT upsert makes this idempotent — calling it twice updates the
// correct option rather than creating a duplicate row.
func AddAnswer(w http.ResponseWriter, r *http.Request) {
	var a models.Answer
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	normalised, errMsg := normaliseCorrectOption(a.QuestionID, a.CorrectOption)
	if errMsg != "" {
		utils.Error(w, http.StatusBadRequest, errMsg)
		return
	}
	a.CorrectOption = normalised

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

// UpdateAnswer modifies the correct_option for an existing answer row.
func UpdateAnswer(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	var a models.Answer
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	normalised, errMsg := normaliseCorrectOption(a.QuestionID, a.CorrectOption)
	if errMsg != "" {
		utils.Error(w, http.StatusBadRequest, errMsg)
		return
	}
	a.CorrectOption = normalised

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

// AnswersTemplate generates a blank Excel upload template for answers with one
// sheet per active section, so the template always matches the current DB setup.
func AnswersTemplate(w http.ResponseWriter, r *http.Request) {
	sections, err := loadActiveSections()
	if err != nil || len(sections) == 0 {
		utils.Error(w, http.StatusInternalServerError, "No active sections found. Please configure sections in Settings first.")
		return
	}

	f := excelize.NewFile()
	defer f.Close()

	first := true
	for _, sec := range sections {
		// Truncate to 31 chars — Excel sheet names must not exceed this limit.
		sheetName := excelSheetName(sec.Name)
		if first {
			f.SetSheetName("Sheet1", sheetName)
			first = false
		} else {
			f.NewSheet(sheetName)
		}
		for col, h := range []string{"question_id", "correct_option"} {
			cell, _ := excelize.CoordinatesToCellName(col+1, 1)
			f.SetCellValue(sheetName, cell, h)
		}
		// Example row.
		f.SetCellValue(sheetName, "A2", "1")
		f.SetCellValue(sheetName, "B2", "A")
	}

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="answers_template.xlsx"`)
	f.Write(w) //nolint:errcheck
}
