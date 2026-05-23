package main

import (
	"log"
	"net/http"
	"os"

	"github.com/gorilla/mux"

	"digital-aptitude-evaluation-system/config"
	"digital-aptitude-evaluation-system/routes"
)

func main() {
	config.ConnectDB()

	r := mux.NewRouter()
	routes.RegisterRoutes(r)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Println("Digital Aptitude Evaluation System running on port", port)
	log.Fatal(http.ListenAndServe("0.0.0.0:"+port, r))
}
