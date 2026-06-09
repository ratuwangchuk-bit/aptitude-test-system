package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

// loadTestConfig reads the singleton test_config row from the database.
// Falls back to safe defaults if the row is missing so the app never crashes
// on a fresh database before migrations run.
func loadTestConfig() models.TestConfig {
	cfg := models.TestConfig{TestDurationMinutes: 60, PasscodeValidityMinutes: 90}
	config.DB.QueryRow(
		"SELECT test_duration_minutes, passcode_validity_minutes FROM test_config WHERE id=1",
	).Scan(&cfg.TestDurationMinutes, &cfg.PasscodeValidityMinutes)
	return cfg
}

// loadActiveSections returns all active test sections ordered by sort_order.
func loadActiveSections() ([]models.TestSection, error) {
	rows, err := config.DB.Query(
		"SELECT id, name, label, questions_per_test, sort_order, is_active FROM test_sections WHERE is_active=TRUE ORDER BY sort_order ASC, id ASC",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sections := []models.TestSection{}
	for rows.Next() {
		var s models.TestSection
		if err := rows.Scan(&s.ID, &s.Name, &s.Label, &s.QuestionsPerTest, &s.SortOrder, &s.IsActive); err != nil {
			return nil, err
		}
		sections = append(sections, s)
	}
	return sections, nil
}

// GetPublicTestInfo is a no-auth endpoint used by the participant pages to get the
// current test duration, section list, and total question count for display.
func GetPublicTestInfo(w http.ResponseWriter, r *http.Request) {
	cfg := loadTestConfig()
	sections, err := loadActiveSections()
	if err != nil {
		sections = []models.TestSection{}
	}
	totalQ := 0
	for _, s := range sections {
		totalQ += s.QuestionsPerTest
	}
	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"duration_minutes": cfg.TestDurationMinutes,
		"sections":         sections,
		"total_questions":  totalQ,
	})
}

// GetTestConfig returns the current test configuration (super admin and general admin).
func GetTestConfig(w http.ResponseWriter, r *http.Request) {
	utils.JSON(w, http.StatusOK, loadTestConfig())
}

// UpdateTestConfig replaces the singleton test_config row (super admin only).
func UpdateTestConfig(w http.ResponseWriter, r *http.Request) {
	var cfg models.TestConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if cfg.TestDurationMinutes < 1 || cfg.TestDurationMinutes > 480 {
		utils.Error(w, http.StatusBadRequest, "Test duration must be between 1 and 480 minutes")
		return
	}
	if cfg.PasscodeValidityMinutes < 10 || cfg.PasscodeValidityMinutes > 1440 {
		utils.Error(w, http.StatusBadRequest, "Passcode validity must be between 10 and 1440 minutes")
		return
	}
	_, err := config.DB.Exec(`
		INSERT INTO test_config (id, test_duration_minutes, passcode_validity_minutes, updated_at)
		VALUES (1, $1, $2, $3)
		ON CONFLICT (id) DO UPDATE
		  SET test_duration_minutes=$1, passcode_validity_minutes=$2, updated_at=$3`,
		cfg.TestDurationMinutes, cfg.PasscodeValidityMinutes, time.Now(),
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not save configuration")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Configuration saved"})
}

// GetSections returns all test sections with their question bank counts.
func GetSections(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT ts.id, ts.name, ts.label, ts.questions_per_test, ts.sort_order, ts.is_active,
		       COUNT(q.id) AS bank_count
		FROM test_sections ts
		LEFT JOIN questions q ON q.section = ts.name
		GROUP BY ts.id
		ORDER BY ts.sort_order ASC, ts.id ASC`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load sections")
		return
	}
	defer rows.Close()
	sections := []models.TestSection{}
	for rows.Next() {
		var s models.TestSection
		if err := rows.Scan(&s.ID, &s.Name, &s.Label, &s.QuestionsPerTest, &s.SortOrder, &s.IsActive, &s.BankCount); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read sections")
			return
		}
		sections = append(sections, s)
	}
	utils.JSON(w, http.StatusOK, sections)
}

// AddSection creates a new test section (super admin only).
func AddSection(w http.ResponseWriter, r *http.Request) {
	var s models.TestSection
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if s.Name == "" {
		utils.Error(w, http.StatusBadRequest, "Section name is required")
		return
	}
	if s.QuestionsPerTest < 1 {
		s.QuestionsPerTest = 1
	}
	err := config.DB.QueryRow(`
		INSERT INTO test_sections (name, label, questions_per_test, sort_order, is_active)
		VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
		s.Name, s.Label, s.QuestionsPerTest, s.SortOrder,
	).Scan(&s.ID)
	if err != nil {
		utils.Error(w, http.StatusConflict, "Section name already exists or could not be created")
		return
	}
	s.IsActive = true
	utils.JSON(w, http.StatusCreated, s)
}

// UpdateSection updates an existing section's configuration (super admin only).
// If the section name changes, all questions referencing the old name are updated atomically.
func UpdateSection(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	var s models.TestSection
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if s.Name == "" {
		utils.Error(w, http.StatusBadRequest, "Section name is required")
		return
	}
	if s.QuestionsPerTest < 1 {
		s.QuestionsPerTest = 1
	}

	// Read the current name so we can cascade any rename to questions.
	var oldName string
	if err := config.DB.QueryRow("SELECT name FROM test_sections WHERE id=$1", id).Scan(&oldName); err != nil {
		utils.Error(w, http.StatusNotFound, "Section not found")
		return
	}

	tx, err := config.DB.Begin()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not start transaction")
		return
	}
	defer tx.Rollback()

	res, err := tx.Exec(`
		UPDATE test_sections
		SET name=$1, label=$2, questions_per_test=$3, sort_order=$4, is_active=$5
		WHERE id=$6`,
		s.Name, s.Label, s.QuestionsPerTest, s.SortOrder, s.IsActive, id,
	)
	if err != nil {
		utils.Error(w, http.StatusConflict, "Could not update section (name may already exist)")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Section not found")
		return
	}

	// Cascade the rename to all questions in this section.
	if s.Name != oldName {
		if _, err = tx.Exec("UPDATE questions SET section=$1 WHERE section=$2", s.Name, oldName); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not update question sections")
			return
		}
	}

	if err = tx.Commit(); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not commit update")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Section updated"})
}

// DeleteSection removes a test section and all questions belonging to it (super admin only).
// Answers and participant_answers cascade-delete automatically via FK constraints.
func DeleteSection(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])

	// Resolve the section name first so we can delete matching questions.
	var sectionName string
	if err := config.DB.QueryRow("SELECT name FROM test_sections WHERE id=$1", id).Scan(&sectionName); err != nil {
		utils.Error(w, http.StatusNotFound, "Section not found")
		return
	}

	tx, err := config.DB.Begin()
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not start transaction")
		return
	}
	defer tx.Rollback()

	// Delete all questions in this section (answers cascade automatically).
	if _, err = tx.Exec("DELETE FROM questions WHERE section=$1", sectionName); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete section questions")
		return
	}

	// Delete the section row itself.
	if _, err = tx.Exec("DELETE FROM test_sections WHERE id=$1", id); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete section")
		return
	}

	if err = tx.Commit(); err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not commit deletion")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Section and its questions deleted"})
}
