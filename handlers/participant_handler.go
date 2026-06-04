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

// passcodeRequest is the JSON body for the passcode validation endpoint.
type passcodeRequest struct {
	Code string `json:"code"`
}

// testDurationSeconds is the total allowed test time (60 minutes).
// It is defined as a constant so the same value is used by both StartTest
// (to calculate seconds_remaining) and the client-side timer.
const testDurationSeconds = 3600

// ValidatePasscode checks that the submitted passcode exists and has not expired.
// A valid passcode is the first gate in the participant flow: passcode → CID → test.
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
	err := config.DB.QueryRow(
		"SELECT id FROM passcodes WHERE code=$1 AND expires_at > NOW()",
		req.Code,
	).Scan(&id)
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

// CancelRecentSubmission deletes a submission created within the last 60 seconds
// for the given participant. This is called by the test page on a page reload to
// undo the automatic sendBeacon submission that fired on the previous pagehide event.
//
// The 60-second window is intentionally short: it only covers the race between
// pagehide (fires the beacon) and the next page load (detects the reload and
// cancels). A genuine tab close followed by a fresh login cannot trigger this
// because the participant_id is wiped from localStorage on final submission.
func CancelRecentSubmission(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ParticipantID int `json:"participant_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ParticipantID == 0 {
		utils.Error(w, http.StatusBadRequest, "Participant ID is required")
		return
	}

	result, err := config.DB.Exec(`
		DELETE FROM submissions
		WHERE participant_id = $1
		  AND submitted_at > NOW() - INTERVAL '60 seconds'`,
		req.ParticipantID,
	)
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not cancel submission")
		return
	}
	n, _ := result.RowsAffected()
	utils.JSON(w, http.StatusOK, map[string]bool{"cancelled": n > 0})
}

// StartTest records when a participant first opens the test and returns the
// authoritative number of seconds remaining.
//
// The COALESCE trick ensures started_at is only written once: the first call sets
// it to NOW(); subsequent calls (e.g. after a page reload) leave it unchanged.
// This means the clock never resets if the participant reloads, and all tabs for
// the same participant see exactly the same remaining time.
func StartTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ParticipantID int `json:"participant_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ParticipantID == 0 {
		utils.Error(w, http.StatusBadRequest, "Participant ID is required")
		return
	}

	var secondsRemaining int
	err := config.DB.QueryRow(`
		WITH upd AS (
			UPDATE participants
			SET started_at = COALESCE(started_at, NOW())
			WHERE id = $1
			RETURNING started_at
		)
		SELECT GREATEST(0, $2 - FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)))::int)
		FROM upd`,
		req.ParticipantID, testDurationSeconds,
	).Scan(&secondsRemaining)
	if err != nil {
		utils.Error(w, http.StatusNotFound, "Participant not found")
		return
	}
	utils.JSON(w, http.StatusOK, map[string]int{"seconds_remaining": secondsRemaining})
}

// ValidateCID is the second gate in the participant flow.
// It confirms the CID number was pre-registered by an admin and that this
// participant has not already submitted the test. A conflict error is returned
// instead of silently redirecting so the client can show a helpful message.
// The passcode_id from the entry gate is stored on the participant so the test
// page can poll /api/passcode-status/{id} and auto-submit if it expires mid-test.
func ValidateCID(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CIDNumber  string `json:"cid_number"`
		PasscodeID int    `json:"passcode_id"`
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
	err := config.DB.QueryRow(
		"SELECT id FROM participants WHERE cid_number=$1",
		req.CIDNumber,
	).Scan(&participantID)
	if err == sql.ErrNoRows {
		utils.Error(w, http.StatusNotFound, "CID number not found. Please contact the administrator.")
		return
	}
	if err != nil {
		utils.Error(w, http.StatusInternalServerError, "Could not verify CID")
		return
	}

	// Prevent a participant who already submitted from starting a second attempt.
	var submitted bool
	config.DB.QueryRow(
		"SELECT EXISTS(SELECT 1 FROM submissions WHERE participant_id=$1)",
		participantID,
	).Scan(&submitted)
	if submitted {
		utils.Error(w, http.StatusConflict, "This CID has already completed the test. Please contact the administrator.")
		return
	}

	// Link the passcode to the participant so the test page can watch for expiry.
	if req.PasscodeID > 0 {
		config.DB.Exec(
			"UPDATE participants SET passcode_id=$1 WHERE id=$2",
			req.PasscodeID, participantID,
		)
	}

	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"message":        "CID verified successfully",
		"participant_id": participantID,
	})
}

// ── Admin participant management ──────────────────────────────────────────────

// GetAdminParticipants returns every registered participant with a computed
// has_submitted flag so admins can see at a glance who has or hasn't taken the test.
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
		if err := rows.Scan(
			&p.ID, &p.FullName, &p.CIDNumber, &p.CompanyName, &p.ContactNumber,
			&p.CreatedAt, &p.HasSubmitted,
		); err != nil {
			utils.Error(w, http.StatusInternalServerError, "Could not read participants")
			return
		}
		participants = append(participants, p)
	}
	utils.JSON(w, http.StatusOK, participants)
}

// AddAdminParticipant registers a single participant manually.
// All four fields are required. A duplicate CID is rejected with a 409 Conflict
// so the admin knows the participant is already in the system.
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

	// Check for a duplicate CID before inserting to return a clear error message.
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
		`INSERT INTO participants (full_name, cid_number, company_name, contact_number)
		 VALUES ($1,$2,$3,$4) RETURNING id`,
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

// DeleteAdminParticipant removes a participant and all their associated data.
// Submissions and participant_answers are removed automatically by the
// ON DELETE CASCADE constraints, so no separate cleanup is needed.
func DeleteAdminParticipant(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
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

// ParticipantsTemplate generates and streams a blank Excel file with the correct
// column headers so administrators have a ready-made template to fill in.
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

// UploadParticipants bulk-imports participants from an Excel file.
// Column headers are matched case-insensitively and several aliases are accepted
// ("company", "organisation", etc.) so files from different sources work without
// reformatting. Rows with duplicate CID numbers are silently skipped using
// ON CONFLICT DO NOTHING; the skip count is returned to the caller so admins
// know how many entries were already present.
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

			// Accept multiple header aliases for each field.
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

			// Skip rows that are missing any required field.
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
				skippedCount++ // ON CONFLICT DO NOTHING — duplicate CID.
			}
		}
	}

	utils.JSON(w, http.StatusOK, map[string]interface{}{
		"message": "Participants uploaded",
		"added":   addedCount,
		"skipped": skippedCount,
	})
}
