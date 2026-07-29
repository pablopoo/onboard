package main

import (
	"bytes"
	"errors"
	"net"
	"strings"
	"testing"
)

func TestPresenterCapabilityUsesRawBase64URL(t *testing.T) {
	t.Parallel()

	capability, err := presenterCapability(bytes.NewReader(make([]byte, 32)))
	if err != nil {
		t.Fatalf("presenterCapability: %v", err)
	}
	if capability != "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" {
		t.Fatalf("capability = %q, want 43-character raw base64url", capability)
	}
}

func TestLocalhostURLFormatsListenerAddresses(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		addr string
		want string
	}{
		{
			name: "explicit IPv4",
			addr: "192.168.1.42:8080",
			want: "http://192.168.1.42:8080",
		},
		{
			name: "empty wildcard host",
			addr: ":8080",
			want: "http://localhost:8080",
		},
		{
			name: "IPv4 wildcard host",
			addr: "0.0.0.0:8080",
			want: "http://localhost:8080",
		},
		{
			name: "IPv6 wildcard host",
			addr: "[::]:8080",
			want: "http://localhost:8080",
		},
		{
			name: "explicit IPv6",
			addr: "[2001:db8::1]:8080",
			want: "http://[2001:db8::1]:8080",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := localhostURL(tt.addr); got != tt.want {
				t.Fatalf("localhostURL(%q) = %q, want %q", tt.addr, got, tt.want)
			}
		})
	}
}

func TestLocalBaseURLsIncludesLocalhostForWildcardAddress(t *testing.T) {
	t.Parallel()

	got := localBaseURLs("[::]:8080")
	if len(got) == 0 {
		t.Fatal("localBaseURLs returned no URLs")
	}
	if got[0] != "http://localhost:8080" {
		t.Fatalf("first base URL = %q, want localhost URL", got[0])
	}
}

func TestLocalBaseURLsUsesExplicitBoundHostOnly(t *testing.T) {
	t.Parallel()

	got := localBaseURLs("192.168.1.42:8080")
	want := []string{"http://192.168.1.42:8080"}
	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("localBaseURLs = %#v, want %#v", got, want)
	}
}

func TestSelectLANIPv4AddressesPrefersPhysicalInterfacesOverVirtualBridges(t *testing.T) {
	t.Parallel()

	got := selectLANIPv4Addresses([]lanIPv4Candidate{
		{interfaceName: "docker0", address: "172.17.0.1"},
		{interfaceName: "br-8f1d", address: "172.18.0.1"},
		{interfaceName: "wlan0", address: "10.9.7.159"},
		{interfaceName: "enp5s0", address: "192.168.1.20"},
		{interfaceName: "veth1234", address: "172.19.0.1"},
	})
	want := []string{"192.168.1.20", "10.9.7.159"}

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("selected LAN addresses = %#v, want %#v", got, want)
	}
}

func TestSelectLANIPv4AddressesFallsBackToOneVirtualBridgeAddress(t *testing.T) {
	t.Parallel()

	got := selectLANIPv4Addresses([]lanIPv4Candidate{
		{interfaceName: "docker0", address: "172.17.0.1"},
		{interfaceName: "br-8f1d", address: "172.18.0.1"},
	})
	want := []string{"172.18.0.1"}

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("selected LAN addresses = %#v, want %#v", got, want)
	}
}

func TestSelectLANIPv4AddressesRanksPhysicalThenUnknownDeterministically(t *testing.T) {
	t.Parallel()

	candidates := []lanIPv4Candidate{
		{interfaceName: "tailscale0", address: "100.64.0.2"},
		{interfaceName: "mystery0", address: "192.168.50.9"},
		{interfaceName: "eth0", address: "192.168.1.20"},
		{interfaceName: "utun4", address: "10.8.0.4"},
		{interfaceName: "wlan0", address: "10.9.7.159"},
		{interfaceName: "docker0", address: "172.17.0.1"},
		{interfaceName: "wg0", address: "10.7.0.2"},
		{interfaceName: "tun0", address: "10.6.0.2"},
		{interfaceName: "en0", address: "192.168.2.20"},
	}
	want := []string{"192.168.2.20", "192.168.1.20"}

	for _, input := range [][]lanIPv4Candidate{
		candidates,
		{candidates[8], candidates[5], candidates[1], candidates[3], candidates[6], candidates[0], candidates[4], candidates[2], candidates[7]},
	} {
		got := selectLANIPv4Addresses(input)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("selected LAN addresses = %#v, want %#v", got, want)
		}
	}
}

func TestSelectLANIPv4AddressesRanksUnknownAboveTunnelFallback(t *testing.T) {
	t.Parallel()

	got := selectLANIPv4Addresses([]lanIPv4Candidate{
		{interfaceName: "wg0", address: "10.7.0.2"},
		{interfaceName: "mystery0", address: "192.168.50.9"},
		{interfaceName: "tailscale0", address: "100.64.0.2"},
	})
	want := []string{"192.168.50.9"}

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("selected LAN addresses = %#v, want %#v", got, want)
	}
}

func TestSelectLANIPv4AddressesRanksTunnelFallbackDeterministically(t *testing.T) {
	t.Parallel()

	got := selectLANIPv4Addresses([]lanIPv4Candidate{
		{interfaceName: "wg0", address: "10.7.0.2"},
		{interfaceName: "utun4", address: "10.8.0.4"},
		{interfaceName: "tailscale0", address: "100.64.0.2"},
		{interfaceName: "tun0", address: "10.6.0.2"},
		{interfaceName: "docker0", address: "172.17.0.1"},
	})
	want := []string{"100.64.0.2"}

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("selected LAN addresses = %#v, want %#v", got, want)
	}
}

func TestWriteStartupURLsPrintsDirectLANBoardAndViewerLinks(t *testing.T) {
	t.Parallel()

	var output strings.Builder
	writeStartupURLs(&output, "http://localhost:8080", []string{
		"http://localhost:8080",
		"http://192.168.1.20:8080",
	}, "test-presenter-token")

	got := output.String()
	for _, want := range []string{
		"Local:  http://localhost:8080/\n",
		"Board:  http://localhost:8080/board#presenter=test-presenter-token\n",
		"Viewer: http://localhost:8080/viewer\n",
		"Open from another device on the same Wi-Fi/LAN:\n",
		"LAN Board:  http://192.168.1.20:8080/board#presenter=test-presenter-token\n",
		"LAN Viewer: http://192.168.1.20:8080/viewer\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("startup output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "viewer#presenter") || strings.Contains(got, "viewer?presenter") {
		t.Fatalf("startup output leaked presenter token into Viewer URL:\n%s", got)
	}
	if strings.Contains(got, "LAN:    http://192.168.1.20:8080/") {
		t.Fatalf("startup output kept ambiguous LAN home-only URL:\n%s", got)
	}
}

func TestConfiguredListenAddrDefaultsToStableLANPort(t *testing.T) {
	t.Parallel()

	addr, isDefault := configuredListenAddr("")
	if addr != ":8080" || !isDefault {
		t.Fatalf("configuredListenAddr empty = %q, %v; want :8080, true", addr, isDefault)
	}
}

func TestConfiguredListenAddrPreservesExplicitAddress(t *testing.T) {
	t.Parallel()

	addr, isDefault := configuredListenAddr(" 127.0.0.1:0 ")
	if addr != "127.0.0.1:0" || isDefault {
		t.Fatalf("configuredListenAddr explicit = %q, %v; want 127.0.0.1:0, false", addr, isDefault)
	}
}

func TestListenForServingFallsBackWhenDefaultAddressIsUnavailable(t *testing.T) {
	t.Parallel()

	var calls []string
	var warnings strings.Builder
	listener, err := listenForServing(
		":8080",
		true,
		func(network string, addr string) (net.Listener, error) {
			calls = append(calls, network+" "+addr)
			if addr == ":8080" {
				return nil, errors.New("address already in use")
			}
			return fakeListener{addr: "127.0.0.1:48123"}, nil
		},
		&warnings,
	)

	if err != nil {
		t.Fatalf("listenForServing returned error: %v", err)
	}
	if listener.Addr().String() != "127.0.0.1:48123" {
		t.Fatalf("fallback listener addr = %q, want 127.0.0.1:48123", listener.Addr())
	}
	wantCalls := []string{"tcp :8080", "tcp :0"}
	if strings.Join(calls, ",") != strings.Join(wantCalls, ",") {
		t.Fatalf("listen calls = %#v, want %#v", calls, wantCalls)
	}
	if !strings.Contains(warnings.String(), "Port 8080 is unavailable; using a random port instead.") {
		t.Fatalf("warning output missing fallback message:\n%s", warnings.String())
	}
}

func TestListenForServingDoesNotFallbackForExplicitAddress(t *testing.T) {
	t.Parallel()

	var calls []string
	listener, err := listenForServing(
		"127.0.0.1:9090",
		false,
		func(network string, addr string) (net.Listener, error) {
			calls = append(calls, network+" "+addr)
			return nil, errors.New("address already in use")
		},
		nil,
	)

	if err == nil {
		_ = listener.Close()
		t.Fatal("listenForServing returned nil error for explicit unavailable address")
	}
	if len(calls) != 1 || calls[0] != "tcp 127.0.0.1:9090" {
		t.Fatalf("listen calls = %#v, want only explicit address", calls)
	}
}

type fakeListener struct {
	addr string
}

func (f fakeListener) Accept() (net.Conn, error) {
	return nil, errors.New("not implemented")
}

func (f fakeListener) Close() error {
	return nil
}

func (f fakeListener) Addr() net.Addr {
	return fakeAddr(f.addr)
}

type fakeAddr string

func (a fakeAddr) Network() string {
	return "tcp"
}

func (a fakeAddr) String() string {
	return string(a)
}
