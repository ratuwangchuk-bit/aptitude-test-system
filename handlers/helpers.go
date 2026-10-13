package handlers

import "strings"

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
// closest matching section name that exists in the database.
//
// Priority:
//  1. Exact case-insensitive match against a DB section name.
//  2. One value contains the other (case-insensitive) — handles "Verbal" matching
//     a DB section name or vice-versa.
//  3. No match — the raw trimmed value is kept so the question is still imported
//     and an admin can reassign it later.
func resolveSection(section *string, dbSections []string) {
	raw := strings.TrimSpace(*section)
	if raw == "" || len(dbSections) == 0 {
		*section = raw
		return
	}
	v := strings.ToLower(raw)
	// 1. Exact match.
	for _, s := range dbSections {
		if strings.ToLower(s) == v {
			*section = s
			return
		}
	}
	// 2. Substring match.
	for _, s := range dbSections {
		sl := strings.ToLower(s)
		if strings.Contains(v, sl) || strings.Contains(sl, v) {
			*section = s
			return
		}
	}
	// 3. Keep raw value.
	*section = raw
}

// looksLikeSection reports whether a cell value looks like a section identifier.
// Used during backward-compatible positional parsing of old Excel files where
// section was the first column rather than a named header.
func looksLikeSection(value string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	// Short single-letter codes or anything that starts with "section" are safe bets.
	return v == "a" || v == "b" || v == "c" || strings.HasPrefix(v, "section")
}

// normalizeSection is kept for the single-question add/edit flows only.
// Bulk upload uses resolveSection (DB-aware) instead.
func normalizeSection(section *string) {
	*section = strings.TrimSpace(*section)
}
