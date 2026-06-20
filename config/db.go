package config

import (
	"bufio"
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // PostgreSQL driver — imported for its side-effect of registering itself.
)

// DB is the shared database connection pool used by all handlers.
// It is set once during startup and safe for concurrent use.
var DB *sql.DB

// loadEnvFile reads key=value pairs from a ".env" file in the working directory
// and populates missing environment variables. Already-set variables (e.g. from
// the OS or a container runtime) are never overwritten, so the .env file serves
// only as a development convenience.
func loadEnvFile() {
	file, err := os.Open(".env")
	if err != nil {
		return // No .env file is fine in production where env vars are injected directly.
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Skip blank lines and comments.
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		key := strings.TrimSpace(parts[0])
		value := strings.Trim(strings.TrimSpace(parts[1]), "\"'")
		// Only set if not already present so the OS environment wins.
		if key != "" && os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
}

// getenv returns the value of the named environment variable, or fallback if
// the variable is unset or blank.
func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

// buildDSN constructs a PostgreSQL connection string (DSN).
// If DATABASE_URL is set (standard on Render, Railway, etc.) it is used as-is.
// Otherwise individual DB_* variables are assembled into a libpq-style string.
func buildDSN() string {
	if databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL")); databaseURL != "" {
		return databaseURL
	}

	host := getenv("DB_HOST", "localhost")
	port := getenv("DB_PORT", "5432")
	user := getenv("DB_USER", "postgres")
	password := getenv("DB_PASSWORD", "postgres")
	dbname := getenv("DB_NAME", "aptitude_db")
	sslmode := getenv("DB_SSLMODE", "disable")

	return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		host, port, user, password, dbname, sslmode)
}

// ConnectDB initialises the global DB connection pool.
// It loads the .env file, opens a connection, verifies reachability with Ping,
// and applies connection pool limits. The process is terminated on any failure
// so the server never starts in a broken state.
func ConnectDB() {
	loadEnvFile()

	db, err := sql.Open("pgx", buildDSN())
	if err != nil {
		log.Fatal("Database configuration error: ", err)
	}

	if err := db.Ping(); err != nil {
		log.Println("Database connection failed.")
		log.Println("Check these points:")
		log.Println("1. PostgreSQL server must be running.")
		log.Println("2. DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, and DB_SSLMODE must be correct in .env.")
		log.Println("3. If using Neon/Supabase/Render, set DATABASE_URL in .env and use sslmode=require.")
		log.Fatal("Database ping error: ", err)
	}

	// 40 open connections balances throughput with database resource limits.
	// 10 idle connections are kept alive to avoid reconnection overhead on bursts.
	// Connections are recycled every 5 minutes to avoid stale state from network
	// interruptions or PostgreSQL idle-timeout settings.
	db.SetMaxOpenConns(40)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)

	DB = db
	log.Println("Database connected successfully")
}

// MigrateDB applies idempotent ALTER TABLE statements for schema changes added
// after the initial deployment. Safe to run on every startup.
func MigrateDB() {
	migrations := []string{
		`ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_e TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE test_config ADD COLUMN IF NOT EXISTS test_title TEXT NOT NULL DEFAULT 'Online Aptitude Test'`,
		`ALTER TABLE participants ADD COLUMN IF NOT EXISTS assigned_question_ids INT[]`,
		`ALTER TABLE test_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
	}
	for _, m := range migrations {
		if _, err := DB.Exec(m); err != nil {
			log.Printf("Migration warning: %v", err)
		}
	}
}
