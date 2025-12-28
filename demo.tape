# Burrow CLI Demo
# Generate with: vhs demo.tape

Output demo.gif

# Terminal settings
Set Shell fish
Set FontSize 18
Set Width 1000
Set Height 600
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set Padding 20
Set TypingSpeed 50ms

# Hide setup
Hide
Type "export BURROW_CONFIG_DIR=/tmp/burrow-demo-$$"
Enter
Type "rm -rf $BURROW_CONFIG_DIR"
Enter
Type "mkdir -p $BURROW_CONFIG_DIR"
Enter
Type "cd /tmp && mkdir -p myproject/src && cd myproject"
Enter
Type "clear"
Enter
Show

Sleep 500ms

# Set some secrets
Type "burrow set API_KEY=sk-live-abc123xyz"
Enter
Sleep 1s

Type "burrow set DATABASE_URL=postgres://localhost/myapp"
Enter
Sleep 1s

# Show listing secrets
Type "burrow list"
Enter
Sleep 1.5s

# Demonstrate the --redact feature
Type "burrow get API_KEY --redact"
Enter
Sleep 1.5s

# Demonstrate export with shell auto-detection
Type "burrow export"
Enter
Sleep 1.5s

# Demonstrate inheritance in subdirectory
Type "cd src"
Enter
Sleep 500ms

Type "burrow set API_KEY=sk-test-dev-key"
Enter
Sleep 1s

Type "burrow list"
Enter
Sleep 2s

# Cleanup
Hide
Type "cd /tmp && rm -rf myproject $BURROW_CONFIG_DIR"
Enter
Show
