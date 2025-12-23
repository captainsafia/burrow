#!/bin/sh
set -e

# burrow installer
# Usage: curl -fsSL https://burrow.dev/install.sh | sh

REPO="captainsafia/burrow"
INSTALL_DIR="/usr/local/bin"

# Detect OS and architecture
detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  case "$ARCH" in
    x86_64|amd64)
      ARCH="x64"
      ;;
    aarch64|arm64)
      ARCH="arm64"
      ;;
    *)
      echo "Error: Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac

  case "$OS" in
    linux)
      PLATFORM="linux-${ARCH}"
      ;;
    darwin)
      PLATFORM="darwin-${ARCH}"
      ;;
    *)
      echo "Error: Unsupported operating system: $OS"
      echo "For Windows, download from: https://github.com/${REPO}/releases"
      exit 1
      ;;
  esac

  echo "$PLATFORM"
}

# Get latest release version
get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | \
    grep '"tag_name":' | \
    sed -E 's/.*"([^"]+)".*/\1/'
}

main() {
  echo "Installing burrow..."
  echo ""

  PLATFORM=$(detect_platform)
  echo "Detected platform: $PLATFORM"

  VERSION=$(get_latest_version)
  if [ -z "$VERSION" ]; then
    echo "Error: Could not determine latest version"
    exit 1
  fi
  echo "Latest version: $VERSION"

  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/burrow-${PLATFORM}"
  echo "Downloading from: $DOWNLOAD_URL"
  echo ""

  TMP_FILE=$(mktemp)
  curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"

  chmod +x "$TMP_FILE"

  # Check if we can write to install dir
  if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP_FILE" "${INSTALL_DIR}/burrow"
  else
    echo "Installing to ${INSTALL_DIR} requires sudo..."
    sudo mv "$TMP_FILE" "${INSTALL_DIR}/burrow"
  fi

  echo ""
  echo "burrow installed successfully!"
  echo ""
  echo "Get started:"
  echo "  burrow set API_KEY=your-secret"
  echo "  burrow get API_KEY --show"
  echo "  eval \"\$(burrow export)\""
  echo ""
  echo "For more info: burrow --help"
}

main
