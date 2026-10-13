package handlers

import (
	"strings"

	"digital-aptitude-evaluation-system/config"
)

// excelHeaderMap builds a case-insensitive column-index lookup from a header row.
// Both underscore and space variants are indexed so "full_name" and "full name"
// resolve to the same column index. Hyphens are also normalised to underscores.
// This makes the upload handlers tolerant of minor header formatting differences
// in spreadsheets prepared by different people.
func excelHeaderMap(row []string) map[string]int {
	m := map[string]int{}
	for i, cell := range row {
		key := strings.ToLower(strings.TrimSpace(cell))
		key = strings.ReplaceAll(key, "-", "_")
		key = strings.ReplaceAll(key, " ", "_")
		// Store both the underscored form and the space-separated form so either
		// lookup variant matches regardless of how the caller queries the map.
		m[key] = i
		m[strings.ReplaceAll(key, "_", " ")] = i
	}
	return m
}

// valueByHeader returns the trimmed cell value for a given header name, or ""
// if the header does not exist or the row is too short to contain that column.
// It tries the key as-is first, then with spaces replaced by underscores, so
// callers can use either convention when looking up a column.
func valueByHeader(row []string, headerMap map[string]int, key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	if idx, ok := headerMap[key]; ok && idx < len(row) {
		return strings.TrimSpace(row[idx])
	}
	key = strings.ReplaceAll(key, " ", "_")
	if idx, ok := headerMap[key]; ok && idx < len(row) {
		return strings.TrimSpace(row[idx])
	}
	return ""
}

// firstNonEmpty returns the first non-blank string from values.
// It is used when a field can appear under several alternative header names —
// we try each alias in preference order and take the first hit.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// isEmptyExcelRow reports whether every cell in the row is blank.
// Excel sometimes emits trailing empty rows at the end of a sheet; this helper
// lets upload handlers skip them without counting them as errors.
func isEmptyExcelRow(row []string) bool {
	for _, cell := range row {
		if strings.TrimSpace(cell) != "" {
			return false
		}
	}
	return true
}

// resolveSection maps a raw section value from an uploaded Excel file to the
// closest matching section name in the database.
//
// Priority:
//  1. Single-letter positional codes (a, b, c, …) map to the DB section at that
//     index — avoids false substring matches (e.g. "c" inside "analytical").
//  2. "Section A" / "Section B" style labels map positionally the same way.
//  3. Exact case-insensitive match against a DB section name.
//  4. Substring match (only when the raw value is ≥ 3 chars to prevent a single
//     letter matching inside an unrelated section name).
//  5. Raw trimmed value is kept so the question still imports.
func resolveSection(section *string, dbSections []string) {
	raw := strings.TrimSpace(*section)
	if raw == "" || len(dbSections) == 0 {
		*section = raw
		return
	}
	v := strings.ToLower(raw)

	// 1. Single-letter positional code: "a" → dbSections[0], "b" → [1], etc.
	if len(v) == 1 && v[0] >= 'a' && v[0] <= 'z' {
		idx := int(v[0] - 'a')
		if idx < len(dbSections) {
			*section = dbSections[idx]
			return
		}
		*section = raw
		return
	}

	// 2. "Section A" / "section b" style positional label.
	if strings.HasPrefix(v, "section ") && len(v) == 9 {
		letter := v[8]
		if letter >= 'a' && letter <= 'z' {
			idx := int(letter - 'a')
			if idx < len(dbSections) {
				*section = dbSections[idx]
				return
			}
		}
	}

	// 3. Exact case-insensitive match.
	for _, s := range dbSections {
		if strings.ToLower(s) == v {
			*section = s
			return
		}
	}

	// 4. Substring match — only for values long enough to be meaningful.
	if len(v) >= 3 {
		for _, s := range dbSections {
			sl := strings.ToLower(s)
			if strings.Contains(sl, v) || strings.Contains(v, sl) {
				*section = s
				return
			}
		}
	}

	// 5. Keep raw value.
	*section = raw
}

// looksLikeSection reports whether row[0] looks like a section marker rather than
// question text. Used for backward-compatible positional parsing of headerless
// old-format Excel files.
func looksLikeSection(value string, dbSections []string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	// Single-letter codes.
	if len(v) == 1 && v[0] >= 'a' && v[0] <= 'z' {
		return true
	}
	// "Section X" prefix.
	if strings.HasPrefix(v, "section") {
		return true
	}
	// Exact match against any known DB section name.
	for _, s := range dbSections {
		if strings.ToLower(s) == v {
			return true
		}
	}
	return false
}

// loadDBSections returns section names from the DB ordered by sort position.
// Used by the add/edit single-question API to resolve section values.
func loadDBSections() []string {
	rows, err := config.DB.Query(
		"SELECT name FROM test_sections ORDER BY sort_order ASC, id ASC",
	)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			out = append(out, n)
		}
	}
	return out
}

// normalizeSection resolves a section value in the single-question add/edit flows
// by matching against the live DB section list.
func normalizeSection(section *string) {
	resolveSection(section, loadDBSections())
}
