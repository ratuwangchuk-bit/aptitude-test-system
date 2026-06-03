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
	// Connect to PostgreSQL before binding the port so we fail fast
	// if the database is unavailable rather than serving broken requests.
	config.ConnectDB()

	r := mux.NewRouter()
	routes.RegisterRoutes(r)

	// Allow the listening port to be overridden via an environment variable
	// so the same binary works locally (8080) and on cloud platforms (dynamic port).
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:    "0.0.0.0:" + port,
		Handler: r,

		// ReadTimeout covers the time from accepting the connection to finishing
		// reading the full request body. 30 s is generous for file uploads.
		ReadTimeout: 30 * time.Second,

		// WriteTimeout covers the time from the end of the request header read to
		// the end of the response write. 60 s allows for slow Excel generation.
		WriteTimeout: 60 * time.Second,

		// IdleTimeout limits how long keep-alive connections may sit idle
		// between requests before the server closes them.
		IdleTimeout: 120 * time.Second,
	}

	log.Println("Digital Aptitude Evaluation System running on port", port)
	log.Fatal(srv.ListenAndServe())
}
