package utils

import (
	"database/sql"

	"github.com/jackc/pgx/v5/pgtype"
)

// pgTypeMap is process-wide and safe for concurrent use; pgx recommends reusing
// a single Map rather than allocating one per query.
var pgTypeMap = pgtype.NewMap()

// IntArrayScanner wraps dest so database/sql's Scan can populate it from a
// PostgreSQL integer array column (e.g. INT[]). The pgx driver requires this
// adapter for scanning array columns — unlike binding a []int64 as a query
// *argument*, which pgx accepts natively with no wrapper at all.
func IntArrayScanner(dest *[]int64) sql.Scanner {
	return pgTypeMap.SQLScanner(dest)
}
