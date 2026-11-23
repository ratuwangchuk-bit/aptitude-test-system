package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/utils"
)

// ParticipantAuth requires a valid participant session token on the test
// endpoints, so knowing (or guessing) a sequential participant_id is no longer
// enough to start, save or submit someone else's test.
//
// The token is issued by ValidateCID and must belong to the participant_id the
// request acts on. It is read from the X-Participant-Token header, or from a
// "participant_token" field in the JSON body for navigator.sendBeacon requests,
// which cannot set headers. The participant_id is read from the query string,
// the {participantId} path variable, or the JSON body — whichever the endpoint
// uses — and the body is restored for the handler afterwards.
func ParticipantAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Participant-Token")
		participantID, _ := strconv.Atoi(r.URL.Query().Get("participant_id"))
		if participantID == 0 {
			participantID, _ = strconv.Atoi(mux.Vars(r)["participantId"])
		}

		if r.Body != nil && r.Method != http.MethodGet {
			body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			if err != nil {
				utils.Error(w, http.StatusBadRequest, "Invalid request body")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			var creds struct {
				ParticipantID int    `json:"participant_id"`
				Token         string `json:"participant_token"`
			}
			if json.Unmarshal(body, &creds) == nil {
				if participantID == 0 {
					participantID = creds.ParticipantID
				}
				if token == "" {
					token = creds.Token
				}
			}
		}

		var ok bool
		if participantID > 0 && token != "" {
			config.DB.QueryRow(
				"SELECT EXISTS(SELECT 1 FROM participants WHERE id=$1 AND session_token_hash=$2)",
				participantID, utils.HashToken(token),
			).Scan(&ok) //nolint:errcheck // a failed query leaves ok=false → 401
		}
		if !ok {
			utils.Error(w, http.StatusUnauthorized,
				"Your test session is no longer valid. Please sign in again with your passcode and CID.")
			return
		}
		next.ServeHTTP(w, r)
	}
}
