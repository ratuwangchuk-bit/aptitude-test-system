package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/routes"
)

func main() {
	r := mux.NewRouter()
	routes.RegisterRoutes(r)

	// Health check route for Render
	r.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}).Methods("GET")

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Connect database with clear logs
	log.Println("Connecting to database...")
	config.ConnectDB()
	log.Println("Database connected successfully")

	srv := &http.Server{
		Addr:         "0.0.0.0:" + port,
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	log.Println("Digital Aptitude Evaluation System running on port", port)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("Server failed to start:", err)
	}
}