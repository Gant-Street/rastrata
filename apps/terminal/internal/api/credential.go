package api

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// The two kinds of Bearer credential a process can present, told apart by their prefix so a mistake
// (an agent token in the owner-key variable, say) is caught here instead of sent to the service.
var (
	tokenPattern    = regexp.MustCompile(`^rst_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$`)
	ownerKeyPattern = regexp.MustCompile(`^rso_[A-Za-z0-9_-]{43}$`)
)

const (
	// TokenVariable names the environment variable that holds an agent token.
	TokenVariable = "RASTRATA_TOKEN"
	// OwnerKeyFileVariable names the environment variable that holds the path of the owner key file.
	OwnerKeyFileVariable = "RASTRATA_OWNER_KEY_FILE"
)

// DefaultOwnerKeyFile, when set, names the owner key file to use when neither RASTRATA_TOKEN nor
// RASTRATA_OWNER_KEY_FILE is set. The installed command line sets it (the key is in the data
// directory the service made it in); a build from the repository leaves it nil, so a development
// service that is open stays open and nothing is read that was not asked for.
var DefaultOwnerKeyFile func(getenv func(string) string) string

// CredentialSource says where CredentialFromEnvironment would take the credential from: "token",
// "owner key" or "none".
func CredentialSource(getenv func(string) string) string {
	switch {
	case strings.TrimSpace(getenv(TokenVariable)) != "":
		return "token"
	case getenv(OwnerKeyFileVariable) != "":
		return "owner key"
	}
	if defaultOwnerKeyPath(getenv) != "" {
		return "owner key"
	}
	return "none"
}

// defaultOwnerKeyPath is the default owner key file when there is one and it exists.
func defaultOwnerKeyPath(getenv func(string) string) string {
	if DefaultOwnerKeyFile == nil {
		return ""
	}
	path := DefaultOwnerKeyFile(getenv)
	if path == "" {
		return ""
	}
	if _, err := os.Stat(path); err != nil {
		return ""
	}
	return path
}

// CredentialFromEnvironment returns the Bearer credential this process presents to the service:
//
//   - the agent token in RASTRATA_TOKEN, if set;
//   - otherwise the owner key in the file named by RASTRATA_OWNER_KEY_FILE, if set;
//   - otherwise, in the installed command line, the owner key in the data directory, if it is there;
//   - otherwise none. A service that is open treats a request with no credential as its owner.
//
// The token wins. An agent that was given a token but inherited the owner's environment still acts
// as the token, not as the owner. The returned error never contains the credential.
func CredentialFromEnvironment(getenv func(string) string) (string, error) {
	if token := strings.TrimSpace(getenv(TokenVariable)); token != "" {
		// An agent token of the installed service, or the key of an agent of a hosted workspace (which is exchanged for a token before it is used, see exchange.go).
		if !tokenPattern.MatchString(token) && !agentKeyPattern.MatchString(token) {
			return "", fmt.Errorf("%s is set but is not an agent token (it looks like rst_ or rsa_ followed by 16 hex characters, an underscore and 43 more characters); create one with rastrata tokens create, or in a hosted workspace's agent settings", TokenVariable)
		}
		return token, nil
	}
	if path := getenv(OwnerKeyFileVariable); path != "" {
		return ReadOwnerKey(path)
	}
	if path := defaultOwnerKeyPath(getenv); path != "" {
		return ReadOwnerKey(path)
	}
	return "", nil
}

// ReadOwnerKey reads the owner key file, refusing one other users can read or that holds anything
// but an owner key.
func ReadOwnerKey(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("%s names a file that cannot be read: %s", OwnerKeyFileVariable, describeFileError(err))
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s must name a regular file", OwnerKeyFileVariable)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("the owner key file %s must be private to you (chmod 600)", path)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("%s names a file that cannot be read: %s", OwnerKeyFileVariable, describeFileError(err))
	}
	key := strings.TrimSpace(string(raw))
	if !ownerKeyPattern.MatchString(key) {
		return "", fmt.Errorf("%s does not contain a Rastrata owner key", path)
	}
	return key, nil
}

func describeFileError(err error) string {
	var pathError *os.PathError
	if errors.As(err, &pathError) {
		return pathError.Err.Error()
	}
	return "unreadable"
}

// LooksLikeToken reports whether text has the shape of an agent token or an owner key. Commands use
// it to refuse a credential pasted where a name belongs, so it never lands in a file or a log.
func LooksLikeToken(text string) bool {
	return strings.Contains(text, "rst_") && len(text) >= 60 || strings.Contains(text, "rso_") && len(text) >= 47
}
