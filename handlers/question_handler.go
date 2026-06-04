package handlers

import (
	"database/sql"
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

// GetQuestions returns exactly 15 random questions per section for the participant test.
// The three UNION ALL sub-selects each draw from a single section so the mix is
// always balanced regardless of how many questions exist per section in the database.
func GetQuestions(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		(SELECT id, section, question_text, option_a, option_b, option_c, option_d
		 FROM questions WHERE section='Analytical Ability'  ORDER BY random() LIMIT 16)
		UNION ALL
		(SELECT id, section, question_text, option_a, option_b, option_c, option_d
		 FROM questions WHERE section='Verbal Ability'      ORDER BY random() LIMIT 16)
		UNION ALL
		(SELECT id, section, question_text, option_a, option_b, option_c, option_d
		 FROM questions WHERE section='Quantitative Skills' ORDER BY random() LIMIT 16)`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load questions")
		return
	}
	defer rows.Close()
	qs, err := scanQuestions(rows)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not read questions")
		return
	}
	utils.JSON(w, http.StatusOK, qs)
}

// GetAllQuestions returns every question in insertion order for the admin panel.
// Unlike GetQuestions, this returns the full bank without randomisation or limits.
func GetAllQuestions(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(
		"SELECT id, section, question_text, option_a, option_b, option_c, option_d FROM questions ORDER BY id ASC",
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load questions")
		return
	}
	defer rows.Close()
	qs, err := scanQuestions(rows)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not read questions")
		return
	}
	utils.JSON(w, http.StatusOK, qs)
}

// scanQuestions iterates over a *sql.Rows result and converts each row into a
// Question struct. It is a shared helper used by both GetQuestions and GetAllQuestions
// to avoid duplicating the scan logic.
func scanQuestions(rows *sql.Rows) ([]models.Question, error) {
	qs := []models.Question{}
	for rows.Next() {
		var q models.Question
		if err := rows.Scan(&q.ID, &q.Section, &q.QuestionText, &q.OptionA, &q.OptionB, &q.OptionC, &q.OptionD); err != nil {
			return nil, err
		}
		qs = append(qs, q)
	}
	return qs, nil
}

// AddQuestion inserts a new question after normalising its section name to one of
// the three canonical values ("Analytical Ability", "Verbal Ability", "Quantitative Skills").
func AddQuestion(w http.ResponseWriter, r *http.Request) {
	var q models.Question
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	normalizeSection(&q.Section)
	err := config.DB.QueryRow(`
		INSERT INTO questions (section, question_text, option_a, option_b, option_c, option_d)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		q.Section, q.QuestionText, q.OptionA, q.OptionB, q.OptionC, q.OptionD,
	).Scan(&q.ID)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not add question")
		return
	}
	utils.JSON(w, http.StatusCreated, q)
}

// UpdateQuestion replaces all fields of an existing question.
// Returns 404 if no row with the given ID exists.
func UpdateQuestion(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	var q models.Question
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	normalizeSection(&q.Section)
	res, err := config.DB.Exec(`
		UPDATE questions
		SET section=$1, question_text=$2, option_a=$3, option_b=$4, option_c=$5, option_d=$6
		WHERE id=$7`,
		q.Section, q.QuestionText, q.OptionA, q.OptionB, q.OptionC, q.OptionD, id,
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not update question")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Question not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Question updated"})
}

// DeleteQuestion removes a question by ID. Its linked answer row is deleted
// automatically by the ON DELETE CASCADE on answers.question_id.
// After deletion, if the questions table is now empty the sequence is reset to 1
// so the next inserted question gets ID 1 rather than continuing from wherever
// the old sequence left off.
func DeleteQuestion(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	res, err := config.DB.Exec("DELETE FROM questions WHERE id=$1", id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete question")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Question not found")
		return
	}
	// setval(..., 1, false) sets the sequence so nextval() will return 1 next time.
	// The WHERE NOT EXISTS guard makes the entire expression a no-op when the table
	// still has rows, so it is safe to run after every delete.
	config.DB.Exec("SELECT setval('questions_id_seq', 1, false) WHERE NOT EXISTS (SELECT 1 FROM questions)")
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Question deleted"})
}

// UploadQuestions bulk-imports questions (and optionally their correct answers)
// from an Excel file. Each sheet is processed independently and the sheet name
// is used as a fallback section when no "section" column is present.
//
// Backward compatibility: old templates that have columns in positional order
// rather than named headers are detected and parsed correctly. A row whose first
// cell looks like a section label (e.g. "Section A") is treated as having the
// section in column 0 and the question in column 1; otherwise column 0 is the
// question text. If a correct_option is present in the row it is also inserted
// into the answers table.
func UploadQuestions(w http.ResponseWriter, r *http.Request) {
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

	questionCount := 0
	answerCount := 0
	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil || len(rows) < 2 {
			continue
		}
		// Use the sheet name as the default section when the row has no section column.
		sheetSection := sectionFromSheet(sheet)
		headerMap := excelHeaderMap(rows[0])

		for i, row := range rows {
			if i == 0 || isEmptyExcelRow(row) {
				continue
			}

			// Named section column overrides the sheet-name default.
			section := valueByHeader(row, headerMap, "section")
			if section == "" {
				section = sheetSection
			}
			normalizeSection(&section)

			questionText := firstNonEmpty(
				valueByHeader(row, headerMap, "question_text"),
				valueByHeader(row, headerMap, "question"),
				valueByHeader(row, headerMap, "question text"),
			)
			optionA := firstNonEmpty(valueByHeader(row, headerMap, "option_a"), valueByHeader(row, headerMap, "option a"), valueByHeader(row, headerMap, "a"))
			optionB := firstNonEmpty(valueByHeader(row, headerMap, "option_b"), valueByHeader(row, headerMap, "option b"), valueByHeader(row, headerMap, "b"))
			optionC := firstNonEmpty(valueByHeader(row, headerMap, "option_c"), valueByHeader(row, headerMap, "option c"), valueByHeader(row, headerMap, "c"))
			optionD := firstNonEmpty(valueByHeader(row, headerMap, "option_d"), valueByHeader(row, headerMap, "option d"), valueByHeader(row, headerMap, "d"))
			correctOption := strings.ToUpper(firstNonEmpty(
				valueByHeader(row, headerMap, "correct_option"),
				valueByHeader(row, headerMap, "correct option"),
				valueByHeader(row, headerMap, "correct_answer"),
				valueByHeader(row, headerMap, "correct answer"),
				valueByHeader(row, headerMap, "answer"),
			))

			// Positional fallback for old templates with no header row.
			// If col 0 looks like a section label, treat the row as:
			//   [section, question, A, B, C, D, correct_option?]
			// Otherwise treat it as:
			//   [question, A, B, C, D, correct_option?]
			if questionText == "" && len(row) >= 5 {
				if len(row) >= 6 && looksLikeSection(row[0]) {
					section = row[0]
					normalizeSection(&section)
					questionText, optionA, optionB, optionC, optionD = row[1], row[2], row[3], row[4], row[5]
					if len(row) >= 7 {
						correctOption = strings.ToUpper(row[6])
					}
				} else {
					questionText, optionA, optionB, optionC, optionD = row[0], row[1], row[2], row[3], row[4]
					if len(row) >= 6 {
						correctOption = strings.ToUpper(row[5])
					}
				}
			}

			// Skip rows that are missing any required question field.
			if questionText == "" || optionA == "" || optionB == "" || optionC == "" || optionD == "" {
				continue
			}

			var questionID int
			err := config.DB.QueryRow(`
				INSERT INTO questions (section, question_text, option_a, option_b, option_c, option_d)
				VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
				section, questionText, optionA, optionB, optionC, optionD,
			).Scan(&questionID)
			if err != nil {
				continue
			}
			questionCount++

			// Insert the answer in the same pass if a valid correct option was found,
			// saving the admin from uploading a separate answers file.
			if correctOption == "A" || correctOption == "B" || correctOption == "C" || correctOption == "D" {
				_, err = config.DB.Exec(`
					INSERT INTO answers (question_id, correct_option) VALUES ($1, $2)
					ON CONFLICT (question_id) DO UPDATE SET correct_option=EXCLUDED.correct_option`,
					questionID, correctOption,
				)
				if err == nil {
					answerCount++
				}
			}
		}
	}
	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"message":   "Questions uploaded",
		"questions": questionCount,
		"answers":   answerCount,
	})
}
