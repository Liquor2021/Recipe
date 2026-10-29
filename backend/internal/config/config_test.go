package config

import (
	"reflect"
	"testing"
)

func TestInsecureDefaults(t *testing.T) {
	all := Config{AppPassword: DefaultPassword, AdminPassword: DefaultPassword, JWTSecret: DefaultJWTSecret}
	if got := all.InsecureDefaults(); !reflect.DeepEqual(got, []string{"APP_PASSWORD", "ADMIN_PASSWORD", "JWT_SECRET"}) {
		t.Fatalf("全是默认值时应列出三项, got %v", got)
	}
	partial := Config{AppPassword: "family-2026", AdminPassword: DefaultPassword, JWTSecret: "a-long-random-secret"}
	if got := partial.InsecureDefaults(); !reflect.DeepEqual(got, []string{"ADMIN_PASSWORD"}) {
		t.Fatalf("只列出还没改的, got %v", got)
	}
	safe := Config{AppPassword: "a", AdminPassword: "b", JWTSecret: "c"}
	if got := safe.InsecureDefaults(); len(got) != 0 {
		t.Fatalf("都改过时应为空, got %v", got)
	}
}
