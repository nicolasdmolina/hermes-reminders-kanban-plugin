// Hermes can't read Reminders (the helper answered access_denied). Pure: no host imports.
//
// The same answer comes back when the permission is off and when the Mac running Hermes is
// locked (build-rules: a denial during a locked session is unavailable, not revoked). The words
// cover both, and name that Mac: the board may be open on another one. The app to allow is the
// helper macOS grants access to (native/reminders-helper/Info.plist), not the plugin.
export const ACCESS = {
  title: "Hermes can't read Reminders",
  body: 'Unlock the Mac running Hermes, or allow RK Reminders Helper in System Settings → Privacy & Security → Reminders.',
  /** Title and body as one sentence pair, for a toast or a one-line reason. */
  full: "Hermes can't read Reminders. Unlock the Mac running Hermes, or allow RK Reminders Helper in System Settings → Privacy & Security → Reminders."
}
