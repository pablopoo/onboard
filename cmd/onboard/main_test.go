package main

import "testing"

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
