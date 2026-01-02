/**
 * Generates the bash shell hook code for Burrow auto-loading.
 * 
 * The hook tracks loaded keys in _BURROW_LOADED_KEYS environment variable
 * to enable proper unloading when leaving directories.
 */
export function generateBashHook(): string {
  return `# Burrow auto-load hook for bash
_burrow_hook() {
  local prev_exit_status=$?
  eval "$(burrow _hook-exec bash "$PWD" "$_BURROW_LOADED_KEYS")"
  return $prev_exit_status
}

# Override cd to call our hook
cd() {
  builtin cd "$@"
  _burrow_hook
}

# Also override pushd and popd
pushd() {
  builtin pushd "$@"
  _burrow_hook
}

popd() {
  builtin popd "$@"
  _burrow_hook
}

# Run hook on shell initialization
_burrow_hook
`;
}

/**
 * Generates the zsh shell hook code for Burrow auto-loading.
 * 
 * The hook tracks loaded keys in _BURROW_LOADED_KEYS environment variable
 * to enable proper unloading when leaving directories.
 */
export function generateZshHook(): string {
  return `# Burrow auto-load hook for zsh
_burrow_hook() {
  local prev_exit_status=$?
  eval "$(burrow _hook-exec zsh "$PWD" "$_BURROW_LOADED_KEYS")"
  return $prev_exit_status
}

# Use chpwd hook (more idiomatic for zsh)
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _burrow_hook

# Run hook on shell initialization
_burrow_hook
`;
}

/**
 * Generates the fish shell hook code for Burrow auto-loading.
 * 
 * The hook tracks loaded keys in _BURROW_LOADED_KEYS environment variable
 * to enable proper unloading when leaving directories.
 */
export function generateFishHook(): string {
  return `# Burrow auto-load hook for fish
function _burrow_hook --on-variable PWD
  burrow _hook-exec fish "$PWD" "$_BURROW_LOADED_KEYS" | source
end

# Run hook on shell initialization
_burrow_hook
`;
}
