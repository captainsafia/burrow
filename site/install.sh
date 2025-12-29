#!/bin/sh
# Burrow CLI installer
# Usage: curl -fsSL https://safia.rocks/burrow/install.sh | sh
# Usage with version: curl -fsSL https://safia.rocks/burrow/install.sh | sh -s -- v1.0.0
# Usage with PR: curl -fsSL https://safia.rocks/burrow/install.sh | sh -s -- --pr 42
# Usage with preview: curl -fsSL https://safia.rocks/burrow/install.sh | sh -s -- --preview

set -e

# ============================================================================
# Configuration
# ============================================================================
REPO="captainsafia/burrow"
TOOL_NAME="Burrow"
INSTALL_DIR="${BURROW_INSTALL_DIR:-$HOME/.burrow/bin}"
BINARY_NAME="burrow"

# ============================================================================
# Variables
# ============================================================================
REQUESTED_VERSION=""
PR_NUMBER=""
PREVIEW_MODE=""
VERBOSE=""

# ============================================================================
# Logging
# ============================================================================
log() {
    if [ -n "$VERBOSE" ]; then
        echo "$@"
    fi
}

# ============================================================================
# Help
# ============================================================================
print_help() {
    cat <<EOF
Burrow CLI installer

USAGE:
    curl -fsSL https://safia.rocks/burrow/install.sh | sh [-- OPTIONS]

OPTIONS:
    --pr <number>    Install from PR artifacts (requires gh CLI)
    --preview        Install latest preview/pre-release version
    --verbose, -v    Show verbose output
    --help, -h       Show this help message
    <version>        Install specific version (e.g., v1.0.0)

ENVIRONMENT:
    BURROW_INSTALL_DIR    Custom install directory (default: ~/.burrow/bin)

EXAMPLES:
    # Install latest stable
    curl -fsSL https://safia.rocks/burrow/install.sh | sh

    # Install specific version
    curl -fsSL https://safia.rocks/burrow/install.sh | sh -s -- v1.2.3

    # Install from PR
    curl -fsSL https://safia.rocks/burrow/install.sh | sh -s -- --pr 42

    # Install latest preview
    curl -fsSL https://safia.rocks/burrow/install.sh | sh -s -- --preview
EOF
}

# ============================================================================
# Argument Parsing
# ============================================================================
while [ $# -gt 0 ]; do
    case "$1" in
        --pr)
            PR_NUMBER="$2"
            shift 2
            ;;
        --preview)
            PREVIEW_MODE="1"
            shift
            ;;
        --verbose|-v)
            VERBOSE="1"
            shift
            ;;
        --help|-h)
            print_help
            exit 0
            ;;
        -*)
            echo "Error: Unknown option: $1"
            echo "Run with --help for usage information"
            exit 1
            ;;
        *)
            REQUESTED_VERSION="$1"
            shift
            ;;
    esac
done

# ============================================================================
# Platform Detection
# ============================================================================
detect_os() {
    case "$(uname -s)" in
        Linux*)                     echo "linux" ;;
        Darwin*)                    echo "darwin" ;;
        MINGW*|MSYS*|CYGWIN*)       echo "windows" ;;
        *)                          echo "unknown" ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)   echo "x64" ;;
        arm64|aarch64)  echo "arm64" ;;
        armv7l)         echo "arm" ;;
        i386|i686)      echo "x86" ;;
        *)              echo "unknown" ;;
    esac
}

# ============================================================================
# Shell Detection
# ============================================================================
detect_shell() {
    if [ -n "$SHELL" ]; then
        case "$SHELL" in
            */bash)  echo "bash" ;;
            */zsh)   echo "zsh" ;;
            */fish)  echo "fish" ;;
            */ksh)   echo "ksh" ;;
            */tcsh)  echo "tcsh" ;;
            */csh)   echo "csh" ;;
            *)       basename "$SHELL" ;;
        esac
    elif command -v ps >/dev/null 2>&1; then
        # Fallback: detect from parent process
        ps -p $$ -o comm= 2>/dev/null | sed 's/^-//' || echo "sh"
    else
        echo "sh"
    fi
}

get_shell_config() {
    case "$1" in
        bash)
            if [ -f "$HOME/.bashrc" ]; then
                echo "$HOME/.bashrc"
            elif [ -f "$HOME/.bash_profile" ]; then
                echo "$HOME/.bash_profile"
            else
                echo "$HOME/.profile"
            fi
            ;;
        zsh)    echo "$HOME/.zshrc" ;;
        fish)   echo "$HOME/.config/fish/config.fish" ;;
        ksh)    echo "$HOME/.kshrc" ;;
        tcsh)   echo "$HOME/.tcshrc" ;;
        csh)    echo "$HOME/.cshrc" ;;
        *)      echo "$HOME/.profile" ;;
    esac
}

get_path_export_cmd() {
    SHELL_NAME="$1"
    INSTALL_PATH="$2"
    case "$SHELL_NAME" in
        fish)       echo "set -gx PATH \"${INSTALL_PATH}\" \$PATH" ;;
        csh|tcsh)   echo "setenv PATH \"${INSTALL_PATH}:\$PATH\"" ;;
        *)          echo "export PATH=\"${INSTALL_PATH}:\$PATH\"" ;;
    esac
}

# ============================================================================
# Version Fetching
# ============================================================================
get_latest_version() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null |
        grep '"tag_name":' |
        sed -E 's/.*"([^"]+)".*/\1/'
}

get_latest_preview_version() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases" 2>/dev/null |
        grep -E '"tag_name":|"prerelease":' |
        paste - - |
        grep '"prerelease": true' |
        head -1 |
        sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
}

# ============================================================================
# PATH Instructions
# ============================================================================
get_source_cmd() {
    SHELL_NAME="$1"
    CONFIG_FILE="$2"
    case "$SHELL_NAME" in
        fish)       echo "source ${CONFIG_FILE}" ;;
        csh|tcsh)   echo "source ${CONFIG_FILE}" ;;
        *)          echo ". ${CONFIG_FILE}" ;;
    esac
}

show_path_instructions() {
    CURRENT_SHELL=$(detect_shell)
    SHELL_CONFIG=$(get_shell_config "$CURRENT_SHELL")
    PATH_EXPORT=$(get_path_export_cmd "$CURRENT_SHELL" "$INSTALL_DIR")
    SOURCE_CMD=$(get_source_cmd "$CURRENT_SHELL" "$SHELL_CONFIG")

    case ":$PATH:" in
        *":${INSTALL_DIR}:"*)
            echo "Run 'burrow --help' to get started."
            ;;
        *)
            echo ""
            echo "To add burrow to your PATH:"
            echo ""
            echo "  echo '${PATH_EXPORT}' >> ${SHELL_CONFIG}"
            echo "  ${SOURCE_CMD}"
            ;;
    esac
}

# ============================================================================
# PR Artifact Installation
# ============================================================================
install_from_pr() {
    PR_NUM="$1"
    OS="$2"
    ARCH="$3"

    echo "Fetching PR #${PR_NUM} artifacts..."

    # Artifact name includes PR number for easy lookup
    ARTIFACT_NAME="${BINARY_NAME}-pr-${PR_NUM}-${OS}-${ARCH}"
    BINARY_IN_ARTIFACT="${BINARY_NAME}-${OS}-${ARCH}"

    # Fetch artifacts from GitHub API
    ARTIFACTS_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/actions/artifacts?per_page=100" 2>/dev/null)

    if [ -z "$ARTIFACTS_JSON" ]; then
        echo "Error: Could not fetch artifacts from GitHub"
        exit 1
    fi

    # Find the artifact for this PR and platform
    FOUND_ARTIFACT=$(echo "$ARTIFACTS_JSON" | grep -o "\"${ARTIFACT_NAME}\"" | head -1)

    if [ -z "$FOUND_ARTIFACT" ]; then
        echo "Error: No artifacts found for PR #${PR_NUM} on ${OS}-${ARCH}"
        echo ""
        echo "Make sure the PR has a successful build. You can check at:"
        echo "  https://github.com/${REPO}/pull/${PR_NUM}"
        exit 1
    fi

    log "Found artifact: ${ARTIFACT_NAME}"

    # Check if gh CLI is available
    if ! command -v gh >/dev/null 2>&1; then
        echo "Error: Installing from PR artifacts requires the GitHub CLI (gh)."
        echo ""
        echo "To install burrow from PR #${PR_NUM}:"
        echo "  1. Install gh: https://cli.github.com/"
        echo "  2. Authenticate: gh auth login"
        echo "  3. Re-run this installer:"
        echo "     curl -fsSL https://safia.rocks/burrow/install.sh | sh -s -- --pr ${PR_NUM}"
        exit 1
    fi

    # Check if gh is authenticated
    if ! gh auth status >/dev/null 2>&1; then
        echo "Error: GitHub CLI is not authenticated."
        echo ""
        echo "Run: gh auth login"
        echo "Then re-run this installer."
        exit 1
    fi

    # Create temp directory with cleanup trap
    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TEMP_DIR"' EXIT

    echo "Downloading ${ARTIFACT_NAME}..."

    # Download the artifact using gh CLI
    if ! gh run download --repo "${REPO}" --name "${ARTIFACT_NAME}" --dir "$TEMP_DIR" 2>/dev/null; then
        echo "Error: Failed to download artifact '${ARTIFACT_NAME}'"
        echo "The artifact may have expired (artifacts expire after 30 days)."
        echo ""
        echo "Check the PR for available artifacts:"
        echo "  https://github.com/${REPO}/pull/${PR_NUM}"
        exit 1
    fi

    # Find the binary in the downloaded artifact
    if [ -f "${TEMP_DIR}/${BINARY_NAME}" ]; then
        DOWNLOADED_BINARY="${TEMP_DIR}/${BINARY_NAME}"
    elif [ -f "${TEMP_DIR}/${BINARY_IN_ARTIFACT}" ]; then
        DOWNLOADED_BINARY="${TEMP_DIR}/${BINARY_IN_ARTIFACT}"
    else
        echo "Error: Binary not found in artifact"
        echo "Available files:"
        ls -la "$TEMP_DIR"
        exit 1
    fi

    # Create install directory
    mkdir -p "$INSTALL_DIR"

    # Move binary to install location
    mv "$DOWNLOADED_BINARY" "${INSTALL_DIR}/${BINARY_NAME}"

    # Make executable
    chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

    echo "🐰 Burrow (PR #${PR_NUM}) installed to ${INSTALL_DIR}/${BINARY_NAME}"
    show_path_instructions
}

# ============================================================================
# Main
# ============================================================================
main() {
    OS=$(detect_os)
    ARCH=$(detect_arch)

    if [ "$OS" = "unknown" ]; then
        echo "Error: Unsupported operating system: $(uname -s)"
        exit 1
    fi

    if [ "$ARCH" = "unknown" ]; then
        echo "Error: Unsupported architecture: $(uname -m)"
        exit 1
    fi

    log "Platform: ${OS}-${ARCH}"

    # Construct binary name
    BINARY_FILE="${BINARY_NAME}-${OS}-${ARCH}"

    # Handle PR installation
    if [ -n "$PR_NUMBER" ]; then
        install_from_pr "$PR_NUMBER" "$OS" "$ARCH"
        exit 0
    fi

    echo "Installing Burrow..."

    # Determine version to install
    if [ -n "$REQUESTED_VERSION" ]; then
        # Ensure version starts with 'v'
        case "$REQUESTED_VERSION" in
            v*) VERSION="$REQUESTED_VERSION" ;;
            *)  VERSION="v${REQUESTED_VERSION}" ;;
        esac
        log "Version: ${VERSION}"
    elif [ -n "$PREVIEW_MODE" ]; then
        log "Fetching latest preview release..."
        VERSION=$(get_latest_preview_version)

        if [ -z "$VERSION" ]; then
            echo "Error: No preview releases available"
            exit 1
        fi
        log "Preview: ${VERSION}"
    else
        log "Fetching latest release..."
        VERSION=$(get_latest_version)

        if [ -z "$VERSION" ]; then
            echo "Error: No stable releases available yet."
            echo ""
            echo "To install the latest preview release, run:"
            echo "  curl -fsSL https://safia.rocks/burrow/install.sh | sh -s -- --preview"
            exit 1
        fi
        log "Version: ${VERSION}"
    fi

    # Download URL
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_FILE}"

    # Create install directory
    mkdir -p "$INSTALL_DIR"

    # Create temp file for download (avoids "text file busy" error when updating)
    TEMP_BINARY=$(mktemp)
    trap 'rm -f "$TEMP_BINARY"' EXIT

    # Download binary to temp location first
    log "Downloading ${BINARY_FILE}..."
    log "URL: ${DOWNLOAD_URL}"
    if ! curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_BINARY"; then
        echo "Error: Failed to download ${BINARY_FILE}"
        echo "URL: ${DOWNLOAD_URL}"
        rm -f "$TEMP_BINARY"
        exit 1
    fi

    # Make executable
    chmod +x "$TEMP_BINARY"

    # Move to final location (atomic operation, works even if binary is running)
    mv -f "$TEMP_BINARY" "${INSTALL_DIR}/${BINARY_NAME}"

    if [ -n "$PREVIEW_MODE" ]; then
        echo "🐰 Burrow ${VERSION} (preview) installed to ${INSTALL_DIR}/${BINARY_NAME}"
    else
        echo "🐰 Burrow ${VERSION} installed to ${INSTALL_DIR}/${BINARY_NAME}"
    fi
    show_path_instructions
}

main "$@"
