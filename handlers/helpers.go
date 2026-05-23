package handlers

import "strings"

// excelHeaderMap builds a case-insensitive column-index lookup from a header row.
// Both underscore and space variants are indexed ("full_name" and "full name").
func excelHeaderMap(row []string) map[string]int {
	m := map[string]int{}
	for i, cell := range row {
		key := strings.ToLower(strings.TrimSpace(cell))
		key = strings.ReplaceAll(key, "-", "_")
		key = strings.ReplaceAll(key, " ", "_")
		m[key] = i
		m[strings.ReplaceAll(key, "_", " ")] = i
	}
	return m
}

// valueByHeader returns the trimmed cell value for a given header name, or "" if not found.
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

// firstNonEmpty returns the first non-blank string from the given values.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// isEmptyExcelRow reports whether every cell in the row is blank.
func isEmptyExcelRow(row []string) bool {
	for _, cell := range row {
		if strings.TrimSpace(cell) != "" {
			return false
		}
	}
	return true
}

// sectionFromSheet derives a normalised section name from an Excel sheet name.
func sectionFromSheet(sheetName string) string {
	section := sheetName
	normalizeSection(&section)
	return section
}

// looksLikeSection reports whether a cell value looks like a section identifier.
func looksLikeSection(value string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	return strings.Contains(v, "analytical") ||
		strings.Contains(v, "verbal") ||
		strings.Contains(v, "quantitative") ||
		v == "a" || v == "b" || v == "c" ||
		strings.Contains(v, "section")
}

// normalizeSection maps common aliases to the canonical three section names.
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
		*section = "Analytical Ability"
	}
}
