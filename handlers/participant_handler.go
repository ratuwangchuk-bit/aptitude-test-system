package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gorilla/mux"
	"github.com/xuri/excelize/v2"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/models"
	"digital-aptitude-evaluation-system/utils"
)

type passcodeRequest struct {
	Code string `json:"code"`
}

func ValidatePasscode(w http.ResponseWriter, r *http.Request) {
	var req passcodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.Code = strings.ToUpper(strings.TrimSpace(req.Code))
	if req.Code == "" {
		utils.Error(w, http.StatusBadRequest, "Passcode is required")
		return
	}

	var id int
	err := config.DB.QueryRow("SELECT id FROM passcodes WHERE code=$1 AND expires_at > NOW()", req.Code).Scan(&id)
	if err == sql.ErrNoRows {
		utils.Error(w, http.StatusBadRequest, "Invalid or expired passcode")
		return
	}
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not validate passcode")
		return
	}

	utils.JSON(w, http.StatusOK, map[string]interface{}{"message": "Passcode valid", "passcode_id": id})
}

// ValidateCID is called on the participant-facing CID validation step.
// It confirms the CID was pre-registered by an admin and has not yet submitted.
func ValidateCID(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CIDNumber string `json:"cid_number"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.CIDNumber = strings.TrimSpace(req.CIDNumber)
	if req.CIDNumber == "" {
		utils.Error(w, http.StatusBadRequest, "CID number is required")
		return
	}

	var participantID int
	err := config.DB.QueryRow("SELECT id FROM participants WHERE cid_number=$1", req.CIDNumber).Scan(&participantID)
	if err == sql.ErrNoRows {
		utils.Error(w, http.StatusNotFound, "CID number not found. Please contact the administrator.")
		return
	}
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not verify CID")
		return
	}

	var submitted bool
	config.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM submissions WHERE participant_id=$1)", participantID).Scan(&submitted)
	if submitted {
		utils.Error(w, http.StatusConflict, "This CID has already completed the test. Please contact the administrator.")
		return
	}

	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"message":        "CID verified successfully",
		"participant_id": participantID,
	})
}

// ── Admin participant management ──────────────────────────────

func GetAdminParticipants(w http.ResponseWriter, r *http.Request) {
	rows, err := config.DB.Query(`
		SELECT p.id, p.full_name, p.cid_number, p.company_name, p.contact_number,
		       to_char(p.created_at, 'YYYY-MM-DD HH24:MI'),
		       EXISTS(SELECT 1 FROM submissions s WHERE s.participant_id = p.id) AS has_submitted
		FROM participants p
		ORDER BY p.created_at DESC`)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not load participants")
		return
	}
	defer rows.Close()

	participants := []models.Participant{}
	for rows.Next() {
		var p models.Participant
		if err := rows.Scan(&p.ID, &p.FullName, &p.CIDNumber, &p.CompanyName, &p.ContactNumber, &p.CreatedAt, &p.HasSubmitted); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read participants")
			return
		}
		participants = append(participants, p)
	}
	utils.JSON(w, http.StatusOK, participants)
}

func AddAdminParticipant(w http.ResponseWriter, r *http.Request) {
	var p models.Participant
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		utils.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	p.FullName = strings.TrimSpace(p.FullName)
	p.CIDNumber = strings.TrimSpace(p.CIDNumber)
	p.CompanyName = strings.TrimSpace(p.CompanyName)
	p.ContactNumber = strings.TrimSpace(p.ContactNumber)

	if p.FullName == "" || p.CIDNumber == "" || p.CompanyName == "" || p.ContactNumber == "" {
		utils.Error(w, http.StatusBadRequest, "All fields are required")
		return
	}

	var existingID int
	err := config.DB.QueryRow("SELECT id FROM participants WHERE cid_number=$1", p.CIDNumber).Scan(&existingID)
	if err == nil {
		utils.Error(w, http.StatusConflict, "A participant with this CID number is already registered")
		return
	}
	if err != sql.ErrNoRows {
		utils.Error(w, http.StatusInternalServerError, "Could not check CID number")
		return
	}

	err = config.DB.QueryRow(
		`INSERT INTO participants (full_name, cid_number, company_name, contact_number) VALUES ($1,$2,$3,$4) RETURNING id`,
		p.FullName, p.CIDNumber, p.CompanyName, p.ContactNumber,
	).Scan(&p.ID)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not add participant")
		return
	}

	utils.JSON(w, http.StatusCreated, map[string]interface{}{
		"message":        "Participant added successfully",
		"participant_id": p.ID,
	})
}

func DeleteAdminParticipant(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]

	// Submissions and participant_answers are removed automatically via ON DELETE CASCADE.
	res, err := config.DB.Exec("DELETE FROM participants WHERE id=$1", id)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not delete participant")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		utils.Error(w, http.StatusNotFound, "Participant not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]string{"message": "Participant deleted successfully"})
}

func ParticipantsTemplate(w http.ResponseWriter, r *http.Request) {
	f := excelize.NewFile()
	defer f.Close()
	sheet := "Participants"
	f.SetSheetName("Sheet1", sheet)
	headers := []string{"Full Name", "CID Number", "Company Name", "Contact Number"}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(sheet, cell, h)
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="participants_template.xlsx"`)
	f.Write(w) //nolint:errcheck
}

func UploadParticipants(w http.ResponseWriter, r *http.Request) {
	file, _, err := r.FormFile("file")
	if err != nil {
		utils.Error(w, http.StatusBadRequest, "Excel file is required")
		return
	}
	defer file.Close()

	f, err := excelize.OpenReader(file)
	if err != nil {
		utils.Error(w, http.StatusBadRequest, "Could not open Excel file")
		return
	}
	defer f.Close()

	addedCount := 0
	skippedCount := 0
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
			fullName := strings.TrimSpace(firstNonEmpty(
				valueByHeader(row, headerMap, "full_name"),
				valueByHeader(row, headerMap, "full name"),
				valueByHeader(row, headerMap, "name"),
			))
			cidNumber := strings.TrimSpace(firstNonEmpty(
				valueByHeader(row, headerMap, "cid_number"),
				valueByHeader(row, headerMap, "cid number"),
				valueByHeader(row, headerMap, "cid"),
			))
			companyName := strings.TrimSpace(firstNonEmpty(
				valueByHeader(row, headerMap, "company_name"),
				valueByHeader(row, headerMap, "company name"),
				valueByHeader(row, headerMap, "company"),
				valueByHeader(row, headerMap, "organisation"),
				valueByHeader(row, headerMap, "organization"),
			))
			contactNumber := strings.TrimSpace(firstNonEmpty(
				valueByHeader(row, headerMap, "contact_number"),
				valueByHeader(row, headerMap, "contact number"),
				valueByHeader(row, headerMap, "contact"),
			))

			if fullName == "" || cidNumber == "" || companyName == "" || contactNumber == "" {
				continue
			}

			res, err := config.DB.Exec(
				`INSERT INTO participants (full_name, cid_number, company_name, contact_number)
				 VALUES ($1,$2,$3,$4) ON CONFLICT (cid_number) DO NOTHING`,
				fullName, cidNumber, companyName, contactNumber,
			)
			if err != nil {
				skippedCount++
				continue
			}
			n, _ := res.RowsAffected()
			if n > 0 {
				addedCount++
			} else {
				skippedCount++
			}
		}
	}

	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"message": "Participants uploaded",
		"added":   addedCount,
		"skipped": skippedCount,
	})
}
