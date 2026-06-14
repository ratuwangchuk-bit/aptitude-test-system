package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

// GetAnswers returns questions with their correct answer for active sections only.
// Questions in inactive sections are excluded system-wide until re-activated.
func GetAnswers(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT COALESCE(a.id, 0), q.id, q.question_text, q.section,
		       COALESCE(a.correct_option, '') AS correct_option
		FROM questions q
		JOIN test_sections ts ON ts.name = q.section AND ts.is_active = TRUE
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
	if v != "A" && v != "B" && v != "C" && v != "D" && v != "E" {
		return "", "Correct option must be A, B, C, D, or E"
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

