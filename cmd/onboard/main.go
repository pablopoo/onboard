package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"

	"onboard/internal/server"
)

const (
	defaultListenAddr            = ":8080"
	fallbackListenAddr           = ":0"
	maxPreferredLANAddresses     = 2
	maxVirtualBridgeLANAddresses = 1
)

func main() {
	addr, allowFallback := configuredListenAddr(os.Getenv("ONBOARD_ADDR"))
	listener, err := listenForServing(addr, allowFallback, net.Listen, os.Stdout)
	if err != nil {
		log.Fatal(err)
	}

	baseURL := localhostURL(listener.Addr().String())
	baseURLs := localBaseURLs(listener.Addr().String())
	handler := server.New(server.Config{
		Mode:     "local",
		Addr:     listener.Addr().String(),
		BaseURLs: baseURLs,
	})
	writeStartupURLs(os.Stdout, baseURL, baseURLs)

	httpServer := &http.Server{Handler: handler}
	if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}

func configuredListenAddr(value string) (string, bool) {
	addr := strings.TrimSpace(value)
	if addr == "" {
		return defaultListenAddr, true
	}
	return addr, false
}

func listenForServing(
	addr string,
	allowFallback bool,
	listen func(network string, address string) (net.Listener, error),
	warnings io.Writer,
) (net.Listener, error) {
	listener, err := listen("tcp", addr)
	if err == nil {
		return listener, nil
	}

	if !allowFallback {
		return nil, fmt.Errorf("listen %s: %w", addr, err)
	}

	fallback, fallbackErr := listen("tcp", fallbackListenAddr)
	if fallbackErr != nil {
		return nil, fmt.Errorf(
			"listen %s: %w; fallback listen %s: %w",
			addr,
			err,
			fallbackListenAddr,
			fallbackErr,
		)
	}

	if warnings != nil {
		fmt.Fprintln(warnings, "Port 8080 is unavailable; using a random port instead.")
		fmt.Fprintln(warnings)
	}
	return fallback, nil
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

func localBaseURLs(addr string) []string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return []string{localhostURL(addr)}
	}

	baseURLs := []string{localhostURL(addr)}
	if !isWildcardHost(host) {
		return baseURLs
	}

	for _, ip := range lanIPv4Addresses() {
		baseURL := "http://" + net.JoinHostPort(ip, port)
		if !containsString(baseURLs, baseURL) {
			baseURLs = append(baseURLs, baseURL)
		}
	}
	return baseURLs
}

func writeStartupURLs(w io.Writer, localBaseURL string, baseURLs []string) {
	fmt.Fprintf(w, "Local:  %s/\n", trimTrailingSlash(localBaseURL))
	fmt.Fprintf(w, "Board:  %s\n", urlPath(localBaseURL, "/board"))
	fmt.Fprintf(w, "Viewer: %s\n", urlPath(localBaseURL, "/viewer"))

	headingPrinted := false
	for _, baseURL := range baseURLs {
		if trimTrailingSlash(baseURL) == trimTrailingSlash(localBaseURL) {
			continue
		}

		if !headingPrinted {
			fmt.Fprintln(w)
			fmt.Fprintln(w, "Open from another device on the same Wi-Fi/LAN:")
			headingPrinted = true
		}

		fmt.Fprintf(w, "LAN Board:  %s\n", urlPath(baseURL, "/board"))
		fmt.Fprintf(w, "LAN Viewer: %s\n", urlPath(baseURL, "/viewer"))
	}
}

func urlPath(baseURL string, path string) string {
	return trimTrailingSlash(baseURL) + path
}

func trimTrailingSlash(value string) string {
	return strings.TrimRight(value, "/")
}

func lanIPv4Addresses() []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	var candidates []lanIPv4Candidate
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ip := interfaceIP(addr)
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ipv4 := ip.To4()
			if ipv4 == nil || ipv4.IsUnspecified() {
				continue
			}
			candidates = append(candidates, lanIPv4Candidate{
				interfaceName: iface.Name,
				address:       ipv4.String(),
			})
		}
	}
	return selectLANIPv4Addresses(candidates)
}

func interfaceIP(addr net.Addr) net.IP {
	switch typed := addr.(type) {
	case *net.IPNet:
		return typed.IP
	case *net.IPAddr:
		return typed.IP
	default:
		return nil
	}
}

type lanIPv4Candidate struct {
	interfaceName string
	address       string
}

func selectLANIPv4Addresses(candidates []lanIPv4Candidate) []string {
	preferred := make([]string, 0, len(candidates))
	virtualBridges := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))

	for _, candidate := range candidates {
		ip := net.ParseIP(strings.TrimSpace(candidate.address)).To4()
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}

		address := ip.String()
		if _, ok := seen[address]; ok {
			continue
		}
		seen[address] = struct{}{}

		if isLikelyVirtualBridgeInterface(candidate.interfaceName) {
			virtualBridges = append(virtualBridges, address)
			continue
		}
		preferred = append(preferred, address)
	}

	if len(preferred) > 0 {
		return limitStrings(preferred, maxPreferredLANAddresses)
	}
	return limitStrings(virtualBridges, maxVirtualBridgeLANAddresses)
}

func isLikelyVirtualBridgeInterface(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return name == "docker0" ||
		strings.HasPrefix(name, "br-") ||
		strings.HasPrefix(name, "veth") ||
		strings.HasPrefix(name, "virbr") ||
		strings.HasPrefix(name, "vmnet") ||
		strings.HasPrefix(name, "vboxnet") ||
		strings.HasPrefix(name, "podman") ||
		strings.HasPrefix(name, "cni")
}

func limitStrings(values []string, limit int) []string {
	if limit <= 0 || len(values) <= limit {
		return values
	}
	return values[:limit]
}

func isWildcardHost(host string) bool {
	return host == "" || host == "0.0.0.0" || host == "::" || host == "[::]"
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
