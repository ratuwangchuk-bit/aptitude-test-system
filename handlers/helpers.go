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

// sectionFromSheet derives a normalised section name from an Excel sheet name.
// It lets users name their sheets "Section A", "Analytical", "A", etc. and have
// the system map them to the canonical section name automatically.
func sectionFromSheet(sheetName string) string {
	section := sheetName
	normalizeSection(&section)
	return section
}

// looksLikeSection reports whether a cell value looks like a section identifier.
// This is used during backward-compatible parsing of old Excel templates where
// the section was inlined as the first column rather than given its own header.
func looksLikeSection(value string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	return strings.Contains(v, "analytical") ||
		strings.Contains(v, "verbal") ||
		strings.Contains(v, "quantitative") ||
		v == "a" || v == "b" || v == "c" ||
		strings.Contains(v, "section")
}

// normalizeSection maps common aliases to the three canonical section names used
// throughout the system. The pointer receiver allows callers to modify the string
// in-place. Any unrecognised value falls back to "Analytical Ability" so data is
// never silently dropped when a template uses an unexpected section label.
func normalizeSection(section *string) {
	v := strings.ToLower(strings.TrimSpace(*section))
	switch {
	case v == "a" || strings.Contains(v, "section a") || strings.Contains(v, "analytical"):
		*section = "Analytical Ability"
	case v == "b" || strings.Contains(v, "section b") || strings.Contains(v, "verbal"):
		*section = "Verbal Ability"
	case v == "c" || strings.Contains(v, "section c") || strings.Contains(v, "quantitative"):
		*section = "Quantitative Skills"
	default:
		// Unknown sections default to Analytical Ability to avoid silently losing rows.
		*section = "Analytical Ability"
	}
}
