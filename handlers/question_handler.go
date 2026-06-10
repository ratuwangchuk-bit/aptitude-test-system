package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gorilla/mux"
	"github.com/xuri/excelize/v2"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

// GetQuestions returns random questions for the participant test, drawing the
// configured number of questions per active section. Section configuration is
// read from test_sections at request time so admins can change it without restart.
func GetQuestions(w http.ResponseWriter, r *http.Request) {
	sections, err := loadActiveSections()
	if err != nil || len(sections) == 0 {
		utils.Error(w, http.StatusServiceUnavailable, "The question bank is not ready. Please contact the administrator.")
		return
	}

	// Verify each active section has enough questions.
	for _, sec := range sections {
		var cnt int
		config.DB.QueryRow("SELECT COUNT(*) FROM questions WHERE section=$1", sec.Name).Scan(&cnt)
		if cnt < sec.QuestionsPerTest {
			utils.Error(w, http.StatusServiceUnavailable,
				fmt.Sprintf("Not enough questions in '%s' (need %d, have %d). Please contact the administrator.",
					sec.Name, sec.QuestionsPerTest, cnt))
			return
		}
	}

	// Build a dynamic UNION ALL query — one sub-select per active section.
	parts := make([]string, len(sections))
	args := make([]interface{}, len(sections)*2)
	for i, sec := range sections {
		// $1,$2 for section 0; $3,$4 for section 1; etc.
		parts[i] = fmt.Sprintf(
			"(SELECT id, section, question_text, COALESCE(question_type,'mcq'), option_a, option_b, option_c, option_d, COALESCE(image_url,'') FROM questions WHERE section=$%d ORDER BY random() LIMIT $%d)",
			i*2+1, i*2+2,
		)
		args[i*2] = sec.Name
		args[i*2+1] = sec.QuestionsPerTest
	}
	query := strings.Join(parts, " UNION ALL ")

	rows, err := config.DB.Query(query, args...)
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
func GetAllQuestions(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(
		"SELECT id, section, question_text, COALESCE(question_type,'mcq'), option_a, option_b, option_c, option_d, COALESCE(image_url,'') FROM questions ORDER BY id ASC",
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

func scanQuestions(rows *sql.Rows) ([]models.Question, error) {
	qs := []models.Question{}
	for rows.Next() {
		var q models.Question
		if err := rows.Scan(&q.ID, &q.Section, &q.QuestionText, &q.QuestionType, &q.OptionA, &q.OptionB, &q.OptionC, &q.OptionD, &q.ImageURL); err != nil {
			return nil, err
		}
		if q.QuestionType == "" {
			q.QuestionType = "mcq"
		}
		qs = append(qs, q)
	}
	return qs, nil
}

// AddQuestion inserts a new question after normalising its section name.
func AddQuestion(w http.ResponseWriter, r *http.Request) {
	var q models.Question
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	normalizeSection(&q.Section)
	if q.QuestionType == "" {
		q.QuestionType = "mcq"
	}
	err := config.DB.QueryRow(`
		INSERT INTO questions (section, question_text, question_type, option_a, option_b, option_c, option_d, image_url)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8,'')) RETURNING id`,
		q.Section, q.QuestionText, q.QuestionType, q.OptionA, q.OptionB, q.OptionC, q.OptionD, q.ImageURL,
	).Scan(&q.ID)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not add question")
		return
	}
	utils.JSON(w, http.StatusCreated, q)
}

// UpdateQuestion replaces all fields of an existing question including optional image.
func UpdateQuestion(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	var q models.Question
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	normalizeSection(&q.Section)
	if q.QuestionType == "" {
		q.QuestionType = "mcq"
	}
	res, err := config.DB.Exec(`
		UPDATE questions
		SET section=$1, question_text=$2, question_type=$3, option_a=$4, option_b=$5, option_c=$6, option_d=$7, image_url=NULLIF($8,'')
		WHERE id=$9`,
		q.Section, q.QuestionText, q.QuestionType, q.OptionA, q.OptionB, q.OptionC, q.OptionD, q.ImageURL, id,
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

// DeleteQuestion removes a question by ID and its associated image file.
func DeleteQuestion(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])

	// Grab image_url before deleting so we can remove the file.
	var imageURL sql.NullString
	config.DB.QueryRow("SELECT image_url FROM questions WHERE id=$1", id).Scan(&imageURL)

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

	// Clean up the image file if one existed.
	if imageURL.Valid && imageURL.String != "" {
		os.Remove(filepath.Join("frontend", imageURL.String))
	}

	config.DB.Exec("SELECT setval('questions_id_seq', 1, false) WHERE NOT EXISTS (SELECT 1 FROM questions)")
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Question deleted"})
}

// UploadQuestionImage accepts a multipart image file, saves it under
// frontend/uploads/questions/, updates questions.image_url, and returns the URL.
func UploadQuestionImage(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	if id == 0 {
		utils.Error(w, http.StatusBadRequest, "Question ID is required")
		return
	}

	// Ensure the upload directory exists.
	uploadDir := filepath.Join("frontend", "uploads", "questions")
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not create upload directory")
		return
	}

	// 10 MB limit for question images.
	r.ParseMultipartForm(10 << 20)
	file, header, err := r.FormFile("image")
	if err != nil {
		utils.Error(w, http.StatusBadRequest, "Image file is required")
		return
	}
	defer file.Close()

	// Only allow common image types.
	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowed := map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true}
	if !allowed[ext] {
		utils.Error(w, http.StatusBadRequest, "Only JPG, PNG, GIF and WEBP images are allowed")
		return
	}

	// Remove old image file if present.
	var oldURL sql.NullString
	config.DB.QueryRow("SELECT image_url FROM questions WHERE id=$1", id).Scan(&oldURL)
	if oldURL.Valid && oldURL.String != "" {
		os.Remove(filepath.Join("frontend", oldURL.String))
	}

	// Save new file with a name derived from question ID for easy lookup.
	filename := fmt.Sprintf("q%d%s", id, ext)
	destPath := filepath.Join(uploadDir, filename)
	dest, err := os.Create(destPath)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save image")
		return
	}
	defer dest.Close()
	if _, err := io.Copy(dest, file); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not write image")
		return
	}

	// Store relative URL (served by the static file server under /uploads/questions/).
	relURL := "/uploads/questions/" + filename
	_, err = config.DB.Exec("UPDATE questions SET image_url=$1 WHERE id=$2", relURL, id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not update question image")
		return
	}

	utils.JSON(w, http.StatusOK, map[string]string{"image_url": relURL})
}

// RemoveQuestionImage clears the image from a question and deletes the file.
func RemoveQuestionImage(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])

	var imageURL sql.NullString
	config.DB.QueryRow("SELECT image_url FROM questions WHERE id=$1", id).Scan(&imageURL)

	if imageURL.Valid && imageURL.String != "" {
		os.Remove(filepath.Join("frontend", imageURL.String))
	}
	config.DB.Exec("UPDATE questions SET image_url=NULL WHERE id=$1", id)
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Image removed"})
}

// UploadQuestions bulk-imports questions (and optionally answers) from Excel.
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
		sheetSection := sectionFromSheet(sheet)
		headerMap := excelHeaderMap(rows[0])

		for i, row := range rows {
			if i == 0 || isEmptyExcelRow(row) {
				continue
			}

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

// excelSheetName truncates a section name to the 31-character limit imposed by
// the Excel spec. Names beyond this limit cause excelize to silently produce
// invalid files that Excel refuses to open.
func excelSheetName(name string) string {
	runes := []rune(name)
	if len(runes) > 31 {
		return string(runes[:31])
	}
	return name
}

// QuestionsTemplate generates a blank Excel upload template with one sheet per
// active section so admins always get a template that matches the current DB setup.
func QuestionsTemplate(w http.ResponseWriter, r *http.Request) {
	sections, err := loadActiveSections()
	if err != nil || len(sections) == 0 {
		utils.Error(w, http.StatusInternalServerError, "No active sections found. Please configure sections in Settings first.")
		return
	}

	f := excelize.NewFile()
	defer f.Close()

	headers := []string{
		"section", "question_text", "question_type",
		"option_a", "option_b", "option_c", "option_d",
		"correct_option",
	}

	first := true
	for _, sec := range sections {
		sheetName := excelSheetName(sec.Name)
		if first {
			f.SetSheetName("Sheet1", sheetName)
			first = false
		} else {
			f.NewSheet(sheetName)
		}
		for col, h := range headers {
			cell, _ := excelize.CoordinatesToCellName(col+1, 1)
			f.SetCellValue(sheetName, cell, h)
		}
		// Example row so admins know the expected format.
		example := []string{sec.Name, "Enter question text here", "mcq", "Option A text", "Option B text", "Option C text", "Option D text", "A"}
		for col, v := range example {
			cell, _ := excelize.CoordinatesToCellName(col+1, 2)
			f.SetCellValue(sheetName, cell, v)
		}
	}

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="questions_template.xlsx"`)
	f.Write(w) //nolint:errcheck
}
