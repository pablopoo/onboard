package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	"onboard/internal/server"
)

func main() {
	addr := os.Getenv("ONBOARD_ADDR")
	if addr == "" {
		addr = ":0"
	}

	handler := server.New(server.Config{Mode: "local", Addr: addr})
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}

	baseURL := localhostURL(listener.Addr().String())
	fmt.Printf("Local:  %s/\n", baseURL)
	fmt.Printf("Board:  %s/board\n", baseURL)
	fmt.Printf("Viewer: %s/viewer\n", baseURL)

	httpServer := &http.Server{Handler: handler}
	if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}

func localhostURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://localhost" + addr
	}
	if isWildcardHost(host) {
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func isWildcardHost(host string) bool {
	return host == "" || host == "0.0.0.0" || host == "::" || host == "[::]"
}
