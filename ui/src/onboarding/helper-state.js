export const HELPER_STATES = {
  signing_required: {
    title: 'Set up Reminders access',
    body: 'Set up RK Reminders Helper on the Mac running this profile. This creates a local signing identity. macOS may ask for Keychain and Reminders access.',
    state: 'Setup needed',
    action: 'prepare',
    label: 'Set up Reminders access'
  },
  toolchain_required: {
    title: 'Install Apple tools',
    body: 'RK Reminders Helper needs Apple’s command line tools. Install them in the macOS window, then check again.',
    state: 'Apple tools needed',
    action: 'install_tools',
    label: 'Install Apple tools'
  },
  setup_failed: {
    title: 'Reminders setup did not finish',
    body: 'Try setting up RK Reminders Helper again on the Mac running this profile.',
    state: 'Setup needed',
    action: 'prepare',
    label: 'Set up Reminders access'
  },
  session_locked: {
    title: 'Unlock your Mac',
    body: 'Unlock the Mac running this Hermes profile, then check again.',
    state: 'Mac locked'
  },
  unsupported_platform: {
    title: 'Reminders needs a Mac',
    body: 'Connect to a Hermes profile running on macOS to read Apple Reminders.',
    state: 'macOS required'
  },
  ready: {
    title: 'Connect to Reminders',
    body: 'RK Reminders Helper is ready. Check again to read your lists.',
    state: 'Ready'
  }
}
